import type { JSX } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { DramaDetail, EpisodeSummary } from '@minidrama/contracts';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { absoluteFill, formatDuration } from '../../constants/layout';
import { AppText } from '../../components/primitives/AppText';
import { Badge } from '../../components/primitives/Badge';
import { Gradient } from '../../components/primitives/Gradient';
import { IconButton } from '../../components/primitives/IconButton';
import { ProgressBar } from '../../components/primitives/ProgressBar';
import type { PlaybackSnapshot } from './types';

/**
 * The chrome that sits over the video.
 *
 * Laid out as three bands — top (close, title), right rail (actions), bottom
 * (metadata, progress) — so nothing competes for the centre of the frame,
 * where the picture is.
 *
 * Pure presentation: it renders a `PlaybackSnapshot` and emits intents. It
 * owns no player state, which is what lets the player strategy change without
 * touching any of this.
 */

export interface PlayerOverlayProps {
  drama: DramaDetail;
  episode: EpisodeSummary;
  snapshot: PlaybackSnapshot;
  visible: boolean;
  isFavorited: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  insets: { top: number; bottom: number };
  onClose: () => void;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onToggleFavorite: () => void;
  onOpenEpisodes: () => void;
  onRetry: () => void;
  onSeekBack: () => void;
  onSeekForward: () => void;
}

