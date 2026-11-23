import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DramaCard as DramaCardData } from '@minidrama/contracts';
import { colors, spacing } from '@minidrama/ui-tokens';
import { TAB_BAR_HEIGHT, screen } from '../../constants/layout';
import { DramaCard } from '../../components/catalogue/DramaCard';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { SectionHeader } from '../../components/feedback/SectionHeader';
import { AppText } from '../../components/primitives/AppText';
import { Chip } from '../../components/primitives/Chip';
import { SearchInput } from '../../components/primitives/SearchInput';
import { Skeleton } from '../../components/primitives/Skeleton';
import { MOCK_CATEGORIES, MOCK_LANGUAGES } from '../../data/catalogue.mock';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useSearch } from '../../services/catalogue.queries';
import { toAppError } from '../../services/errors';

/**
 * Search — title, genre and language.
 *
 * The query is debounced at 300ms (UI_UX_GUIDELINES.md §3) so typing does not
 * fire a request per keystroke, and the previous results stay on screen while
 * a new one is in flight (`placeholderData` in the query hook) so the list
 * does not flash empty between characters.
 *
 * Filters apply immediately rather than through an Apply button: with two
 * filters and an instant result set, a confirmation step is friction that buys
 * nothing.
 */

const GRID_GAP = spacing.md;
const COLUMNS = 3;
const CARD_WIDTH = Math.floor((screen.width - spacing.lg * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS);

export function SearchScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Deep link from the home screen's genre chips: /search?categoryId=...
  const params = useLocalSearchParams<{ categoryId?: string }>();

  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | undefined>(params.categoryId);
  const [languageId, setLanguageId] = useState<string | undefined>(undefined);

  const debouncedQuery = useDebouncedValue(query, 300);

  const searchParams = useMemo(
    () => ({
      q: debouncedQuery,
      ...(categoryId ? { categoryId } : {}),
      ...(languageId ? { languageId } : {}),
    }),
    [categoryId, debouncedQuery, languageId],
  );

  const searchQuery = useSearch(searchParams);

  const openDrama = useCallback(
    (drama: DramaCardData) => router.push(`/drama/${drama.slug}`),
    [router],
  );

  const hasFilters = Boolean(categoryId || languageId);
  const isBrowsing = debouncedQuery.trim().length === 0 && !hasFilters;

  const clearAll = useCallback(() => {
    setQuery('');
    setCategoryId(undefined);
    setLanguageId(undefined);
  }, []);

  const results = searchQuery.data?.results ?? [];
  const trending = searchQuery.data?.trending ?? [];

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <AppText variant="h1">Search</AppText>
        <SearchInput
          value={query}
          onChangeText={setQuery}
          onClear={clearAll}
          placeholder="Drama title, genre or language"
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Chip
            label="All genres"
            selected={!categoryId}
            onPress={() => setCategoryId(undefined)}
          />
          {MOCK_CATEGORIES.map((category) => (
            <Chip
              key={category.id}
              label={category.name}
              selected={categoryId === category.id}
              onPress={() => setCategoryId(categoryId === category.id ? undefined : category.id)}
            />
          ))}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Chip
            label="All languages"
            selected={!languageId}
            onPress={() => setLanguageId(undefined)}
          />
          {MOCK_LANGUAGES.map((language) => (
            <Chip
              key={language.id}
              // Native name alongside English: a Tamil speaker should find
              // "தமிழ்" without first reading the English label.
              label={`${language.name} · ${language.nativeName}`}
              selected={languageId === language.id}
              onPress={() => setLanguageId(languageId === language.id ? undefined : language.id)}
            />
          ))}
        </ScrollView>
      </View>

      {searchQuery.isError ? (
        <View style={styles.centred}>
          <ErrorState
            message={toAppError(searchQuery.error).message}
            onRetry={() => void searchQuery.refetch()}
            retrying={searchQuery.isFetching}
          />
        </View>
      ) : searchQuery.isPending ? (
        <View style={styles.grid}>
          {Array.from({ length: 6 }, (_, index) => (
            <View key={index} style={{ gap: spacing.sm }}>
              <Skeleton
                width={CARD_WIDTH}
                height={Math.round(CARD_WIDTH * 1.5)}
                borderRadius={16}
              />
              <Skeleton width={CARD_WIDTH - 20} height={13} />
            </View>
          ))}
        </View>
      ) : results.length === 0 ? (
        <View style={styles.centred}>
          {isBrowsing ? (
            <EmptyState
              icon="search"
              title="Find something to watch"
              message="Search by drama title, genre or language."
            />
          ) : (
            <EmptyState
              icon="search"
              title="No matches"
              message={
                debouncedQuery.trim().length > 0
                  ? `No dramas match "${debouncedQuery.trim()}". Try a different title or genre.`
                  : 'No dramas match these filters. Try removing one.'
              }
              actionLabel="Clear search"
              onAction={clearAll}
            />
          )}
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          numColumns={COLUMNS}
          renderItem={({ item }) => (
            <DramaCard drama={item} onPress={openDrama} width={CARD_WIDTH} showFreeBadge={false} />
          )}
          columnWrapperStyle={styles.column}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + spacing.xl },
          ]}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <SectionHeader
              title={isBrowsing ? 'All dramas' : 'Results'}
              subtitle={`${results.length} ${results.length === 1 ? 'drama' : 'dramas'}`}
            />
          }
          // Trending scrolls with the results rather than sitting in a fixed
          // block beneath them. As a sibling of the list it took a fifth of
          // the screen permanently and clipped the second row of posters.
          ListFooterComponent={
            isBrowsing && trending.length > 0 ? (
              <View style={styles.trending}>
                <AppText variant="caption" tone="secondary">
                  Trending searches
                </AppText>
                <View style={styles.trendingRow}>
                  {trending.map((term) => (
                    <Chip key={term} label={term} onPress={() => setQuery(term)} />
                  ))}
                </View>
              </View>
            ) : undefined
          }
          initialNumToRender={9}
          maxToRenderPerBatch={9}
          windowSize={5}
          removeClippedSubviews
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  header: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.md,
  },
  filterRow: {
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  centred: {
    flex: 1,
    justifyContent: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  column: {
    gap: GRID_GAP,
    paddingHorizontal: spacing.lg,
    marginBottom: GRID_GAP,
  },
  listContent: {
    gap: spacing.xs,
  },
  trending: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.sm,
  },
  trendingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
