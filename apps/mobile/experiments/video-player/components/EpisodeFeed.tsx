import type { JSX } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { Dimensions, FlatList, StyleSheet, Text, View } from 'react-native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { colors, spacing, typography } from '@minidrama/ui-tokens';
import type { TestEpisode } from '../types';

/**
 * Vertical paged feed, shared by all three experiments so the only variable
 * between them is player management.
 *
 * FlatList rather than FlashList on purpose: adding a list library would put a
 * second variable into a player experiment. List virtualisation is a separate
 * question for M2.
 */

/** FlatList's viewability payload. Typed locally because React Native 0.88
 *  no longer re-exports ViewToken from the package root. Note `index` is
 *  `number | undefined` here, not `number | null`. */
interface ViewabilityInfo {
  viewableItems: Array<{ index?: number | undefined; isViewable: boolean }>;
}

interface EpisodeFeedProps {
  episodes: readonly TestEpisode[];
  playerForIndex: (index: number) => VideoPlayer | null;
  onIndexChange: (index: number) => void;
  onFirstFrame: (index: number) => void;
  listRef?: React.RefObject<FlatList<TestEpisode> | null>;
}

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');

export function EpisodeFeed({
  episodes,
  playerForIndex,
  onIndexChange,
  onFirstFrame,
  listRef,
}: EpisodeFeedProps): JSX.Element {
  const lastIndexRef = useRef(0);

  // FlatList treats its viewability callback as immutable and warns if the
  // identity changes, so the callbacks live in refs - synced in an effect
  // rather than during render, which the react-hooks rules forbid.
  const onIndexChangeRef = useRef(onIndexChange);
  const onFirstFrameRef = useRef(onFirstFrame);

  useEffect(() => {
    onIndexChangeRef.current = onIndexChange;
    onFirstFrameRef.current = onFirstFrame;
  }, [onIndexChange, onFirstFrame]);

  const handleViewableItemsChanged = useCallback(({ viewableItems }: ViewabilityInfo) => {
    const first = viewableItems[0];
    if (!first || first.index === null || first.index === undefined) return;
    if (first.index === lastIndexRef.current) return;
    lastIndexRef.current = first.index;
    onIndexChangeRef.current(first.index);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: TestEpisode; index: number }) => {
      const player = playerForIndex(index);
      return (
        <View style={styles.page}>
          {player ? (
            <VideoView
              style={styles.video}
              player={player}
              contentFit="contain"
              nativeControls={false}
              // Off: this spike measures the feed, and a PiP transition would
              // add its own lifecycle events to the data.
              allowsPictureInPicture={false}
              // The authoritative first-frame signal - the renderer reporting
              // that a frame reached the surface, not an inference from a
              // progress tick.
              onFirstFrameRender={() => onFirstFrameRef.current(index)}
            />
          ) : (
            <View style={[styles.video, styles.placeholder]}>
              <Text style={styles.placeholderText}>no player assigned</Text>
            </View>
          )}

          <View style={styles.caption} pointerEvents="none">
            <Text style={styles.captionIndex}>#{index}</Text>
            <Text style={styles.captionLabel}>{item.label}</Text>
            <Text style={styles.captionMeta}>
              {item.width}x{item.height} · {item.bitrate} · {item.durationSeconds}s · {item.toneHz}
              Hz
            </Text>
          </View>
        </View>
      );
    },
    // onFirstFrameRef is a ref, so renderItem stays stable across renders.
    [playerForIndex],
  );

  return (
    <FlatList
      ref={listRef}
      data={episodes as TestEpisode[]}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      pagingEnabled
      showsVerticalScrollIndicator={false}
      decelerationRate="fast"
      // Only the visible page and its immediate neighbours stay mounted, which
      // matches what a production feed would do.
      windowSize={3}
      initialNumToRender={1}
      maxToRenderPerBatch={2}
      removeClippedSubviews
      getItemLayout={(_, index) => ({
        length: SCREEN_HEIGHT,
        offset: SCREEN_HEIGHT * index,
        index,
      })}
      viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
      onViewableItemsChanged={handleViewableItemsChanged}
    />
  );
}

const styles = StyleSheet.create({
  page: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    backgroundColor: colors.bg.primary,
  },
  video: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg.card,
  },
  placeholderText: {
    ...typography.caption,
    color: colors.text.tertiary,
  },
  caption: {
    position: 'absolute',
    left: spacing.lg,
    bottom: spacing['3xl'],
    gap: 2,
  },
  captionIndex: {
    ...typography.h2,
    color: colors.accent.primary,
  },
  captionLabel: {
    ...typography.bodyStrong,
    color: colors.text.primary,
  },
  captionMeta: {
    ...typography.caption,
    color: colors.text.secondary,
  },
});