export function PlayerOverlay({
  drama,
  episode,
  snapshot,
  visible,
  isFavorited,
  hasNext,
  hasPrevious,
  insets,
  onClose,
  onTogglePlay,
  onToggleMute,
  onToggleFavorite,
  onOpenEpisodes,
  onRetry,
  onSeekBack,
  onSeekForward,
}: PlayerOverlayProps): JSX.Element {
  const isBusy = snapshot.phase === 'loading' || snapshot.phase === 'buffering';
  const isError = snapshot.phase === 'error';
  const progress = snapshot.durationSec > 0 ? snapshot.positionSec / snapshot.durationSec : 0;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* The loading indicator is never hidden with the controls — a viewer
          who taps to hide the chrome still needs to know the video is
          buffering rather than broken. */}
      {isBusy ? (
        <View style={styles.centre} pointerEvents="none">
          <ActivityIndicator size="large" color={colors.accent.primary} />
        </View>
      ) : null}

      {isError ? (
        <View style={styles.errorPanel}>
          <Ionicons name="alert-circle-outline" size={32} color={colors.status.error} />
          <AppText variant="h3" style={styles.centred}>
            Playback stopped
          </AppText>
          <AppText variant="body" tone="secondary" style={styles.centred}>
            {snapshot.errorMessage}
          </AppText>
          <IconButton
            name="refresh"
            size={24}
            surface="accent"
            color={colors.text.onAccent}
            onPress={onRetry}
            accessibilityLabel="Retry playback"
          />
        </View>
      ) : null}

      {visible ? (
        <>
          <Gradient direction="up" intensity={0.82} steps={6} style={styles.topScrim} />
          <Gradient direction="down" intensity={0.92} steps={8} style={styles.bottomScrim} />

          {/* ── Top band ───────────────────────────────────────────── */}
          <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
            <IconButton
              name="chevron-down"
              onPress={onClose}
              surface="glass"
              accessibilityLabel="Close player"
              accessibilityHint="Returns to the previous screen"
            />
            <View style={styles.topTitles}>
              <AppText variant="bodyStrong" numberOfLines={1}>
                {drama.title}
              </AppText>
              <AppText variant="micro" tone="secondary" numberOfLines={1}>
                {`Season ${drama.seasonNumber} · Episode ${episode.episodeNumber}`}
              </AppText>
            </View>
            <IconButton
              name={snapshot.muted ? 'volume-mute' : 'volume-high'}
              onPress={onToggleMute}
              surface="glass"
              selected={snapshot.muted}
              accessibilityLabel={snapshot.muted ? 'Unmute' : 'Mute'}
            />
          </View>

          {/* ── Centre transport ───────────────────────────────────── */}
          {!isError ? (
            <View style={styles.transport} pointerEvents="box-none">
              <IconButton
                name="play-back"
                size={24}
                surface="glass"
                onPress={onSeekBack}
                accessibilityLabel="Back 10 seconds"
              />
              <IconButton
                name={snapshot.phase === 'playing' ? 'pause' : 'play'}
                size={34}
                surface="glass"
                onPress={onTogglePlay}
                accessibilityLabel={snapshot.phase === 'playing' ? 'Pause' : 'Play'}
                style={styles.playButton}
              />
              <IconButton
                name="play-forward"
                size={24}
                surface="glass"
                onPress={onSeekForward}
                accessibilityLabel="Forward 10 seconds"
              />
            </View>
          ) : null}

          {/* ── Right rail ─────────────────────────────────────────── */}
          <View style={[styles.rail, { bottom: insets.bottom + 150 }]}>
            <IconButton
              name={isFavorited ? 'heart' : 'heart-outline'}
              size={26}
              surface="glass"
              color={isFavorited ? colors.accent.primary : colors.text.primary}
              onPress={onToggleFavorite}
              selected={isFavorited}
              accessibilityLabel={isFavorited ? 'Remove from My List' : 'Save to My List'}
            />
            <IconButton
              name="list"
              size={24}
              surface="glass"
              onPress={onOpenEpisodes}
              accessibilityLabel="All episodes"
              accessibilityHint="Opens the episode list for this drama"
            />
          </View>

          {/* ── Bottom band ────────────────────────────────────────── */}
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.badges}>
              <Badge
                label={episode.accessType === 'FREE' ? 'FREE' : 'PREMIUM'}
                tone={episode.accessType === 'FREE' ? 'free' : 'locked'}
              />
              <Badge label={drama.language.name} tone="live" />
              <Badge label={drama.contentRating.replace('_', '+')} tone="neutral" />
            </View>

            <AppText variant="h3" numberOfLines={1}>
              {`${episode.episodeNumber}. ${episode.title}`}
            </AppText>

            <View style={styles.timeRow}>
              <AppText variant="micro" tone="secondary">
                {formatDuration(snapshot.positionSec)}
              </AppText>
              <ProgressBar
                value={progress}
                height={3}
                style={styles.scrub}
                accessibilityLabel={`${Math.round(progress * 100)} percent of episode ${episode.episodeNumber}`}
              />
              <AppText variant="micro" tone="secondary">
                {formatDuration(snapshot.durationSec)}
              </AppText>
            </View>

            {/* Swipe affordance. A vertical feed is not discoverable on its
                own, and a first-time viewer who does not know they can swipe
                watches one episode and leaves. */}
            <View style={styles.swipeHint}>
              {hasPrevious ? (
                <View style={styles.hintChip}>
                  <Ionicons name="chevron-up" size={12} color={colors.text.tertiary} />
                  <AppText variant="micro" tone="tertiary">
                    Previous
                  </AppText>
                </View>
              ) : null}
              {hasNext ? (
                <View style={styles.hintChip}>
                  <AppText variant="micro" tone="tertiary">
                    Swipe for episode {episode.episodeNumber + 1}
                  </AppText>
                  <Ionicons name="chevron-down" size={12} color={colors.text.tertiary} />
                </View>
              ) : null}
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centre: {
    ...absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centred: {
    textAlign: 'center',
  },
  errorPanel: {
    ...absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.overlay.scrim,
  },
  topScrim: {
    bottom: undefined,
    height: 180,
  },
  bottomScrim: {
    top: undefined,
    height: 300,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  topTitles: {
    flex: 1,
    gap: 1,
  },
  transport: {
    ...absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
  },
  playButton: {
    width: 76,
    height: 76,
    borderRadius: radius.full,
  },
  rail: {
    position: 'absolute',
    right: spacing.sm,
    gap: spacing.sm,
    alignItems: 'center',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  badges: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  scrub: {
    flex: 1,
  },
  swipeHint: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 18,
  },
  hintChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
