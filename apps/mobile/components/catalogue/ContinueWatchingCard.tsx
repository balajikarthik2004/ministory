import type { JSX } from 'react';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ContinueWatchingItem } from '@minidrama/contracts';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { formatRemaining, posterSize } from '../../constants/layout';
import { AppText } from '../primitives/AppText';
import { ProgressBar } from '../primitives/ProgressBar';
import { PressableScale } from '../primitives/PressableScale';
import { Artwork } from './Artwork';

/**
 * Continue Watching card — resume straight into the player.
 *
 * Wider than a standard poster card because it carries a progress bar and a
 * "Episode 4 · 2 min left" line; 136dp cannot hold that without truncating the
 * part the card exists to communicate.
 *
 * Tapping it goes to the player, not the detail screen. This is the highest-
 * intent element on the home screen (UI_UX_GUIDELINES.md §3) and a viewer who
 * taps a half-watched episode wants the video, not a synopsis.
 */

export interface ContinueWatchingCardProps {
  item: ContinueWatchingItem;
  onPress: (item: ContinueWatchingItem) => void;
}

function ContinueWatchingCardComponent({ item, onPress }: ContinueWatchingCardProps): JSX.Element {
  const width = posterSize.continueWidth;
  const height = Math.round(width * 1.5);
  const progress = item.durationSec > 0 ? item.positionSec / item.durationSec : 0;

  return (
    <PressableScale
      onPress={() => onPress(item)}
      activeScale={0.95}
      accessibilityRole="button"
      accessibilityLabel={`Resume ${item.drama.title}, episode ${item.episodeNumber}`}
      accessibilityHint={formatRemaining(item.positionSec, item.durationSec)}
      style={[styles.card, { width }]}
    >
      <View style={[styles.frame, { width, height }]}>
        <Artwork
          url={item.drama.posterUrl}
          style={{ width, height }}
          borderRadius={radius.lg}
          accessibilityLabel={`${item.drama.title} poster`}
        />

        <View style={styles.playBadge}>
          <Ionicons name="play" size={20} color={colors.text.onAccent} />
        </View>

        <View style={styles.footer}>
          <AppText variant="micro" tone="secondary" numberOfLines={1}>
            {`EP ${item.episodeNumber} · ${formatRemaining(item.positionSec, item.durationSec)}`}
          </AppText>
          <ProgressBar
            value={progress}
            accessibilityLabel={`${Math.round(progress * 100)} percent watched`}
          />
        </View>
      </View>

      <AppText variant="bodyStrong" numberOfLines={1}>
        {item.drama.title}
      </AppText>
    </PressableScale>
  );
}

export const ContinueWatchingCard = memo(ContinueWatchingCardComponent);

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
  },
  frame: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.bg.card,
  },
  playBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 44,
    height: 44,
    marginTop: -28,
    marginLeft: -22,
    borderRadius: radius.full,
    backgroundColor: colors.accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
    // Optical centring: the glyph's own mass sits left of its box centre.
    paddingLeft: 3,
  },
  footer: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
    gap: spacing.xs,
  },
});
