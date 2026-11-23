import type { JSX } from 'react';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { EpisodeSummary } from '@minidrama/contracts';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { episodeThumb, formatDuration } from '../../constants/layout';
import { AppText } from '../primitives/AppText';
import { Badge } from '../primitives/Badge';
import { ProgressBar } from '../primitives/ProgressBar';
import { PressableScale } from '../primitives/PressableScale';
import { Artwork } from './Artwork';

/**
 * One row in the episode list.
 *
 * Three states have to be distinguishable at a glance (M2.1 brief): watched,
 * unwatched, and free-vs-locked.
 *
 *   watched    – a completed check and dimmed title
 *   in progress– a progress bar under the thumbnail
 *   free       – a green FREE badge
 *   locked     – a lock badge on the accent surface, and the row stays
 *                tappable. UI_UX_GUIDELINES.md §3: "a lock is an invitation,
 *                a disabled control is a dead end". Tapping a locked episode
 *                still asks for a playback ticket, is refused, and the refusal
 *                is what surfaces the unlock options — the same flow M4 will
 *                run against a real entitlement check.
 */

export interface EpisodeListItemProps {
  episode: EpisodeSummary;
  onPress: (episode: EpisodeSummary) => void;
  /** Highlighted as the episode the player would resume into. */
  isResumePoint?: boolean;
}

function EpisodeListItemComponent({
  episode,
  onPress,
  isResumePoint = false,
}: EpisodeListItemProps): JSX.Element {
  const watched = episode.watchState;
  const isCompleted = watched?.isCompleted ?? false;
  const progress =
    watched && episode.durationSec > 0 && !isCompleted
      ? watched.positionSec / episode.durationSec
      : 0;

  const accessibilityParts = [
    `Episode ${episode.episodeNumber}`,
    formatDuration(episode.durationSec),
    episode.isLocked ? 'Locked' : 'Free to watch',
    isCompleted ? 'Watched' : progress > 0 ? `${Math.round(progress * 100)} percent watched` : '',
  ].filter(Boolean);

  return (
    <PressableScale
      onPress={() => onPress(episode)}
      activeScale={0.98}
      accessibilityRole="button"
      accessibilityLabel={accessibilityParts.join(', ')}
      accessibilityHint={
        episode.isLocked ? 'Shows how to unlock this episode' : 'Starts playing this episode'
      }
      style={isResumePoint ? [styles.row, styles.resumeRow] : [styles.row]}
    >
      <View style={styles.thumbFrame}>
        <Artwork
          url={episode.thumbnailUrl}
          style={styles.thumb}
          borderRadius={radius.md}
          accessibilityLabel={`Episode ${episode.episodeNumber} thumbnail`}
        />

        <View style={styles.thumbOverlay}>
          <Ionicons
            name={episode.isLocked ? 'lock-closed' : isCompleted ? 'checkmark-circle' : 'play'}
            size={16}
            color={
              episode.isLocked
                ? colors.accent.primary
                : isCompleted
                  ? colors.status.success
                  : colors.text.primary
            }
          />
        </View>

        {progress > 0 ? (
          <View style={styles.thumbProgress}>
            <ProgressBar value={progress} height={2} />
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <AppText
            variant="bodyStrong"
            tone={isCompleted ? 'secondary' : 'primary'}
            numberOfLines={1}
            style={styles.flexText}
          >
            {`${episode.episodeNumber}. ${episode.title}`}
          </AppText>
          {isResumePoint ? <Badge label="Resume" tone="accent" /> : null}
        </View>

        <View style={styles.metaRow}>
          <AppText variant="caption" tone="secondary">
            {formatDuration(episode.durationSec)}
          </AppText>
          {episode.isLocked ? (
            <Badge label={`${episode.coinPrice} coins`} tone="locked" icon="lock-closed" />
          ) : (
            <Badge label="FREE" tone="free" />
          )}
          {isCompleted ? (
            <AppText variant="caption" tone="secondary">
              Watched
            </AppText>
          ) : null}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={18} color={colors.text.tertiary} />
    </PressableScale>
  );
}

export const EpisodeListItem = memo(EpisodeListItemComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    // minHeight rather than height: the title can wrap taller in Tamil.
    minHeight: 76,
  },
  resumeRow: {
    backgroundColor: colors.accent.subtle,
  },
  thumbFrame: {
    width: episodeThumb.width,
    height: Math.round(episodeThumb.width * 1.1),
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.bg.card,
  },
  thumb: {
    width: episodeThumb.width,
    height: Math.round(episodeThumb.width * 1.1),
  },
  thumbOverlay: {
    position: 'absolute',
    right: spacing.xs,
    top: spacing.xs,
    width: 26,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: colors.overlay.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbProgress: {
    position: 'absolute',
    left: spacing.xs,
    right: spacing.xs,
    bottom: spacing.xs,
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  flexText: {
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
