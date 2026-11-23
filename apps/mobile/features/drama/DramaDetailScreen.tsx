import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EpisodeSummary } from '@minidrama/contracts';
import { colors, spacing } from '@minidrama/ui-tokens';
import { DETAIL_HERO_HEIGHT, screen } from '../../constants/layout';
import { Artwork } from '../../components/catalogue/Artwork';
import { EpisodeListItem } from '../../components/catalogue/EpisodeListItem';
import { ErrorState } from '../../components/feedback/ErrorState';
import { SectionHeader } from '../../components/feedback/SectionHeader';
import { AppText } from '../../components/primitives/AppText';
import { Badge } from '../../components/primitives/Badge';
import { Button } from '../../components/primitives/Button';
import { Gradient } from '../../components/primitives/Gradient';
import { IconButton } from '../../components/primitives/IconButton';
import { Skeleton } from '../../components/primitives/Skeleton';
import { TopScrim } from '../../components/primitives/TopScrim';
import { useDrama, useEpisodes, useToggleFavorite } from '../../services/catalogue.queries';
import { toAppError } from '../../services/errors';
import { useLibraryStore } from '../../store/library.store';
import { resolveResumePoint } from '../../services/resume';

/**
 * Drama detail.
 *
 * One `FlatList` over the episodes with the whole hero as its header, rather
 * than a ScrollView wrapping a list. Nesting a vertical list inside a vertical
 * ScrollView disables virtualisation entirely and warns about it — on a
 * sixty-episode drama that is every row mounted at once, which is exactly the
 * cost CLAUDE.md §13 is about.
 */

export interface DramaDetailScreenProps {
  slug: string;
}

