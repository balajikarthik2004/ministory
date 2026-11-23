import type { JSX } from 'react';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DramaCard as DramaCardData } from '@minidrama/contracts';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { posterSize } from '../../constants/layout';
import { AppText } from '../primitives/AppText';
import { Badge } from '../primitives/Badge';
import { PressableScale } from '../primitives/PressableScale';
import { Artwork } from './Artwork';

/**
 * The poster card used in every rail, the search results grid and My List.
 *
 * One card shape for every context (API_DOCUMENTATION.md §4) is what lets a
 * rail be a rail rather than five near-identical components. `width` is the
 * only thing a caller varies.
 *
 * Memoised: a home screen holds five rails over the same eight dramas, and a
 * rail scroll must not re-render forty cards to move twelve pixels.
 */

export interface DramaCardProps {
  drama: DramaCardData;
  onPress: (drama: DramaCardData) => void;
  width?: number;
  /** "FREE" flag on the poster — suppressed where every card would show it. */
  showFreeBadge?: boolean;
}

function DramaCardComponent({
  drama,
  onPress,
  width = posterSize.railWidth,
  showFreeBadge = true,
}: DramaCardProps): JSX.Element {
  const height = Math.round(width * 1.5);
  const subtitle =
    drama.englishTitle && drama.englishTitle !== drama.title ? drama.englishTitle : null;

  return (
    <PressableScale
      onPress={() => onPress(drama)}
      activeScale={0.95}
      accessibilityRole="button"
      accessibilityLabel={`${drama.title}${subtitle ? `, ${subtitle}` : ''}`}
      accessibilityHint={`${drama.totalEpisodes} episodes. Opens drama details.`}
      style={[styles.card, { width }]}
    >
      <View style={[styles.posterFrame, { width, height }]}>
        <Artwork
          url={drama.posterUrl}
          style={{ width, height }}
          borderRadius={radius.lg}
          accessibilityLabel={`${drama.title} poster`}
        />

        {showFreeBadge && drama.freeEpisodeCount > 0 ? (
          <View style={styles.topLeft}>
            <Badge label={`${drama.freeEpisodeCount} FREE`} tone="free" />
          </View>
        ) : null}

        {drama.isFavorited ? (
          <View style={styles.topRight}>
            <Badge label="Saved" tone="live" icon="heart" />
          </View>
        ) : null}

        {/* Episode count sits on the poster's own baked-in scrim, so it reads
            without stacking a gradient view per card. */}
        <View style={styles.bottomMeta}>
          <AppText variant="micro" tone="secondary" numberOfLines={1}>
            {drama.releaseStatus === 'UPCOMING' ? 'Coming soon' : `${drama.totalEpisodes} episodes`}
          </AppText>
        </View>
      </View>

      <View style={styles.titles}>
        <AppText variant="h3" numberOfLines={1}>
          {drama.title}
        </AppText>
        <AppText variant="caption" tone="secondary" numberOfLines={1}>
          {subtitle ?? drama.categories.slice(0, 2).join(' · ')}
        </AppText>
      </View>
    </PressableScale>
  );
}

export const DramaCard = memo(DramaCardComponent);

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
  },
  posterFrame: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.bg.card,
  },
  topLeft: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
  },
  topRight: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
  },
  bottomMeta: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
  },
  titles: {
    // minHeight, not height: a Tamil title at h3 is taller than its Latin
    // equivalent and a fixed height clips the descenders.
    minHeight: 44,
    gap: 1,
  },
});
