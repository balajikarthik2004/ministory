import type { JSX } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { PlayerScreen } from '../../features/player/PlayerScreen';

/**
 * Player route: /player/:slug?episode=N
 *
 * The drama is the unit of navigation, not the episode: the feed swipes
 * through a season (PLY-02), so the screen needs the whole episode list and
 * `episode` is only where to start. Passing a single episode id would mean
 * fetching its siblings before the first frame could render.
 */
export default function PlayerRoute(): JSX.Element {
  const params = useLocalSearchParams<{ slug: string | string[]; episode?: string | string[] }>();

  const slug = Array.isArray(params.slug) ? (params.slug[0] ?? '') : (params.slug ?? '');
  const rawEpisode = Array.isArray(params.episode) ? params.episode[0] : params.episode;

  // A deep link can carry anything. An unparseable value falls back to the
  // first episode rather than producing NaN and an empty feed.
  const parsed = rawEpisode !== undefined ? Number.parseInt(rawEpisode, 10) : Number.NaN;
  const startEpisodeNumber = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  return <PlayerScreen dramaSlug={slug} startEpisodeNumber={startEpisodeNumber} />;
}
