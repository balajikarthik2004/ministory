import type { JSX } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { DramaDetailScreen } from '../../features/drama/DramaDetailScreen';

/**
 * Drama detail route: /drama/:slug
 *
 * Slug rather than id in the URL — it survives a database reseed, it is
 * readable in a deep link, and `GET /dramas/:idOrSlug` accepts either
 * (API_DOCUMENTATION.md §4).
 */
export default function DramaRoute(): JSX.Element {
  // `useLocalSearchParams` returns `string | string[]` for a dynamic segment
  // because a route *can* be matched repeatedly. Narrowing here rather than
  // asserting keeps the screen's prop honestly a string.
  const params = useLocalSearchParams<{ slug: string | string[] }>();
  const slug = Array.isArray(params.slug) ? (params.slug[0] ?? '') : (params.slug ?? '');

  return <DramaDetailScreen slug={slug} />;
}
