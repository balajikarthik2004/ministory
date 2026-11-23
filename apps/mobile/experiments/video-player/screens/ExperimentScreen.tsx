import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '@minidrama/ui-tokens';
import { EpisodeFeed } from '../components/EpisodeFeed';
import { buildPlaylist, DEFAULT_BASE_URL, loadEpisodes } from '../fixtures';
import { MetricsCollector } from '../metrics/collector';
import { useVideoStrategy } from '../players/useVideoStrategy';
import { EXPERIMENTS, type ExperimentId, type RunSummary, type TestEpisode } from '../types';

/**
 * Runs one experiment and reports what it measured.
 *
 * Three run modes:
 *   manual  - swipe by hand. For black frames, audio overlap, subjective feel.
 *   swipe30 - 30 programmatic swipes at a fixed interval. Removes human
 *             variance so A, B and C are compared on the same input.
 *   soak    - 10 minutes of continuous playback for the memory curve.
 */

type RunMode = 'manual' | 'swipe30' | 'soak';
type RunState = 'idle' | 'loading' | 'running' | 'finished' | 'error';

/** Fast enough to stress the pool, slow enough that a healthy player can keep
 *  up. Tuned to be deliberately hostile without being meaningless. */
const AUTO_SWIPE_INTERVAL_MS = 900;
const AUTO_SWIPE_COUNT = 30;
const SOAK_DURATION_MS = 10 * 60 * 1000;

