import type { JSX } from 'react';
import { useCallback } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import type { DramaCard as DramaCardData } from '@minidrama/contracts';
import { spacing } from '@minidrama/ui-tokens';
import { posterSize } from '../../constants/layout';
import { SectionHeader } from '../feedback/SectionHeader';
import { Skeleton } from '../primitives/Skeleton';
import { DramaCard } from './DramaCard';

/**
 * A horizontal rail of poster cards.
 *
 * FlatList rather than ScrollView so a long rail virtualises, and
 * `getItemLayout` is supplied because every card is the same width — that
 * lets the list skip measurement, which is the difference between a rail that
 * scrolls smoothly on a 4GB device and one that stutters on first fling.
 *
 * FlashList would be the natural upgrade and is named in CLAUDE.md §13. It is
 * deliberately not added in M2.1: eight dramas do not stress a FlatList, and
 * docs/VIDEO_PLAYER_SPIKE.md §2 records that list virtualisation is a separate
 * measured question rather than an assumption to act on now.
 */

const CARD_GAP = spacing.md;

export interface DramaRailProps {
  title: string;
  subtitle?: string;
  items: readonly DramaCardData[];
  onSelect: (drama: DramaCardData) => void;
  onSeeAll?: () => void;
  cardWidth?: number;
}

export function DramaRail({
  title,
  subtitle,
  items,
  onSelect,
  onSeeAll,
  cardWidth = posterSize.railWidth,
}: DramaRailProps): JSX.Element | null {
  const renderItem = useCallback(
    ({ item }: { item: DramaCardData }) => (
      <DramaCard drama={item} onPress={onSelect} width={cardWidth} />
    ),
    [cardWidth, onSelect],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<DramaCardData> | null | undefined, index: number) => ({
      length: cardWidth + CARD_GAP,
      offset: (cardWidth + CARD_GAP) * index,
      index,
    }),
    [cardWidth],
  );

  // An empty rail is not rendered at all. The server omits empty rails rather
  // than returning them empty (API_DOCUMENTATION.md §4); this is the client
  // side of the same rule, for the case where a filter empties one locally.
  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader
        title={title}
        {...(subtitle ? { subtitle } : {})}
        {...(onSeeAll ? { actionLabel: 'See all', onAction: onSeeAll } : {})}
      />
      <FlatList
        horizontal
        data={items as DramaCardData[]}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.railContent}
        ItemSeparatorComponent={RailSeparator}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={3}
        removeClippedSubviews
      />
    </View>
  );
}

function RailSeparator(): JSX.Element {
  return <View style={{ width: CARD_GAP }} />;
}

/** Skeleton rail, shaped like the real thing (UI_UX_GUIDELINES.md §5). */
export function DramaRailSkeleton({
  cardWidth = posterSize.railWidth,
  count = 3,
}: {
  cardWidth?: number;
  count?: number;
}): JSX.Element {
  const cardHeight = Math.round(cardWidth * 1.5);
  return (
    <View style={styles.section}>
      <View style={styles.skeletonHeader}>
        <Skeleton width={160} height={22} />
      </View>
      <View style={styles.skeletonRow}>
        {Array.from({ length: count }, (_, index) => (
          <View key={index} style={{ gap: spacing.sm }}>
            <Skeleton width={cardWidth} height={cardHeight} borderRadius={16} />
            <Skeleton width={cardWidth - 24} height={14} />
            <Skeleton width={cardWidth - 56} height={12} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
  },
  railContent: {
    paddingHorizontal: spacing.lg,
  },
  skeletonHeader: {
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  skeletonRow: {
    flexDirection: 'row',
    gap: CARD_GAP,
    paddingHorizontal: spacing.lg,
  },
});
