import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DramaDetail } from '@minidrama/contracts';
import { colors, spacing } from '@minidrama/ui-tokens';
import { screen } from '../../constants/layout';
import { AppText } from '../primitives/AppText';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Gradient } from '../primitives/Gradient';
import { IconButton } from '../primitives/IconButton';
import { Skeleton } from '../primitives/Skeleton';
import { Artwork } from './Artwork';

/**
 * The home screen's featured drama.
 *
 * Taller than the 16:9 artwork it contains, so the gradient has room to carry
 * the title block without covering the image — a 16:9 banner with text sitting
 * directly on it loses either the text or the picture.
 */

const BANNER_HEIGHT = Math.round(screen.width * 0.92);

export interface FeaturedBannerProps {
  drama: DramaDetail;
  onPlay: (drama: DramaDetail) => void;
  onDetails: (drama: DramaDetail) => void;
  onToggleFavorite: (drama: DramaDetail) => void;
}

export function FeaturedBanner({
  drama,
  onPlay,
  onDetails,
  onToggleFavorite,
}: FeaturedBannerProps): JSX.Element {
  const meta = [
    drama.language.name,
    drama.categories[0],
    `${drama.totalEpisodes} eps`,
    drama.contentRating.replace('_', '+'),
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <View style={styles.container}>
      <Artwork
        url={drama.bannerUrl}
        style={styles.image}
        accessibilityLabel={`${drama.title} featured artwork`}
      />

      {/* Two scrims: a short one at the top so the header stays legible over
          a bright frame, and a tall one at the bottom for the title block. */}
      <Gradient direction="up" intensity={0.7} steps={5} style={styles.topScrim} />
      <Gradient direction="down" intensity={0.98} steps={9} style={styles.bottomScrim} />

      <View style={styles.content}>
        <View style={styles.badges}>
          <Badge label="Featured" tone="accent" icon="sparkles" />
          {drama.freeEpisodeCount > 0 ? (
            <Badge label={`${drama.freeEpisodeCount} episodes free`} tone="free" />
          ) : null}
        </View>

        <AppText variant="display" numberOfLines={2}>
          {drama.title}
        </AppText>
        {drama.englishTitle ? (
          <AppText variant="caption" tone="secondary" numberOfLines={1}>
            {drama.englishTitle}
          </AppText>
        ) : null}

        <AppText variant="caption" tone="secondary" numberOfLines={1} style={styles.meta}>
          {meta}
        </AppText>

        <AppText variant="body" tone="secondary" numberOfLines={2}>
          {drama.description}
        </AppText>

        <View style={styles.actions}>
          <Button
            label="Watch now"
            icon="play"
            size="lg"
            onPress={() => onPlay(drama)}
            accessibilityHint={`Starts ${drama.title} from episode 1`}
            style={styles.primaryAction}
          />
          <IconButton
            name={drama.isFavorited ? 'heart' : 'heart-outline'}
            surface="glass"
            color={drama.isFavorited ? colors.accent.primary : colors.text.primary}
            onPress={() => onToggleFavorite(drama)}
            selected={drama.isFavorited}
            accessibilityLabel={
              drama.isFavorited
                ? `Remove ${drama.title} from My List`
                : `Save ${drama.title} to My List`
            }
          />
          <IconButton
            name="information-circle-outline"
            surface="glass"
            onPress={() => onDetails(drama)}
            accessibilityLabel={`More about ${drama.title}`}
          />
        </View>
      </View>
    </View>
  );
}

export function FeaturedBannerSkeleton(): JSX.Element {
  return (
    <View style={[styles.container, styles.skeleton]}>
      <View style={styles.skeletonContent}>
        <Skeleton width={110} height={20} borderRadius={6} />
        <Skeleton width={'70%'} height={34} />
        <Skeleton width={'45%'} height={14} />
        <Skeleton width={'90%'} height={14} />
        <Skeleton width={160} height={54} borderRadius={999} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: screen.width,
    height: BANNER_HEIGHT,
    backgroundColor: colors.bg.secondary,
  },
  skeleton: {
    justifyContent: 'flex-end',
  },
  skeletonContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  image: {
    width: screen.width,
    height: BANNER_HEIGHT,
  },
  topScrim: {
    bottom: undefined,
    height: 120,
  },
  bottomScrim: {
    top: undefined,
    height: Math.round(BANNER_HEIGHT * 0.72),
  },
  content: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  badges: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  meta: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  primaryAction: {
    flex: 1,
  },
});