export function ExperimentScreen({ experimentId }: { experimentId: ExperimentId }): JSX.Element {
  const insets = useSafeAreaInsets();
  const info = EXPERIMENTS.find((entry) => entry.id === experimentId);

  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [mode, setMode] = useState<RunMode>('manual');
  const [state, setState] = useState<RunState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<TestEpisode[]>([]);
  const [collector, setCollector] = useState<MetricsCollector | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [liveIndex, setLiveIndex] = useState(0);
  // Mirrored into state because the HUD renders it, and refs must not be read
  // during render.
  const [swipesDone, setSwipesDone] = useState(0);

  const listRef = useRef<FlatList<TestEpisode> | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const soakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeCountRef = useRef(0);

  const strategy = useVideoStrategy(experimentId, episodes, collector);

  const clearTimers = useCallback(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    if (soakTimerRef.current) {
      clearTimeout(soakTimerRef.current);
      soakTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const handleIndexChange = useCallback(
    (index: number) => {
      setLiveIndex(index);
      const episode = episodes[index];
      // The clock that matters to a viewer: page settled -> frames moving.
      if (collector && episode) collector.transitionStarted(episode.id);
      strategy.onIndexChange(index);
    },
    [collector, episodes, strategy],
  );

  const finish = useCallback(() => {
    clearTimers();

    // Tear the players down BEFORE summarising, so playersReleased reflects
    // actual cleanup. Taking the summary first always reported `created / 0`
    // and said nothing about whether resources were freed.
    strategy.releaseAll();

    setCollector((current) => {
      if (current) {
        const result = current.summary();
        setSummary(result);
        // Printed so results can be copied from the Metro terminal without
        // adding a clipboard dependency.
        console.warn(`[spike:${experimentId}] ${current.export()}`);
      }
      return null;
    });
    setState('finished');
  }, [clearTimers, experimentId, strategy]);

  const start = useCallback(async () => {
    setState('loading');
    setError(null);
    setSummary(null);
    swipeCountRef.current = 0;
    setSwipesDone(0);

    try {
      const loaded = await loadEpisodes(baseUrl);
      const playlist = buildPlaylist(
        loaded,
        mode === 'manual' ? loaded.length : AUTO_SWIPE_COUNT + 2,
      );
      setEpisodes(playlist);
      setLiveIndex(0);
      setCollector(new MetricsCollector(experimentId));
      setState('running');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setState('error');
    }
  }, [baseUrl, experimentId, mode]);

  // Drives the automated modes once a run is live.
  useEffect(() => {
    if (state !== 'running' || !collector || episodes.length === 0) return;

    if (mode === 'swipe30') {
      autoTimerRef.current = setInterval(() => {
        swipeCountRef.current += 1;
        const done = swipeCountRef.current;
        setSwipesDone(done);
        if (done > AUTO_SWIPE_COUNT) {
          finish();
          return;
        }
        const target = Math.min(done, episodes.length - 1);
        listRef.current?.scrollToIndex({ index: target, animated: true });
      }, AUTO_SWIPE_INTERVAL_MS);
    }

    if (mode === 'soak') {
      soakTimerRef.current = setTimeout(finish, SOAK_DURATION_MS);
    }

    return clearTimers;
  }, [clearTimers, collector, episodes.length, finish, mode, state]);

  // Recomputed every render on purpose: the collector mutates in place, so
  // memoising on its identity would freeze the HUD at the run's first values.
  // summary() is pure, so this is safe.
  const liveCounts = collector?.summary() ?? null;

  if (state === 'running' && episodes.length > 0) {
    return (
      <View style={styles.fill}>
        <EpisodeFeed
          episodes={episodes}
          playerForIndex={strategy.playerForIndex}
          onIndexChange={handleIndexChange}
          onFirstFrame={strategy.reportFirstFrame}
          listRef={listRef}
        />

        <View style={[styles.hud, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
          <Text style={styles.hudTitle}>{info?.title ?? experimentId}</Text>
          <Text style={styles.hudLine}>
            index {liveIndex} · players {strategy.activePlayerCount} · mode {mode}
          </Text>
          {liveCounts ? (
            <Text style={styles.hudLine}>
              ttff p50 {liveCounts.timeToFirstFrameMs.p50Ms ?? '-'}ms · errors{' '}
              {liveCounts.playbackErrors} · overlap {liveCounts.audioOverlapIncidents} · stalls{' '}
              {liveCounts.stalls}
            </Text>
          ) : null}
          {mode === 'swipe30' ? (
            <Text style={styles.hudLine}>
              auto swipe {Math.min(swipesDone, AUTO_SWIPE_COUNT)}/{AUTO_SWIPE_COUNT}
            </Text>
          ) : null}

          <Pressable style={styles.stopButton} onPress={finish}>
            <Text style={styles.stopButtonText}>Stop and report</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.setup, { paddingTop: insets.top + spacing.xl }]}
    >
      <Text style={styles.eyebrow}>M1.2 SPIKE · EXPERIMENTAL</Text>
      <Text style={styles.title}>{info?.title ?? experimentId}</Text>
      <Text style={styles.body}>{info?.summary}</Text>

      <Text style={styles.label}>Fixture server base URL</Text>
      <TextInput
        style={styles.input}
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://192.168.x.x:8787"
        placeholderTextColor={colors.text.tertiary}
      />
      <Text style={styles.hint}>serve.mjs prints this when it starts.</Text>

      <Text style={styles.label}>Run mode</Text>
      <View style={styles.modeRow}>
        {(
          [
            { id: 'manual', label: 'Manual' },
            { id: 'swipe30', label: '30 swipes' },
            { id: 'soak', label: '10 min soak' },
          ] as const
        ).map((option) => (
          <Pressable
            key={option.id}
            style={[styles.chip, mode === option.id && styles.chipActive]}
            onPress={() => setMode(option.id)}
          >
            <Text style={[styles.chipText, mode === option.id && styles.chipTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {state === 'loading' ? (
        <ActivityIndicator color={colors.accent.primary} style={styles.spinner} />
      ) : (
        <Pressable style={styles.primaryButton} onPress={start}>
          <Text style={styles.primaryButtonText}>Start run</Text>
        </Pressable>
      )}

      {state === 'error' && error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Could not start</Text>
          <Text style={styles.errorBody}>{error}</Text>
        </View>
      ) : null}

      {summary ? <SummaryTable summary={summary} /> : null}
    </ScrollView>
  );
}

function SummaryTable({ summary }: { summary: RunSummary }): JSX.Element {
  const rows: Array<[string, string]> = [
    ['Duration', `${Math.round(summary.durationMs / 1000)}s`],
    ['Episodes started', String(summary.episodesStarted)],
    ['Transitions', String(summary.transitions)],
    [
      'TTFF p50 / p75',
      `${summary.timeToFirstFrameMs.p50Ms ?? '-'} / ${summary.timeToFirstFrameMs.p75Ms ?? '-'} ms`,
    ],
    [
      'TTFF min / max',
      `${summary.timeToFirstFrameMs.minMs ?? '-'} / ${summary.timeToFirstFrameMs.maxMs ?? '-'} ms`,
    ],
    [
      'Transition p50 / p75',
      `${summary.transitionLatencyMs.p50Ms ?? '-'} / ${summary.transitionLatencyMs.p75Ms ?? '-'} ms`,
    ],
    ['Playback errors', String(summary.playbackErrors)],
    ['Audio overlap incidents', String(summary.audioOverlapIncidents)],
    ['Stalls', String(summary.stalls)],
    ['Players created / released', `${summary.playersCreated} / ${summary.playersReleased}`],
  ];

  const leaked = summary.playersCreated - summary.playersReleased;

  return (
    <View style={styles.summary}>
      <Text style={styles.summaryTitle}>Results</Text>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{label}</Text>
          <Text style={styles.summaryValue}>{value}</Text>
        </View>
      ))}
      <Text style={[styles.hint, leaked > 0 && styles.warn]}>
        {leaked > 0
          ? `${leaked} player(s) still allocated - expected while the feed is mounted, must reach 0 after leaving the screen.`
          : 'All players released.'}
      </Text>
      <Text style={styles.hint}>
        Full event log printed to the Metro terminal. Memory, dropped frames and crashes come from
        adb - see docs/VIDEO_PLAYER_SPIKE.md.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg.primary },
  setup: { padding: spacing.lg, paddingBottom: spacing['3xl'], gap: spacing.xs },
  eyebrow: { ...typography.micro, color: colors.status.warning, letterSpacing: 1.5 },
  title: { ...typography.h1, color: colors.text.primary, marginTop: spacing.xs },
  body: { ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg },
  label: { ...typography.caption, color: colors.text.secondary, marginTop: spacing.lg },
  input: {
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.bg.card,
    borderRadius: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginTop: spacing.xs,
  },
  hint: { ...typography.caption, color: colors.text.tertiary, marginTop: spacing.xs },
  warn: { color: colors.status.warning },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.bg.card,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: colors.accent.subtle },
  chipText: { ...typography.caption, color: colors.text.secondary },
  chipTextActive: { color: colors.accent.primary },
  primaryButton: {
    backgroundColor: colors.accent.primary,
    borderRadius: spacing.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.xl,
    minHeight: 44,
  },
  primaryButtonText: { ...typography.bodyStrong, color: colors.text.onAccent },
  spinner: { marginTop: spacing.xl },
  errorBox: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: spacing.md,
    backgroundColor: colors.bg.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.status.error,
  },
  errorTitle: { ...typography.bodyStrong, color: colors.status.error },
  errorBody: { ...typography.caption, color: colors.text.secondary, marginTop: spacing.xs },
  summary: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: spacing.md,
    backgroundColor: colors.bg.card,
  },
  summaryTitle: { ...typography.h3, color: colors.text.primary, marginBottom: spacing.sm },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
  summaryLabel: { ...typography.caption, color: colors.text.secondary, flexShrink: 1 },
  summaryValue: { ...typography.caption, color: colors.text.primary },
  hud: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.overlay.scrim,
    borderRadius: spacing.md,
    padding: spacing.md,
    gap: 2,
  },
  hudTitle: { ...typography.caption, color: colors.accent.primary },
  hudLine: { ...typography.micro, color: colors.text.secondary },
  stopButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.bg.elevated,
    borderRadius: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  stopButtonText: { ...typography.caption, color: colors.text.primary },
});
