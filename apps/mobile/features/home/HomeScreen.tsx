import type { JSX } from 'react';
import { useCallback, useMemo } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  Category,
  ContinueWatchingItem,
  DramaCard as DramaCardData,
  HomeRail,
} from '@minidrama/contracts';
import { colors, spacing } from '@minidrama/ui-tokens';
import { TAB_BAR_HEIGHT } from '../../constants/layout';
import { AppHeader } from '../../components/catalogue/AppHeader';
import { ContinueWatchingCard } from '../../components/catalogue/ContinueWatchingCard';
import { DramaRail, DramaRailSkeleton } from '../../components/catalogue/DramaRail';
import { FeaturedBanner, FeaturedBannerSkeleton } from '../../components/catalogue/FeaturedBanner';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { SectionHeader } from '../../components/feedback/SectionHeader';
import { Chip } from '../../components/primitives/Chip';
import { TopScrim } from '../../components/primitives/TopScrim';
import { useHome, useToggleFavorite } from '../../services/catalogue.queries';
import { toAppError } from '../../services/errors';

/**
 * Home — the discovery surface.
 *
 * Composed from a single `/home` payload rather than one request per rail
 * (API_DOCUMENTATION.md §4): five requests on a cold start is five chances to
 * be slow on a weak connection, which is the connection this audience has.
 *
 * Continue Watching sits directly under the banner whenever it has items. It
 * is the highest-intent element on the screen and UI_UX_GUIDELINES.md §3 is
 * explicit that it never falls below the fold.
 */

export function HomeScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const homeQuery = useHome();
  const toggleFavorite = useToggleFavorite();

  const openDrama = useCallback(
    (drama: DramaCardData) => router.push(`/drama/${drama.slug}`),
    [router],
  );

  /*
   * The server's own Continue Watching resolution, keyed by drama.
   *
   * M2.4 Issue A: this used to read `resumePointFor` from the library store,
   * which is the device's SQLite copy, while the rail beside it rendered
   * server state. The two disagreed. Both now come from the same payload,
   * so "Watch now" and the rail card can never name different episodes.
   */
  const resumeByDramaId = useMemo(() => {
    const map = new Map<string, ContinueWatchingItem>();
    for (const rail of homeQuery.data?.rails ?? []) {
      if (rail.key !== 'continue_watching') continue;
      for (const item of rail.items) map.set(item.drama.id, item);
    }
    return map;
  }, [homeQuery.data?.rails]);

  const playDrama = useCallback(
    (drama: DramaCardData) => {
      // Resume where they left off if there is a resume point; otherwise the
      // first episode. A "Watch now" that restarts a half-finished drama is
      // the single most annoying button in this category.
      const episode = resumeByDramaId.get(drama.id)?.episodeNumber ?? 1;
      router.push(`/player/${drama.slug}?episode=${episode}`);
    },
    [resumeByDramaId, router],
  );

  const resumeItem = useCallback(
    (item: ContinueWatchingItem) =>
      router.push(`/player/${item.drama.slug}?episode=${item.episodeNumber}`),
    [router],
  );

  const openCategory = useCallback(
    (category: Category) => router.push(`/search?categoryId=${category.id}`),
    [router],
  );

  const contentPadding = { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + spacing.xl };

  // ── Loading ────────────────────────────────────────────────────────────
  if (homeQuery.isPending) {
    return (
      <View style={styles.screen}>
        <AppHeader onSearch={() => router.push('/search')} insetTop={insets.top} />
        <ScrollView
          contentContainerStyle={[styles.content, contentPadding]}
          showsVerticalScrollIndicator={false}
          scrollEnabled={false}
        >
          <FeaturedBannerSkeleton />
          <DramaRailSkeleton />
          <DramaRailSkeleton />
        </ScrollView>
      </View>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────
  if (homeQuery.isError) {
    return (
      <View style={styles.screen}>
        <AppHeader onSearch={() => router.push('/search')} insetTop={insets.top} />
        <View style={styles.centred}>
          <ErrorState
            message={toAppError(homeQuery.error).message}
            onRetry={() => void homeQuery.refetch()}
            retrying={homeQuery.isFetching}
          />
        </View>
      </View>
    );
  }

  const { featured, rails, categories } = homeQuery.data;

  // ── Empty ──────────────────────────────────────────────────────────────
  if (!featured && rails.length === 0) {
    return (
      <View style={styles.screen}>
        <AppHeader onSearch={() => router.push('/search')} insetTop={insets.top} />
        <View style={styles.centred}>
          <EmptyState
            icon="film-outline"
            title="Nothing to watch yet"
            message="New dramas are on the way. Pull down to check again."
            actionLabel="Refresh"
            onAction={() => void homeQuery.refetch()}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <TopScrim />
      <AppHeader onSearch={() => router.push('/search')} insetTop={insets.top} floating />

      <ScrollView
        contentContainerStyle={[styles.content, contentPadding]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={homeQuery.isRefetching}
            onRefresh={() => void homeQuery.refetch()}
            tintColor={colors.accent.primary}
            colors={[colors.accent.primary]}
            progressBackgroundColor={colors.bg.card}
          />
        }
      >
        {featured ? (
          <FeaturedBanner
            drama={featured}
            onPlay={playDrama}
            onDetails={openDrama}
            onToggleFavorite={(drama) => toggleFavorite(drama.id)}
          />
        ) : null}

        <View style={styles.rails}>
          {rails.map((rail: HomeRail) => {
            if (rail.key === 'continue_watching') {
              return (
                <View key={rail.key} style={styles.railSection}>
                  <SectionHeader
                    title={rail.title}
                    subtitle="Pick up where you left off"
                    actionLabel="History"
                    onAction={() => router.push('/profile')}
                  />
                  <FlatList
                    horizontal
                    data={rail.items}
                    keyExtractor={(item) => `${item.drama.id}:${item.episodeId}`}
                    renderItem={({ item }) => (
                      <ContinueWatchingCard item={item} onPress={resumeItem} />
                    )}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.railContent}
                    ItemSeparatorComponent={RailGap}
                  />
                </View>
              );
            }

            return (
              <DramaRail
                key={rail.key}
                title={rail.title}
                items={rail.items}
                onSelect={openDrama}
                onSeeAll={() => router.push('/search')}
              />
            );
          })}

          {/* Category browsing. A chip grid rather than another poster rail —
              a genre is not a title and should not look like one. */}
          <View style={styles.railSection}>
            <SectionHeader title="Browse by genre" />
            <View style={styles.chipGrid}>
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  label={category.name}
                  onPress={() => openCategory(category)}
                  accessibilityHint={`Shows ${category.name} dramas`}
                />
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function RailGap(): JSX.Element {
  return <View style={{ width: spacing.md }} />;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  content: {
    gap: spacing.xl,
  },
  centred: {
    flex: 1,
    justifyContent: 'center',
  },
  rails: {
    gap: spacing.xl,
  },
  railSection: {
    gap: spacing.md,
  },
  railContent: {
    paddingHorizontal: spacing.lg,
  },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});