export function DramaDetailScreen({ slug }: DramaDetailScreenProps): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const dramaQuery = useDrama(slug);
  const episodesQuery = useEpisodes(dramaQuery.data?.id);
  const toggleFavorite = useToggleFavorite();
  const favoriteIds = useLibraryStore((state) => state.favoriteIds);

  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const drama = dramaQuery.data;
  const episodes = useMemo(() => episodesQuery.data ?? [], [episodesQuery.data]);

  /*
   * Resolved from the episode list's own `watchState`, not from the library
   * store (M2.4 Issue A).
   *
   * The store is hydrated from the device's SQLite copy, which is the
   * write-ahead record rather than the truth. Reading it here while Home
   * read the server meant the two screens could name different episodes for
   * the same drama. Both now resolve through `resolveResumePoint` over
   * server-supplied state, so they agree by construction.
   */
  const resume = useMemo(() => resolveResumePoint(episodes), [episodes]);

  const openEpisode = useCallback(
    (episode: EpisodeSummary) => {
      if (!drama) return;
      router.push(`/player/${drama.slug}?episode=${episode.episodeNumber}`);
    },
    [drama, router],
  );

  const startWatching = useCallback(() => {
    if (!drama) return;
    const episodeNumber = resume?.episodeNumber ?? 1;
    router.push(`/player/${drama.slug}?episode=${episodeNumber}`);
  }, [drama, resume, router]);

  // ── Loading ────────────────────────────────────────────────────────────
  if (dramaQuery.isPending) {
    return (
      <View style={styles.screen}>
        <Skeleton width={screen.width} height={DETAIL_HERO_HEIGHT} borderRadius={0} />
        <View style={styles.skeletonBody}>
          <Skeleton width={'60%'} height={28} />
          <Skeleton width={'40%'} height={14} />
          <Skeleton width={'90%'} height={14} />
          <Skeleton width={'100%'} height={54} borderRadius={999} />
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} width={'100%'} height={76} borderRadius={10} />
          ))}
        </View>
      </View>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────
  if (dramaQuery.isError || !drama) {
    return (
      <View style={[styles.screen, styles.centred]}>
        <ErrorState
          message={toAppError(dramaQuery.error).message}
          onRetry={() => void dramaQuery.refetch()}
          retrying={dramaQuery.isFetching}
        />
        <Button label="Go back" variant="ghost" size="md" onPress={() => router.back()} />
      </View>
    );
  }

  const isFavorited = favoriteIds.includes(drama.id);
  const meta = [
    drama.language.name,
    drama.categories.join(' · '),
    `${drama.totalEpisodes} episodes`,
  ].join('   ·   ');

  const header = (
    <View>
      {/* ── Hero ────────────────────────────────────────────────────── */}
      <View style={styles.hero}>
        <Artwork
          url={drama.posterUrl}
          style={styles.heroImage}
          accessibilityLabel={`${drama.title} poster`}
        />
        <Gradient direction="up" intensity={0.7} steps={5} style={styles.heroTopScrim} />
        <Gradient direction="down" intensity={0.99} steps={9} style={styles.heroBottomScrim} />

        <View style={[styles.heroNav, { top: insets.top + spacing.sm }]}>
          <IconButton
            name="chevron-back"
            surface="glass"
            onPress={() => router.back()}
            accessibilityLabel="Go back"
          />
          <View style={styles.heroNavActions}>
            <IconButton
              name={isFavorited ? 'heart' : 'heart-outline'}
              surface="glass"
              color={isFavorited ? colors.accent.primary : colors.text.primary}
              selected={isFavorited}
              onPress={() => toggleFavorite(drama.id)}
              accessibilityLabel={isFavorited ? 'Remove from My List' : 'Save to My List'}
            />
          </View>
        </View>

        <View style={styles.heroContent}>
          <View style={styles.badgeRow}>
            <Badge label={drama.contentRating.replace('_', '+')} tone="neutral" />
            <Badge
              label={
                drama.releaseStatus === 'ONGOING'
                  ? 'New episodes weekly'
                  : drama.releaseStatus === 'UPCOMING'
                    ? 'Coming soon'
                    : 'Complete'
              }
              tone="live"
            />
            {drama.freeEpisodeCount > 0 ? (
              <Badge label={`First ${drama.freeEpisodeCount} free`} tone="free" />
            ) : null}
          </View>

          <AppText variant="display" numberOfLines={2}>
            {drama.title}
          </AppText>
          {drama.englishTitle ? (
            <AppText variant="body" tone="secondary" numberOfLines={1}>
              {drama.englishTitle}
            </AppText>
          ) : null}
          <AppText variant="caption" tone="secondary" numberOfLines={2} style={styles.meta}>
            {meta}
          </AppText>
        </View>
      </View>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <View style={styles.body}>
        <Button
          label={resume ? `Resume Episode ${resume.episodeNumber}` : 'Start watching'}
          icon="play"
          size="lg"
          fullWidth
          onPress={startWatching}
          accessibilityHint={`Opens the player for ${drama.title}`}
        />

        <View style={styles.secondaryActions}>
          <Button
            label={isFavorited ? 'Saved' : 'My List'}
            icon={isFavorited ? 'checkmark' : 'add'}
            variant="secondary"
            size="md"
            onPress={() => toggleFavorite(drama.id)}
            style={styles.flexAction}
          />
          <Button
            label="Trailer"
            icon="film-outline"
            variant="ghost"
            size="md"
            // No trailer asset exists, so the control is disabled rather than
            // offering a button that fails (CLAUDE.md §16.13/§16.14).
            disabled={drama.trailerPlaybackId === null}
            onPress={() => undefined}
            style={styles.flexAction}
          />
        </View>

        <View style={styles.description}>
          <AppText
            variant="body"
            tone="secondary"
            numberOfLines={descriptionExpanded ? undefined : 3}
          >
            {drama.description}
          </AppText>
          <AppText
            variant="caption"
            tone="accent"
            onPress={() => setDescriptionExpanded((expanded) => !expanded)}
            accessibilityRole="button"
            style={styles.moreLink}
          >
            {descriptionExpanded ? 'Less' : 'More'}
          </AppText>
        </View>

        {drama.cast.length > 0 ? (
          <View style={styles.castBlock}>
            <AppText variant="caption" tone="tertiary">
              CAST
            </AppText>
            <AppText variant="caption" tone="secondary">
              {drama.cast.map((member) => `${member.name} as ${member.role}`).join('  ·  ')}
            </AppText>
          </View>
        ) : null}

        <SectionHeader
          title="Episodes"
          subtitle={`Season ${drama.seasonNumber} · ${drama.totalEpisodes} episodes`}
        />
      </View>
    </View>
  );

  return (
    <View style={styles.screen}>
      <TopScrim />
      <FlatList
        data={episodes}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <EpisodeListItem
            episode={item}
            onPress={openEpisode}
            isResumePoint={resume?.episodeNumber === item.episodeNumber}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={
          episodesQuery.isPending ? (
            <View style={styles.episodeSkeletons}>
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} width={'100%'} height={76} borderRadius={10} />
              ))}
            </View>
          ) : episodesQuery.isError ? (
            <ErrorState
              compact
              message={toAppError(episodesQuery.error).message}
              onRetry={() => void episodesQuery.refetch()}
            />
          ) : (
            <View style={styles.emptyEpisodes}>
              <AppText variant="body" tone="secondary">
                No episodes published yet.
              </AppText>
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing['3xl'] }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  centred: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  hero: {
    width: screen.width,
    height: DETAIL_HERO_HEIGHT,
    backgroundColor: colors.bg.secondary,
  },
  heroImage: {
    width: screen.width,
    height: DETAIL_HERO_HEIGHT,
  },
  heroTopScrim: {
    bottom: undefined,
    height: 140,
  },
  heroBottomScrim: {
    top: undefined,
    height: Math.round(DETAIL_HERO_HEIGHT * 0.6),
  },
  heroNav: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroNavActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  heroContent: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.xs,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    flexWrap: 'wrap',
  },
  meta: {
    marginTop: spacing.xs,
  },
  body: {
    paddingTop: spacing.lg,
    gap: spacing.lg,
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  flexAction: {
    flex: 1,
  },
  description: {
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  moreLink: {
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  castBlock: {
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  skeletonBody: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  episodeSkeletons: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  emptyEpisodes: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
});
