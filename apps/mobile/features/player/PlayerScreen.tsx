import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { VideoView } from 'expo-video';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DramaDetail, EpisodeSummary, UnlockOption } from '@minidrama/contracts';
import { colors, spacing } from '@minidrama/ui-tokens';
import { screen } from '../../constants/layout';
import { AppText } from '../../components/primitives/AppText';
import { ErrorState } from '../../components/feedback/ErrorState';
import {
  useDrama,
  useEpisodes,
  useRefreshProgressViews,
  useToggleFavorite,
} from '../../services/catalogue.queries';
// The adapter, not the mock directly. Importing `mock-api` here meant the
// player asked the in-memory dataset for a ticket while the rest of the app
// ran against the server — and the mock's episode ids ('drama_mazhai_ep02')
// do not match the database's ('drama_mazhai_s1_e02'), so every lookup
// returned NOT_FOUND and no episode would play in live mode.
import { api } from '../../services/api';
import { queryKeys } from '../../services/query-client';
import { toAppError } from '../../services/errors';
import { librarySnapshot, useLibraryStore } from '../../store/library.store';
import { usePreferencesStore } from '../../store/preferences.store';
import { usePlaybackRecorder } from '../../services/playback/use-playback-recorder';
import { classifyPlaybackError } from '../../services/playback/events';
import { refreshSyncCounts } from '../../store/sync.store';
import { LockedEpisodePanel } from './LockedEpisodePanel';
import { PlayerOverlay } from './PlayerOverlay';
import { useSinglePlayerController } from './useSinglePlayerController';
import type { PlaybackLifecycleEvent } from './types';

/**
 * The vertical episode feed — the product's most important screen.
 *
 * ARCHITECTURE
 * ------------
 * A paged vertical `FlatList` over the drama's episodes with exactly one
 * `VideoView` mounted: the page that is currently settled. Strategy A from
 * docs/VIDEO_PLAYER_SPIKE.md §10 — the player's source is replaced on each
 * swipe rather than a pool of decoders being kept warm. The spike measured
 * three players as *worse*, not better, on a constrained link.
 *
 * ACCESS CONTROL
 * --------------
 * The feed never reads `episode.isLocked` to decide whether to play. It asks
 * for a playback ticket and plays whatever it is given; a locked episode comes
 * back as an `EPISODE_LOCKED` refusal, and the unlock panel is rendered from
 * that refusal. CLAUDE.md §11: the client does not get to decide entitlement.
 * Writing it this way now means M4 swaps the implementation behind
 * `requestPlaybackTicket` for a real signed-token call and nothing here moves.
 *
 * The screen is split in two on purpose. `PlayerScreen` resolves the catalogue
 * queries and owns the gate states; `PlayerFeed` only ever runs with episodes
 * in hand, which lets it seed its starting index with a lazy `useState`
 * initialiser instead of correcting itself in an effect after the first paint.
 */

const SEEK_STEP_SECONDS = 10;
/** Controls fade out after this long without a tap (UI_UX_GUIDELINES.md §3). */
const CONTROLS_TIMEOUT_MS = 3200;
/** FlatList requires a stable viewability config object. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 65 } as const;

/** Whether the player's snapshot describes the episode now on screen. */
function snapshotHoldsEpisode(snapshotEpisodeId: string | null, episodeId: string): boolean {
  return snapshotEpisodeId === episodeId;
}

export interface PlayerScreenProps {
  dramaSlug: string;
  /** Episode to open on. Falls back to the first episode. */
  startEpisodeNumber: number | null;
}

