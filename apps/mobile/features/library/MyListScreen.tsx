import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DramaCard as DramaCardData, WatchHistoryEntry } from '@minidrama/contracts';
import { colors, spacing } from '@minidrama/ui-tokens';
import { TAB_BAR_HEIGHT, formatDuration, formatRemaining, screen } from '../../constants/layout';
import { Artwork } from '../../components/catalogue/Artwork';
import { DramaCard } from '../../components/catalogue/DramaCard';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { AppText } from '../../components/primitives/AppText';
import { Badge } from '../../components/primitives/Badge';
import { Chip } from '../../components/primitives/Chip';
import { ProgressBar } from '../../components/primitives/ProgressBar';
import { PressableScale } from '../../components/primitives/PressableScale';
import { Skeleton } from '../../components/primitives/Skeleton';
import { useFavorites, useHistory } from '../../services/catalogue.queries';
import { toAppError } from '../../services/errors';

/**
 * My List — saved dramas and watch history, on one screen behind two tabs.
 *
 * Both are "things I have a relationship with", and splitting them across two
 * bottom-tab destinations would spend a fifth of the tab bar on a list that is
 * usually short. The segmented control costs one tap and keeps the bar at four.
 */

const GRID_GAP = spacing.md;
const COLUMNS = 3;
const CARD_WIDTH = Math.floor((screen.width - spacing.lg * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS);

type Segment = 'saved' | 'history';

export function MyListScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [segment, setSegment] = useState<Segment>('saved');

  const favoritesQuery = useFavorites();
  const historyQuery = useHistory();

  const openDrama = useCallback(
    (drama: DramaCardData) => router.push(`/drama/${drama.slug}`),
    [router],
  );

  const resumeEntry = useCallback(
    (entry: WatchHistoryEntry) =>
      router.push(`/player/${entry.drama.slug}?episode=${entry.episodeNumber}`),
    [router],
  );

  const activeQuery = segment === 'saved' ? favoritesQuery : historyQuery;
  const bottomPad = insets.bottom + TAB_BAR_HEIGHT + spacing.xl;

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <AppText variant="h1">My List</AppText>
        <View style={styles.segments}>
          <Chip
            label="Saved"
            selected={segment === 'saved'}
            onPress={() => setSegment('saved')}
            accessibilityHint="Shows dramas you have saved"
          />
          <Chip
            label="Watch history"
            selected={segment === 'history'}
            onPress={() => setSegment('history')}
            accessibilityHint="Shows episodes you have watched"
          />
        </View>
      </View>

      {activeQuery.isPending ? (
        <View style={styles.skeletonArea}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} width={'100%'} height={96} borderRadius={12} />
          ))}
        </View>
      ) : activeQuery.isError ? (
        <View style={styles.centred}>
          <ErrorState
            message={toAppError(activeQuery.error).message}
            onRetry={() => void activeQuery.refetch()}
            retrying={activeQuery.isFetching}
          />
        </View>
      ) : segment === 'saved' ? (
        <SavedGrid
          items={favoritesQuery.data ?? []}
          onSelect={openDrama}
          bottomPad={bottomPad}
          onBrowse={() => router.navigate('/home')}
        />
      ) : (
        <HistoryList
          items={historyQuery.data ?? []}
          onSelect={resumeEntry}
          bottomPad={bottomPad}
          onBrowse={() => router.navigate('/home')}
        />
      )}
    </View>
  );
}

function SavedGrid({
  items,
  onSelect,
  bottomPad,
  onBrowse,
}: {
  items: readonly DramaCardData[];
  onSelect: (drama: DramaCardData) => void;
  bottomPad: number;
  onBrowse: () => void;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <View style={styles.centred}>
        <EmptyState
          icon="heart-outline"
          title="Nothing saved yet"
          message="Tap the heart on a drama to find it here."
          actionLabel="Browse dramas"
          onAction={onBrowse}
        />
      </View>
    );
  }

  return (
    <FlatList
      data={items as DramaCardData[]}
      keyExtractor={(item) => item.id}
      numColumns={COLUMNS}
      renderItem={({ item }) => (
        <DramaCard drama={item} onPress={onSelect} width={CARD_WIDTH} showFreeBadge={false} />
      )}
      columnWrapperStyle={styles.column}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: bottomPad }}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews
    />
  );
}

function HistoryList({
  items,
  onSelect,
  bottomPad,
  onBrowse,
}: {
  items: readonly WatchHistoryEntry[];
  onSelect: (entry: WatchHistoryEntry) => void;
  bottomPad: number;
  onBrowse: () => void;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <View style={styles.centred}>
        <EmptyState
          icon="time-outline"
          title="No watch history"
          message="Episodes you watch show up here so you can pick them back up."
          actionLabel="Find something to watch"
          onAction={onBrowse}
        />
      </View>
    );
  }

  return (
    <FlatList
      data={items as WatchHistoryEntry[]}
      keyExtractor={(item) => item.episodeId}
      renderItem={({ item }) => <HistoryRow entry={item} onPress={onSelect} />}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: bottomPad }}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews
    />
  );
}

function HistoryRow({
  entry,
  onPress,
}: {
  entry: WatchHistoryEntry;
  onPress: (entry: WatchHistoryEntry) => void;
}): JSX.Element {
  const progress = entry.durationSec > 0 ? entry.positionSec / entry.durationSec : 0;

  return (
    <PressableScale
      onPress={() => onPress(entry)}
      activeScale={0.98}
      accessibilityRole="button"
      accessibilityLabel={`${entry.drama.title}, episode ${entry.episodeNumber}`}
      accessibilityHint={
        entry.isCompleted ? 'Watched. Plays again from the start.' : 'Resumes this episode'
      }
      style={styles.historyRow}
    >
      <Artwork
        url={entry.drama.posterUrl}
        style={styles.historyThumb}
        borderRadius={10}
        accessibilityLabel={`${entry.drama.title} poster`}
      />
      <View style={styles.historyBody}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {entry.drama.title}
        </AppText>
        <AppText variant="caption" tone="secondary" numberOfLines={1}>
          {`Episode ${entry.episodeNumber} · ${formatDuration(entry.durationSec)}`}
        </AppText>
        <ProgressBar value={progress} />
        <View style={styles.historyMeta}>
          {entry.isCompleted ? (
            <Badge label="Watched" tone="free" icon="checkmark" />
          ) : (
            <AppText variant="micro" tone="tertiary">
              {formatRemaining(entry.positionSec, entry.durationSec)}
            </AppText>
          )}
        </View>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  segments: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  centred: {
    flex: 1,
    justifyContent: 'center',
  },
  skeletonArea: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  column: {
    gap: GRID_GAP,
    paddingHorizontal: spacing.lg,
    marginBottom: GRID_GAP,
  },
  historyRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 96,
    alignItems: 'center',
  },
  historyThumb: {
    width: 60,
    height: 90,
  },
  historyBody: {
    flex: 1,
    gap: spacing.xs,
  },
  historyMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 20,
  },
});
