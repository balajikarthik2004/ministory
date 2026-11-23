import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { DramaDetail, DramaPage, EpisodePage, SearchResult } from '@minidrama/contracts';
import { apiRequest, dataOf, resetTestData, stopTestServer } from './support/harness.js';
import { createDrama, seedReferenceData } from './support/factories.js';

/**
 * One teardown for the file.
 *
 * The HTTP server and the Prisma pool are both open handles; closing them in
 * a suite's own `after` leaves the next suite without a server and the
 * process alive at the end of the run. Node's test runner calls a top-level
 * `after` once, after every suite in the file.
 */
after(async () => {
  await resetTestData();
  await stopTestServer();
});

describe('catalogue API', () => {
  before(async () => {
    await resetTestData();
    await seedReferenceData();

    await createDrama({
      id: 'drama_alpha',
      slug: 'alpha-drama',
      title: 'Alpha Drama',
      englishTitle: 'First Light',
      popularityScore: 90,
      categoryIds: ['cat_romance'],
      episodes: 4,
      freeEpisodes: 2,
      isFeatured: true,
      publishedAt: new Date('2026-11-10T00:00:00.000Z'),
    });
    await createDrama({
      id: 'drama_beta',
      slug: 'beta-drama',
      title: 'Beta Drama',
      popularityScore: 70,
      categoryIds: ['cat_thriller'],
      languageId: 'lang_te',
      publishedAt: new Date('2026-11-14T00:00:00.000Z'),
    });
    await createDrama({
      id: 'drama_gamma',
      slug: 'gamma-drama',
      title: 'Gamma Drama',
      popularityScore: 80,
      categoryIds: ['cat_romance', 'cat_thriller'],
      publishedAt: new Date('2026-11-12T00:00:00.000Z'),
    });

    // Must never appear in any response.
    await createDrama({ id: 'drama_draft', slug: 'draft-drama', status: 'DRAFT' });
    await createDrama({ id: 'drama_archived', slug: 'archived-drama', archived: true });
  });

  describe('published-only filtering', () => {
    it('omits draft and archived dramas from the list', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50'));
      const slugs = page.items.map((item) => item.slug);

      assert.equal(slugs.includes('draft-drama'), false);
      assert.equal(slugs.includes('archived-drama'), false);
      assert.equal(page.items.length, 3);
    });

    it('404s a draft drama fetched directly by slug', async () => {
      const response = await apiRequest('/dramas/draft-drama');
      assert.equal(response.status, 404);
    });

    it('404s an archived drama fetched directly by slug', async () => {
      const response = await apiRequest('/dramas/archived-drama');
      assert.equal(response.status, 404);
    });

    it('404s episodes of an unpublished drama rather than returning an empty list', async () => {
      // An empty list is indistinguishable from a drama with no episodes.
      const response = await apiRequest('/dramas/drama_draft/episodes');
      assert.equal(response.status, 404);
    });
  });

  describe('pagination', () => {
    it('pages with a cursor and never repeats a row', async () => {
      const first = dataOf<DramaPage>(await apiRequest('/dramas?limit=2&sort=popular'));
      assert.equal(first.items.length, 2);
      assert.equal(first.hasMore, true);
      assert.ok(first.nextCursor);

      const second = dataOf<DramaPage>(
        await apiRequest(`/dramas?limit=2&sort=popular&cursor=${first.nextCursor}`),
      );

      const firstIds = first.items.map((item) => item.id);
      const secondIds = second.items.map((item) => item.id);
      assert.equal(
        secondIds.some((id) => firstIds.includes(id)),
        false,
      );
      assert.equal(second.hasMore, false);
    });

    it('reports hasMore false on the last page', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50'));
      assert.equal(page.hasMore, false);
      assert.equal(page.nextCursor, null);
    });

    it('rejects a limit above the contract maximum', async () => {
      const response = await apiRequest('/dramas?limit=999');
      assert.equal(response.status, 400);
    });

    it('rejects a non-numeric limit', async () => {
      const response = await apiRequest('/dramas?limit=abc');
      assert.equal(response.status, 400);
    });

    it('rejects an unknown sort value rather than silently defaulting', async () => {
      const response = await apiRequest('/dramas?sort=DROP+TABLE');
      assert.equal(response.status, 400);
    });
  });

  describe('sorting', () => {
    it('orders by popularity', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50&sort=popular'));
      assert.deepEqual(
        page.items.map((item) => item.title),
        ['Alpha Drama', 'Gamma Drama', 'Beta Drama'],
      );
    });

    it('orders by recency', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50&sort=recent'));
      assert.deepEqual(
        page.items.map((item) => item.title),
        ['Beta Drama', 'Gamma Drama', 'Alpha Drama'],
      );
    });

    it('orders by title', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50&sort=title'));
      assert.deepEqual(
        page.items.map((item) => item.title),
        ['Alpha Drama', 'Beta Drama', 'Gamma Drama'],
      );
    });
  });

  describe('filtering', () => {
    it('filters by language', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50&languageId=lang_te'));
      assert.deepEqual(
        page.items.map((item) => item.title),
        ['Beta Drama'],
      );
    });

    it('filters by category', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50&categoryId=cat_romance'));
      assert.deepEqual(page.items.map((item) => item.title).sort(), ['Alpha Drama', 'Gamma Drama']);
    });

    it('returns an empty page for a filter that matches nothing', async () => {
      const page = dataOf<DramaPage>(await apiRequest('/dramas?limit=50&languageId=lang_nope'));
      assert.deepEqual(page.items, []);
      assert.equal(page.hasMore, false);
    });
  });

  describe('drama detail', () => {
    it('returns the full shape', async () => {
      const drama = dataOf<DramaDetail>(await apiRequest('/dramas/alpha-drama'));

      assert.equal(drama.title, 'Alpha Drama');
      assert.equal(drama.englishTitle, 'First Light');
      assert.equal(drama.totalEpisodes, 4);
      assert.equal(drama.freeEpisodeCount, 2);
      assert.equal(drama.seasonNumber, 1);
      assert.equal(drama.isFavorited, false, 'a guest has no favourites');
      assert.ok(drama.posterUrl.length > 0);
      assert.ok(drama.bannerUrl.length > 0);
    });

    it('404s an unknown slug', async () => {
      const response = await apiRequest('/dramas/no-such-drama');
      assert.equal(response.status, 404);
    });
  });

  describe('episodes', () => {
    it('returns episodes in order with per-episode durations', async () => {
      const page = dataOf<EpisodePage>(await apiRequest('/dramas/drama_alpha/episodes'));

      assert.deepEqual(
        page.items.map((item) => item.episodeNumber),
        [1, 2, 3, 4],
      );
      // The factory cycles the real fixture lengths; a flat duration here
      // would be the M2.1 bug returning.
      assert.deepEqual(
        page.items.map((item) => item.durationSec),
        [30, 45, 20, 60],
      );
    });

    it('locks episodes past the free allowance', async () => {
      const page = dataOf<EpisodePage>(await apiRequest('/dramas/drama_alpha/episodes'));

      assert.deepEqual(
        page.items.map((item) => item.isLocked),
        [false, false, true, true],
      );
      assert.deepEqual(page.items[0]?.unlockOptions, []);
      assert.ok((page.items[2]?.unlockOptions.length ?? 0) > 0);
    });

    it('returns no watch state for a guest', async () => {
      const page = dataOf<EpisodePage>(await apiRequest('/dramas/drama_alpha/episodes'));
      assert.equal(
        page.items.every((item) => item.watchState === null),
        true,
      );
    });
  });

  describe('search', () => {
    it('matches on the drama title', async () => {
      const result = dataOf<SearchResult>(await apiRequest('/search?q=Alpha'));
      assert.deepEqual(
        result.results.map((item) => item.title),
        ['Alpha Drama'],
      );
    });

    it('matches on an English translation', async () => {
      const result = dataOf<SearchResult>(await apiRequest('/search?q=First Light'));
      assert.deepEqual(
        result.results.map((item) => item.title),
        ['Alpha Drama'],
      );
    });

    it('matches on a genre name', async () => {
      const result = dataOf<SearchResult>(await apiRequest('/search?q=thriller'));
      assert.deepEqual(result.results.map((item) => item.title).sort(), [
        'Beta Drama',
        'Gamma Drama',
      ]);
    });

    it('is case insensitive', async () => {
      const result = dataOf<SearchResult>(await apiRequest('/search?q=aLpHa'));
      assert.equal(result.results.length, 1);
    });

    it('returns everything published for an empty query', async () => {
      const result = dataOf<SearchResult>(await apiRequest('/search?q='));
      assert.equal(result.results.length, 3);
    });

    it('never returns unpublished content', async () => {
      const result = dataOf<SearchResult>(await apiRequest('/search?q=drama'));
      const slugs = result.results.map((item) => item.slug);
      assert.equal(slugs.includes('draft-drama'), false);
      assert.equal(slugs.includes('archived-drama'), false);
    });
  });

  describe('reference data', () => {
    it('lists active categories', async () => {
      const categories = dataOf<Array<{ slug: string }>>(await apiRequest('/categories'));
      assert.deepEqual(categories.map((item) => item.slug).sort(), ['romance', 'thriller']);
    });

    it('lists active languages with native names', async () => {
      const languages = dataOf<Array<{ code: string; nativeName: string }>>(
        await apiRequest('/languages'),
      );
      const tamil = languages.find((item) => item.code === 'ta');
      assert.equal(tamil?.nativeName, 'தமிழ்');
    });
  });

  describe('home', () => {
    it('composes the payload in one response', async () => {
      const home = dataOf<{
        featured: DramaDetail | null;
        rails: Array<{ key: string; items: unknown[] }>;
        categories: unknown[];
        languages: unknown[];
      }>(await apiRequest('/home'));

      assert.equal(home.featured?.slug, 'alpha-drama', 'the featured flag is honoured');
      assert.ok(home.rails.length >= 2);
      assert.ok(home.categories.length > 0);
      assert.ok(home.languages.length > 0);
    });

    it('omits empty rails rather than returning them empty', async () => {
      const home = dataOf<{ rails: Array<{ key: string; items: unknown[] }> }>(
        await apiRequest('/home'),
      );
      assert.equal(
        home.rails.every((rail) => rail.items.length > 0),
        true,
      );
      // A guest has no progress, so there is nothing to continue.
      assert.equal(
        home.rails.some((rail) => rail.key === 'continue_watching'),
        false,
      );
    });
  });
});

describe('catalogue API — isolation', () => {
  beforeEach(async () => {
    await resetTestData();
  });

  it('returns an empty catalogue when nothing is published', async () => {
    const page = dataOf<DramaPage>(await apiRequest('/dramas'));
    assert.deepEqual(page.items, []);
  });

  it('returns a null featured drama rather than failing on an empty catalogue', async () => {
    const home = dataOf<{ featured: unknown; rails: unknown[] }>(await apiRequest('/home'));
    assert.equal(home.featured, null);
    assert.deepEqual(home.rails, []);
  });
});