export function PlayerScreen({ dramaSlug, startEpisodeNumber }: PlayerScreenProps): JSX.Element {
  const router = useRouter();
  const dramaQuery = useDrama(dramaSlug);
  const episodesQuery = useEpisodes(dramaQuery.data?.id);

  if (dramaQuery.isPending || episodesQuery.isPending) {
    return (
      <View style={styles.gate}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  if (dramaQuery.isError || !dramaQuery.data || episodesQuery.isError) {
    return (
      <View style={styles.gate}>
        <ErrorState
          message={toAppError(dramaQuery.error ?? episodesQuery.error).message}
          onRetry={() => {
            void dramaQuery.refetch();
            void episodesQuery.refetch();
          }}
          retrying={dramaQuery.isFetching || episodesQuery.isFetching}
        />
      </View>
    );
  }

  const episodes = episodesQuery.data ?? [];

  if (episodes.length === 0) {
    return (
      <View style={styles.gate}>
        <ErrorState
          title="No episodes yet"
          message="This drama has no published episodes. Check back soon."
          onRetry={() => router.back()}
        />
      </View>
    );
  }

  return (
    <PlayerFeed
      drama={dramaQuery.data}
      episodes={episodes}
      startEpisodeNumber={startEpisodeNumber}
    />
  );
}

interface PlayerFeedProps {
  drama: DramaDetail;
  episodes: readonly EpisodeSummary[];
  startEpisodeNumber: number | null;
}

function PlayerFeed({ drama, episodes, startEpisodeNumber }: PlayerFeedProps): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const recordProgress = useLibraryStore((state) => state.recordProgress);
  const favoriteIds = useLibraryStore((state) => state.favoriteIds);
  const toggleFavorite = useToggleFavorite();
  const refreshProgressViews = useRefreshProgressViews();

  const muted = usePreferencesStore((state) => state.muted);
  const setMutedPreference = usePreferencesStore((state) => state.setMuted);
  const autoplayNext = usePreferencesStore((state) => state.autoplayNext);

  const [listRef, setListRef] = useState<FlatList<EpisodeSummary> | null>(null);

  /**
   * The height of one page, measured rather than assumed.
   *
   * `Dimensions.get('window')` is not the list's viewport. With
   * `edgeToEdgeEnabled` (app.json) the window extends behind the system bars,
   * and what `Dimensions` reports does not necessarily match the height
   * `FlatList` lays out at. `pagingEnabled` snaps to multiples of the
   * scroll view's own frame, so when the item height disagrees with that
   * frame the two drift apart — by one bar's worth per page, compounding.
   *
   * On a device that showed as: the first episode filled the screen
   * correctly, and after one swipe the video occupied the top three quarters
   * with dead space beneath it. Measuring the container removes the
   * assumption entirely.
   *
   * Seeded from `Dimensions` so the first frame is close, then corrected by
   * `onLayout` on the same commit.
   */
  const [pageHeight, setPageHeight] = useState(screen.height);

  // Seeded once from the route parameter. Episodes are guaranteed present, so
  // this needs no effect to correct it afterwards.
  const [activeIndex, setActiveIndex] = useState(() => {
    if (startEpisodeNumber === null) return 0;
    const index = episodes.findIndex((episode) => episode.episodeNumber === startEpisodeNumber);
    return index >= 0 ? index : 0;
  });

  /**
   * Mirrors of `activeIndex` and `pageHeight`, plus a re-anchor flag.
   *
   * Declared here, above every consumer, because `handleViewportLayout` must
   * be able to detect a height change and raise the flag *synchronously* —
   * the native viewability callback arrives ~16ms after the layout and some
   * 65ms before React commits, so a flag raised post-commit is already too
   * late. See the re-anchor effect below for why that matters.
   */
  const activeIndexRef = useRef(0);
  const pageHeightRef = useRef(screen.height);
  const reanchoringRef = useRef(false);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const activeEpisode = episodes[activeIndex] ?? episodes[0];

  // ── Playback ticket ────────────────────────────────────────────────────
  // A query, not an effect: loading, error, retry and cache-by-episode all
  // come for free, and an episode swiped past while its request was in flight
  // cannot deliver a stale ticket to the player.
  const ticketQuery = useQuery({
    queryKey: queryKeys.playbackTicket(activeEpisode?.id ?? ''),
    queryFn: () => api.requestPlaybackTicket(activeEpisode?.id ?? '', librarySnapshot()),
    enabled: Boolean(activeEpisode),
    // A ticket carries an expiry. Re-requesting on a back-swipe to an episode
    // watched minutes ago is correct behaviour, not waste.
    staleTime: 60_000,
    retry: false,
  });

  const ticketError = ticketQuery.error ? toAppError(ticketQuery.error) : null;
  const lockedInfo = ticketError?.code === 'EPISODE_LOCKED' ? activeEpisode : null;

  // ── Telemetry and durable progress (M2.2) ──────────────────────────────
  const recorder = usePlaybackRecorder();

  /** The last position seen, so teardown can report where the viewer left. */
  const lastSeenRef = useRef<{
    episodeId: string;
    episodeNumber: number;
    positionSec: number;
    durationSec: number | null;
  } | null>(null);
  /** Set when the episode completes, so teardown does not call it abandoned. */
  const completedRef = useRef<string | null>(null);

  // ── Progress persistence ───────────────────────────────────────────────
  const handleProgress = useCallback(
    (episodeId: string, positionSec: number, durationSec: number) => {
      const episode = episodes.find((item) => item.id === episodeId);
      if (!episode) return;

      // In-memory, for an instant UI.
      recordProgress({
        dramaId: episode.dramaId,
        episodeId,
        episodeNumber: episode.episodeNumber,
        positionSec,
        durationSec,
      });

      // Durable, throttled independently.
      recorder.persistProgress({
        dramaId: episode.dramaId,
        episodeId,
        episodeNumber: episode.episodeNumber,
        positionSec,
        durationSec,
      });

      // Heartbeat, throttled to 15s by the recorder.
      recorder.recordProgressTick({
        dramaId: episode.dramaId,
        episodeId,
        episodeNumber: episode.episodeNumber,
        positionSec,
        durationSec,
      });

      lastSeenRef.current = {
        episodeId,
        episodeNumber: episode.episodeNumber,
        positionSec,
        durationSec,
      };
    },
    [episodes, recordProgress, recorder],
  );

  const handleLifecycle = useCallback(
    (lifecycle: PlaybackLifecycleEvent) => {
      const episode = episodes.find((item) => item.id === lifecycle.episodeId);
      if (!episode) return;

      const base = {
        dramaId: episode.dramaId,
        episodeId: lifecycle.episodeId,
        positionSec: lifecycle.positionSec,
        durationSec: lifecycle.durationSec,
      };

      switch (lifecycle.kind) {
        case 'started':
          recorder.record({ type: 'playback_started', ...base });
          break;
        case 'paused':
          recorder.record({ type: 'playback_paused', ...base });
          // A pause is a natural flush point: the viewer has stopped, and
          // this may be the last thing that happens before the app is killed.
          if (lifecycle.durationSec) {
            recorder.persistProgress({
              ...base,
              episodeNumber: episode.episodeNumber,
              durationSec: lifecycle.durationSec,
              immediate: true,
            });
          }
          break;
        case 'resumed':
          recorder.record({ type: 'playback_resumed', ...base });
          break;
        case 'failed':
          recorder.record({
            type: 'playback_failed',
            ...base,
            errorCode: classifyPlaybackError(lifecycle.rawMessage),
          });
          break;
      }
    },
    [episodes, recorder],
  );

  const advanceToNext = useCallback(() => {
    const nextIndex = activeIndex + 1;
    if (nextIndex >= episodes.length) return;
    listRef?.scrollToIndex({ index: nextIndex, animated: true });
  }, [activeIndex, episodes.length, listRef]);

  const handleEnded = useCallback(
    (episodeId: string) => {
      /*
       * One completion per episode per visit to this screen.
       *
       * The controller's own `endedReportedRef` guards a single load, but it
       * resets whenever a ticket is applied — so a retry after a failed
       * next-episode ticket reloads the finished episode and could report it
       * complete a second time, double-counting it in the drop-off curve and
       * advancing the feed twice. Returning early is deliberate: if we have
       * already acted on this ending, there is nothing left to do for it.
       */
      if (completedRef.current === episodeId) return;

      const episode = episodes.find((item) => item.id === episodeId);
      if (episode) {
        completedRef.current = episodeId;
        recorder.record({
          type: 'playback_completed',
          dramaId: episode.dramaId,
          episodeId,
          positionSec: episode.durationSec,
          durationSec: episode.durationSec,
        });
        recorder.persistProgress({
          dramaId: episode.dramaId,
          episodeId,
          episodeNumber: episode.episodeNumber,
          positionSec: episode.durationSec,
          durationSec: episode.durationSec,
          immediate: true,
        });
      }

      // PLY-05: auto-advance is a preference, not a given. A viewer who turned
      // it off gets the finished frame and the swipe hint, not a surprise.
      if (autoplayNext) advanceToNext();
    },
    [advanceToNext, autoplayNext, episodes, recorder],
  );

  const callbacks = useMemo(
    () => ({
      onProgress: handleProgress,
      onEnded: handleEnded,
      onLifecycle: handleLifecycle,
    }),
    [handleEnded, handleLifecycle, handleProgress],
  );

  const controller = useSinglePlayerController(callbacks, muted);
  const { load, releaseSource, setMuted: setPlayerMuted, snapshot } = controller;

  /**
   * What the overlay renders.
   *
   * Between a swipe settling and the new ticket arriving, the controller still
   * holds the previous episode — so the overlay would pair the new episode's
   * title with the old episode's clock. On a device that showed as
   * "Episode 3 · 0:45 / 0:45" with a full progress bar, which reads as a
   * finished episode rather than one about to start.
   *
   * Falling back to the episode's own declared duration keeps the two halves
   * of the overlay describing the same episode at all times.
   */
  const displaySnapshot =
    activeEpisode && snapshotHoldsEpisode(snapshot.episodeId, activeEpisode.id)
      ? snapshot
      : {
          ...snapshot,
          phase: 'loading' as const,
          episodeId: activeEpisode?.id ?? null,
          positionSec: 0,
          durationSec: activeEpisode?.durationSec ?? 0,
        };

  // Hand each new ticket to the player. The controller ignores a ticket for
  // the episode it already holds, so a re-render cannot restart playback.
  const ticket = ticketQuery.data;
  useEffect(() => {
    if (ticket) {
      load(ticket);
      return;
    }

    /*
     * No ticket for the episode now on screen — release the decoder.
     *
     * M2.4 Issue B: this used to release only for `lockedInfo`, so a ticket
     * that failed for any other reason (offline, 404, timeout) left the
     * *previous* episode's player loaded and playing. It kept firing
     * `timeUpdate`, which kept the recorder emitting `playback_progress`
     * heartbeats at a position that could no longer change — ten such
     * events at a frozen position were recorded during M2.3's offline test.
     *
     * Releasing on any error stops the heartbeats at their source rather
     * than filtering them downstream, and frees the decoder while the
     * viewer looks at the retry state. The completed episode's progress has
     * already been flushed by `handleEnded` with `immediate: true`, so
     * nothing is lost by letting the player go.
     */
    if (ticketError) releaseSource();
  }, [load, releaseSource, ticket, ticketError]);

  /**
   * `episode_changed`, for every move between episodes.
   *
   * Skips the first render: arriving at the screen is `playback_started`, not
   * a change. Fires for a swipe, an auto-advance and a jump from the episode
   * list alike, because from an analytics point of view they are the same
   * transition and the drop-off curve should not care how it happened.
   */
  const previousEpisodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeEpisode) return;
    const previous = previousEpisodeIdRef.current;
    previousEpisodeIdRef.current = activeEpisode.id;
    if (previous === null || previous === activeEpisode.id) return;

    recorder.record({
      type: 'episode_changed',
      dramaId: activeEpisode.dramaId,
      episodeId: activeEpisode.id,
      positionSec: 0,
      durationSec: activeEpisode.durationSec,
    });
  }, [activeEpisode, recorder]);

  // Keep the player's mute in step with the stored preference.
  useEffect(() => {
    setPlayerMuted(muted);
  }, [muted, setPlayerMuted]);

  /**
   * Teardown: release the decoder, record the ending, flush the position.
   *
   * `playback_abandoned` is what makes drop-off measurable — without it, a
   * viewer who closes the player at 40% is indistinguishable in the data from
   * one who is still watching. It is deliberately not emitted when the
   * episode completed: that already has its own event, and reporting both
   * would double-count the session's ending.
   *
   * The final `persistProgress` is `immediate`, bypassing the throttle. This
   * is the last chance to record where the viewer actually stopped.
   */
  useEffect(() => {
    return () => {
      const last = lastSeenRef.current;
      if (last && completedRef.current !== last.episodeId) {
        const episode = episodes.find((item) => item.id === last.episodeId);
        if (episode) {
          recorder.record({
            type: 'playback_abandoned',
            dramaId: episode.dramaId,
            episodeId: last.episodeId,
            positionSec: last.positionSec,
            durationSec: last.durationSec,
          });
          if (last.durationSec) {
            recorder.persistProgress({
              dramaId: episode.dramaId,
              episodeId: last.episodeId,
              episodeNumber: last.episodeNumber,
              positionSec: last.positionSec,
              durationSec: last.durationSec,
              immediate: true,
            });
          }
        }
      }

      releaseSource();
      refreshProgressViews();
      void refreshSyncCounts();
    };
  }, [episodes, recorder, refreshProgressViews, releaseSource]);

  // ── Controls auto-hide ─────────────────────────────────────────────────
  useEffect(() => {
    if (!controlsVisible) return;
    const hide = (): void => setControlsVisible(false);
    const timer = setTimeout(hide, CONTROLS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [controlsVisible]);

  useEffect(() => {
    if (!notice) return;
    const clear = (): void => setNotice(null);
    const timer = setTimeout(clear, 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── Feed paging ────────────────────────────────────────────────────────
  // FlatList treats its viewability callback as immutable and warns when the
  // identity changes, so this must stay stable for the list's whole life.
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ index?: number | undefined }> }) => {
      // A re-anchor after a viewport change is not the viewer moving.
      if (reanchoringRef.current) return;
      const first = viewableItems[0];
      if (first?.index === undefined || first.index === null) return;
      const next = first.index;
      setActiveIndex((current) => (current === next ? current : next));
      setControlsVisible(true);
    },
    [],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: EpisodeSummary; index: number }) => {
      const isActive = index === activeIndex;
      const toggleControls = (): void => setControlsVisible((visible) => !visible);
      return (
        <Pressable
          style={[styles.page, { height: pageHeight }]}
          onPress={toggleControls}
          accessibilityRole="button"
          accessibilityLabel={`Episode ${item.episodeNumber} player`}
          accessibilityHint="Tap to show or hide playback controls"
        >
          {isActive && controller.player ? (
            <VideoView
              style={[styles.video, { height: pageHeight }]}
              player={controller.player}
              // 9:16 source in a 9:16 frame: `cover` fills the screen without
              // letterboxing, which is the point of a vertical feed.
              contentFit="cover"
              nativeControls={false}
              allowsPictureInPicture={false}
              onFirstFrameRender={controller.reportFirstFrame}
            />
          ) : (
            // Inactive pages render a plain surface rather than a second
            // video. One decoder, by design.
            <View style={[styles.video, styles.inactivePage, { height: pageHeight }]}>
              <AppText variant="caption" tone="tertiary">
                {`Episode ${item.episodeNumber}`}
              </AppText>
            </View>
          )}
        </Pressable>
      );
    },
    [activeIndex, controller.player, controller.reportFirstFrame, pageHeight],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<EpisodeSummary> | null | undefined, index: number) => ({
      length: pageHeight,
      offset: pageHeight * index,
      index,
    }),
    [pageHeight],
  );

  /**
   * Re-anchor the feed when the viewport height changes.
   *
   * `getItemLayout` places page N at `pageHeight * N`. When `pageHeight`
   * moves — split screen, a fold, rotation, or a development overlay resizing
   * the app — every page's offset moves with it but the scroll position does
   * not, so the settled offset silently comes to describe a *different*
   * index. FlatList reports that index as viewable and the feed changes
   * episode on its own, with no swipe and no auto-advance.
   *
   * Measured on device: halving the viewport (986 -> 493dp) while parked on
   * episode 2 moved the feed to episode 3 and emitted a spurious
   * `episode_changed`; restoring it moved the feed back and emitted another.
   * A viewport that oscillates emits them continuously — one session recorded
   * 250 `episode_changed` events in 51 seconds, which is the M2.2 rule
   * against excessive event generation broken by a layout change.
   *
   * Re-anchoring keeps the offset describing the same episode across the
   * change. `activeIndex` is read through a ref so this runs only when the
   * height actually moves, never on an ordinary swipe.
   */
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    if (measured <= 0 || measured === pageHeightRef.current) return;
    // Both refs are set here, synchronously, before the native viewability
    // callback can read the remapped offset as a deliberate episode change.
    pageHeightRef.current = measured;
    reanchoringRef.current = true;
    setPageHeight(measured);
  }, []);

  useEffect(() => {
    if (!listRef) return;
    listRef.scrollToOffset({ offset: activeIndexRef.current * pageHeight, animated: false });
    const settle = setTimeout(() => {
      reanchoringRef.current = false;
    }, 250);
    return () => clearTimeout(settle);
  }, [listRef, pageHeight]);

  if (!activeEpisode) {
    return (
      <View style={styles.gate}>
        <ErrorState title="No episodes yet" message="This drama has no published episodes." />
      </View>
    );
  }

  const isFavorited = favoriteIds.includes(drama.id);

  return (
    <View style={styles.container}>
      <View style={styles.listViewport} onLayout={handleViewportLayout}>
        <FlatList
          ref={setListRef}
          data={episodes as EpisodeSummary[]}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          initialScrollIndex={activeIndex}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          decelerationRate="fast"
          // Only the settled page and its immediate neighbours stay mounted.
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          removeClippedSubviews
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={VIEWABILITY_CONFIG}
        />
      </View>

      {lockedInfo ? (
        <LockedEpisodePanel
          episode={lockedInfo}
          insetTop={insets.top}
          insetBottom={insets.bottom}
          onClose={() => router.back()}
          onUnavailable={(option: UnlockOption) =>
            setNotice(
              option === 'SUBSCRIPTION'
                ? 'Subscriptions arrive with the monetisation milestone.'
                : option === 'COIN'
                  ? 'The coin wallet arrives with the monetisation milestone.'
                  : 'Rewarded ads arrive with the monetisation milestone.',
            )
          }
        />
      ) : ticketError ? (
        <View style={styles.gate}>
          <ErrorState
            message={ticketError.message}
            onRetry={() => void ticketQuery.refetch()}
            retrying={ticketQuery.isFetching}
          />
        </View>
      ) : (
        <PlayerOverlay
          drama={drama}
          episode={activeEpisode}
          snapshot={displaySnapshot}
          visible={controlsVisible}
          isFavorited={isFavorited}
          hasNext={activeIndex < episodes.length - 1}
          hasPrevious={activeIndex > 0}
          insets={{ top: insets.top, bottom: insets.bottom }}
          onClose={() => router.back()}
          onTogglePlay={() => {
            controller.togglePlay();
            setControlsVisible(true);
          }}
          onToggleMute={() => setMutedPreference(!muted)}
          onToggleFavorite={() => toggleFavorite(drama.id)}
          onOpenEpisodes={() => router.push(`/drama/${drama.slug}`)}
          onRetry={controller.retry}
          onSeekBack={() => {
            controller.seekTo(snapshot.positionSec - SEEK_STEP_SECONDS);
            setControlsVisible(true);
          }}
          onSeekForward={() => {
            controller.seekTo(snapshot.positionSec + SEEK_STEP_SECONDS);
            setControlsVisible(true);
          }}
        />
      )}

      {notice ? (
        <View
          style={[styles.notice, { bottom: insets.bottom + spacing['3xl'] }]}
          pointerEvents="none"
        >
          <AppText variant="caption">{notice}</AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  gate: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listViewport: {
    flex: 1,
  },
  page: {
    width: screen.width,
    backgroundColor: colors.bg.primary,
  },
  video: {
    width: screen.width,
  },
  inactivePage: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg.secondary,
  },
  notice: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: colors.bg.elevated,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
});
