import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoPlayer } from 'expo-video';
import type { MetricsCollector } from '../metrics/collector';
import type { ExperimentId, TestEpisode } from '../types';
import { createInstrumentedPlayer, type InstrumentedPlayer } from './instrumented-player';

/**
 * The three strategies under test, behind one interface so the feed UI is
 * identical across experiments and only the player management differs.
 *
 * Deliberately NOT written to make C look good. The brief says not to assume
 * three players win, and the honest expectation is:
 *   A - cheapest memory, worst transition (full load on every swipe)
 *   B - one extra decoder buys an instant forward swipe; back swipe reloads
 *   C - both directions instant; three decoders is a real cost on 4GB devices
 */

export interface VideoStrategy {
  /** The player that should be rendered for a given feed index, if any. */
  playerForIndex: (index: number) => VideoPlayer | null;
  /** Called when the feed settles on a new index. */
  onIndexChange: (index: number) => void;
  /** Wired to VideoView's onFirstFrameRender for the page at this index. */
  reportFirstFrame: (index: number) => void;
  /**
   * Releases every allocated player immediately.
   *
   * Exists so a run can tear down its players BEFORE the metrics summary is
   * taken. Previously the summary ran while the hook was still mounted, so it
   * always reported `created / 0` and the lifecycle figure was meaningless.
   * This does not change any strategy's allocation logic - only when the
   * teardown that was always going to happen is allowed to happen.
   */
  releaseAll: () => void;
  /** Live count of allocated players, shown in the overlay. */
  activePlayerCount: number;
}

export function useVideoStrategy(
  experimentId: ExperimentId,
  episodes: readonly TestEpisode[],
  collector: MetricsCollector | null,
): VideoStrategy {
  /** key -> instrumented player */
  const poolRef = useRef<Map<string, InstrumentedPlayer>>(new Map());
  /** feed index -> player key, for whichever indices are currently held */
  const assignmentRef = useRef<Map<number, string>>(new Map());
  const currentIndexRef = useRef(0);
  const [activePlayerCount, setActivePlayerCount] = useState(0);

  const syncCount = useCallback(() => {
    setActivePlayerCount(poolRef.current.size);
  }, []);

  const acquire = useCallback(
    (key: string): InstrumentedPlayer | null => {
      if (!collector) return null;
      const existing = poolRef.current.get(key);
      if (existing) return existing;
      const created = createInstrumentedPlayer(key, collector);
      poolRef.current.set(key, created);
      return created;
    },
    [collector],
  );

  const releaseKey = useCallback((key: string) => {
    const player = poolRef.current.get(key);
    if (!player) return;
    player.release();
    poolRef.current.delete(key);
  }, []);

  /** Release everything. Called when a run ends, on unmount, and on switch. */
  const releaseAll = useCallback(() => {
    for (const key of [...poolRef.current.keys()]) releaseKey(key);
    assignmentRef.current.clear();
    setActivePlayerCount(0);
  }, [releaseKey]);

  const applyStrategy = useCallback(
    (index: number) => {
      if (!collector || episodes.length === 0) return;

      const episodeAt = (i: number): TestEpisode | null =>
        i >= 0 && i < episodes.length ? (episodes[i] ?? null) : null;

      const assignment = assignmentRef.current;

      if (experimentId === 'A-single') {
        // One instance, reloaded every time. The baseline cost.
        const player = acquire('solo');
        const episode = episodeAt(index);
        if (!player || !episode) return;
        if (player.currentEpisodeId !== episode.id) player.load(episode, true);
        else player.play();
        assignment.clear();
        assignment.set(index, 'solo');
        syncCount();
        return;
      }

      if (experimentId === 'B-dual') {
        // Two instances alternating by index parity, so the player already
        // holding index+1 becomes the current one without a reload.
        const currentKey = index % 2 === 0 ? 'even' : 'odd';
        const nextKey = currentKey === 'even' ? 'odd' : 'even';

        const current = acquire(currentKey);
        const next = acquire(nextKey);
        const currentEpisode = episodeAt(index);
        const nextEpisode = episodeAt(index + 1);
        if (!current || !currentEpisode) return;

        // Pause the other instance BEFORE starting this one, or both produce
        // audio for a moment - the overlap defect this spike exists to catch.
        next?.pause();

        if (current.currentEpisodeId !== currentEpisode.id) current.load(currentEpisode, true);
        else current.play();

        // Preload the next episode paused, so the following swipe is instant.
        if (next && nextEpisode && next.currentEpisodeId !== nextEpisode.id) {
          next.load(nextEpisode, false);
        }

        assignment.clear();
        assignment.set(index, currentKey);
        if (nextEpisode) assignment.set(index + 1, nextKey);
        syncCount();
        return;
      }

      // C - three-player pool, rotating by index modulo 3 so prev/current/next
      // each keep their decoder across a one-step move in either direction.
      const keyFor = (i: number): string => `pool-${((i % 3) + 3) % 3}`;

      const currentKey = keyFor(index);
      const neighbours: Array<{ offset: number; key: string }> = [
        { offset: -1, key: keyFor(index - 1) },
        { offset: 1, key: keyFor(index + 1) },
      ];

      const current = acquire(currentKey);
      const currentEpisode = episodeAt(index);
      if (!current || !currentEpisode) return;

      // Pause neighbours first - same overlap concern as experiment B, worse
      // here because there are two of them.
      for (const { key } of neighbours) poolRef.current.get(key)?.pause();

      if (current.currentEpisodeId !== currentEpisode.id) current.load(currentEpisode, true);
      else current.play();

      assignment.clear();
      assignment.set(index, currentKey);

      for (const { offset, key } of neighbours) {
        const episode = episodeAt(index + offset);
        if (!episode) continue;
        const player = acquire(key);
        if (!player) continue;
        if (player.currentEpisodeId !== episode.id) player.load(episode, false);
        assignment.set(index + offset, key);
      }

      // Anything outside the window is no longer useful. Releasing here is
      // what keeps the pool at three instead of growing to the playlist size.
      for (const key of [...poolRef.current.keys()]) {
        const stillUsed = [...assignment.values()].includes(key);
        if (!stillUsed) releaseKey(key);
      }

      syncCount();
    },
    [acquire, collector, episodes, experimentId, releaseKey, syncCount],
  );

  const onIndexChange = useCallback(
    (index: number) => {
      currentIndexRef.current = index;
      applyStrategy(index);
    },
    [applyStrategy],
  );

  const playerForIndex = useCallback((index: number): VideoPlayer | null => {
    const key = assignmentRef.current.get(index);
    if (!key) return null;
    return poolRef.current.get(key)?.player ?? null;
  }, []);

  const reportFirstFrame = useCallback((index: number) => {
    const key = assignmentRef.current.get(index);
    if (!key) return;
    poolRef.current.get(key)?.reportFirstFrame();
  }, []);

  // Start at index 0 once a collector exists (i.e. once the run begins).
  useEffect(() => {
    if (collector && episodes.length > 0) applyStrategy(currentIndexRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collector, episodes]);

  // Release on unmount and whenever the experiment changes. Without this the
  // previous experiment's decoders survive into the next run and every
  // measurement after the first is garbage.
  useEffect(() => {
    return () => {
      releaseAll();
      setActivePlayerCount(0);
    };
  }, [experimentId, releaseAll]);

  return { playerForIndex, onIndexChange, reportFirstFrame, releaseAll, activePlayerCount };
}
