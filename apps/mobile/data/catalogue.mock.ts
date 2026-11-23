import type {
  Category,
  ContentRating,
  DramaDetail,
  EpisodeSummary,
  Language,
  ReleaseStatus,
  UserProfile,
} from '@minidrama/contracts';
import { dramaDetailSchema, episodeSummarySchema, userProfileSchema } from '@minidrama/contracts';
import { assetUrl, type ArtworkSlug } from './asset-url';

/**
 * MOCK CATALOGUE — M2.1 only. Replaced by live API calls in M3.
 * ═════════════════════════════════════════════════════════════
 *
 * CLAUDE.md §16.11/§16.12 require temporary implementations to be obvious.
 * Everything in this file is invented sample content; every synopsis is
 * original placeholder copy written for this repository, and every image is a
 * generated abstract composition (tools/placeholder-art/generate.mjs).
 *
 * The dataset is deliberately *shaped* like the database, not copied from it:
 * the two dramas that exist in prisma/seed.ts keep their slugs, titles and
 * free-episode counts so a developer moving between the seeded backend and the
 * mobile mock sees the same catalogue. The other six exist only here, because
 * a two-item rail cannot demonstrate a rail.
 *
 * Validation: every record is parsed through the contract schemas at module
 * load (see `assertContractShape` at the bottom). A mock that drifts from
 * `@minidrama/contracts` fails immediately in development rather than quietly
 * shaping a screen the real API will not fit.
 */

const PLACEHOLDER_NOTE = 'Sample content for local development.';

// ──────────────────────────── Reference data ─────────────────────────────
// Mirrors prisma/seed.ts so IDs match a seeded backend.

export const MOCK_LANGUAGES: readonly Language[] = [
  { id: 'lang_ta', code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { id: 'lang_te', code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { id: 'lang_hi', code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { id: 'lang_ml', code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
  { id: 'lang_kn', code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { id: 'lang_en', code: 'en', name: 'English', nativeName: 'English' },
];

export const MOCK_CATEGORIES: readonly Category[] = [
  { id: 'cat_romance', slug: 'romance', name: 'Romance' },
  { id: 'cat_thriller', slug: 'thriller', name: 'Thriller' },
  { id: 'cat_mystery', slug: 'mystery', name: 'Mystery' },
  { id: 'cat_action', slug: 'action', name: 'Action' },
  { id: 'cat_comedy', slug: 'comedy', name: 'Comedy' },
  { id: 'cat_family', slug: 'family-drama', name: 'Family Drama' },
  { id: 'cat_fantasy', slug: 'fantasy', name: 'Fantasy' },
  { id: 'cat_crime', slug: 'crime', name: 'Crime' },
  { id: 'cat_horror', slug: 'horror', name: 'Horror' },
];

const TAMIL = MOCK_LANGUAGES[0] as Language;

// ───────────────────────────── Drama source ──────────────────────────────

interface DramaSeed {
  id: string;
  slug: ArtworkSlug;
  title: string;
  englishTitle: string;
  description: string;
  englishDescription: string;
  categoryIds: readonly string[];
  episodeCount: number;
  freeEpisodeCount: number;
  contentRating: ContentRating;
  releaseStatus: ReleaseStatus;
  isFeatured: boolean;
  popularityScore: number;
  publishedAt: string;
  cast: ReadonlyArray<{ name: string; role: string }>;
}

/**
 * Cast names are fictional. CLAUDE.md §16.16 forbids reproducing real talent
 * credits from a reference app, and naming a real actor against invented
 * content would be worse than a placeholder.
 */
const DRAMA_SEEDS: readonly DramaSeed[] = [
  {
    id: 'drama_mazhai',
    slug: 'mazhai-ninaivugal',
    title: 'Mazhai Ninaivugal',
    englishTitle: 'Rain Memories',
    description: `A flooded Chennai street throws two strangers together for one monsoon night, and neither of them can leave it behind. ${PLACEHOLDER_NOTE}`,
    englishDescription: `One monsoon night, one flooded street, and two people who should never have met. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_romance', 'cat_family'],
    episodeCount: 10,
    freeEpisodeCount: 3,
    contentRating: 'UA_13',
    releaseStatus: 'ONGOING',
    isFeatured: true,
    popularityScore: 87.5,
    publishedAt: '2026-10-02T06:00:00.000Z',
    cast: [
      { name: 'Aarthi Sundaram', role: 'Meera' },
      { name: 'Vignesh Raman', role: 'Karthik' },
      { name: 'Lalitha Devan', role: 'Paatti' },
    ],
  },
  {
    id: 'drama_nila',
    slug: 'nila-theru-rahasiyam',
    title: 'Nila Theru Rahasiyam',
    englishTitle: 'Moon Street Secret',
    description: `A night-shift radio host starts receiving calls from a listener describing crimes that have not happened yet. ${PLACEHOLDER_NOTE}`,
    englishDescription: `The caller knows what happens next. The question is how. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_thriller', 'cat_mystery'],
    episodeCount: 8,
    freeEpisodeCount: 2,
    contentRating: 'UA_16',
    releaseStatus: 'COMPLETED',
    isFeatured: false,
    popularityScore: 64.25,
    publishedAt: '2026-09-14T06:00:00.000Z',
    cast: [
      { name: 'Divya Mohan', role: 'Anjali' },
      { name: 'Surya Prakash', role: 'The caller' },
    ],
  },
  {
    id: 'drama_kadhal',
    slug: 'kadhal-kanakku',
    title: 'Kadhal Kanakku',
    englishTitle: 'Love Arithmetic',
    description: `A maths tutor who calculates every decision meets a student who refuses to be a variable. ${PLACEHOLDER_NOTE}`,
    englishDescription: `Every equation has a solution. This one has feelings. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_romance', 'cat_comedy'],
    episodeCount: 12,
    freeEpisodeCount: 3,
    contentRating: 'U',
    releaseStatus: 'ONGOING',
    isFeatured: false,
    popularityScore: 91.4,
    publishedAt: '2026-10-28T06:00:00.000Z',
    cast: [
      { name: 'Priya Natarajan', role: 'Sandhya' },
      { name: 'Hari Krishnan', role: 'Ravi' },
    ],
  },
  {
    id: 'drama_iravu',
    slug: 'iravu-rayil',
    title: 'Iravu Rayil',
    englishTitle: 'Night Train',
    description: `Six strangers board the last train out of Madurai. By morning, one of them is missing and nobody remembers boarding with them. ${PLACEHOLDER_NOTE}`,
    englishDescription: `The train arrives on time. One passenger does not. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_thriller', 'cat_crime'],
    episodeCount: 9,
    freeEpisodeCount: 2,
    contentRating: 'UA_16',
    releaseStatus: 'ONGOING',
    isFeatured: false,
    popularityScore: 78.9,
    publishedAt: '2026-11-01T06:00:00.000Z',
    cast: [
      { name: 'Senthil Arumugam', role: 'Inspector Velan' },
      { name: 'Nandhini Raj', role: 'Kavya' },
    ],
  },
  {
    id: 'drama_veliyil',
    slug: 'veliyil-oru-veedu',
    title: 'Veliyil Oru Veedu',
    englishTitle: 'A House Outside',
    description: `Three siblings return to sell the family house and find someone has been living in it for eleven years. ${PLACEHOLDER_NOTE}`,
    englishDescription: `The deed says the house is theirs. The house disagrees. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_family', 'cat_mystery'],
    episodeCount: 11,
    freeEpisodeCount: 3,
    contentRating: 'UA_13',
    releaseStatus: 'COMPLETED',
    isFeatured: false,
    popularityScore: 55.1,
    publishedAt: '2026-08-20T06:00:00.000Z',
    cast: [
      { name: 'Meenakshi Iyer', role: 'Shanthi' },
      { name: 'Gopal Subramani', role: 'Arun' },
    ],
  },
  {
    id: 'drama_nizhal',
    slug: 'nizhal-vettai',
    title: 'Nizhal Vettai',
    englishTitle: 'Shadow Hunt',
    description: `A stunt double takes a job doubling for the man who ruined her father, and discovers the role comes with his enemies. ${PLACEHOLDER_NOTE}`,
    englishDescription: `She was hired to take his falls. She took his life instead. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_action', 'cat_thriller'],
    episodeCount: 10,
    freeEpisodeCount: 2,
    contentRating: 'UA_16',
    releaseStatus: 'ONGOING',
    isFeatured: false,
    popularityScore: 83.7,
    publishedAt: '2026-11-08T06:00:00.000Z',
    cast: [
      { name: 'Bhavani Selvam', role: 'Thara' },
      { name: 'Rajesh Kumaran', role: 'Dev' },
    ],
  },
  {
    id: 'drama_kaanal',
    slug: 'kaanal-neer',
    title: 'Kaanal Neer',
    englishTitle: 'Mirage',
    description: `Every night at 3:14 a woman wakes in a version of her life where one decision went differently. ${PLACEHOLDER_NOTE}`,
    englishDescription: `Same room, same hour, a different life each time. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_fantasy', 'cat_mystery'],
    episodeCount: 8,
    freeEpisodeCount: 3,
    contentRating: 'UA_13',
    releaseStatus: 'UPCOMING',
    isFeatured: false,
    popularityScore: 42.3,
    publishedAt: '2026-11-12T06:00:00.000Z',
    cast: [{ name: 'Yamuna Prasad', role: 'Ila' }],
  },
  {
    id: 'drama_pournami',
    slug: 'pournami-kadhai',
    title: 'Pournami Kadhai',
    englishTitle: 'Full Moon Story',
    description: `A village tells one story on every full moon. This year the story starts telling itself. ${PLACEHOLDER_NOTE}`,
    englishDescription: `Some stories want an audience. This one wants a cast. ${PLACEHOLDER_NOTE}`,
    categoryIds: ['cat_horror', 'cat_mystery'],
    episodeCount: 7,
    freeEpisodeCount: 2,
    contentRating: 'UA_16',
    releaseStatus: 'ONGOING',
    isFeatured: false,
    popularityScore: 71.6,
    publishedAt: '2026-10-19T06:00:00.000Z',
    cast: [
      { name: 'Kalaivani Murugan', role: 'Thaiyal' },
      { name: 'Prabhu Anand', role: 'Mani' },
    ],
  },
];

// ───────────────────────────── Construction ──────────────────────────────

function categoryNames(ids: readonly string[]): string[] {
  return ids
    .map((id) => MOCK_CATEGORIES.find((category) => category.id === id)?.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * The generated HLS fixtures, with the durations FFmpeg actually produced
 * (tools/video-fixtures/out-abr/manifest.json).
 *
 * Episode N plays fixture ((N-1) % 5) + 1, and `mock-api.ts` builds its
 * playback URL from this same table. Both have to come from one place: an
 * earlier version invented plausible-looking 88-112s durations while serving
 * 20-90s media, and the mismatch was not cosmetic. A seeded resume position of
 * 88s into a "112s" episode landed past the end of a 45s fixture, so the
 * player reached `playToEnd` on load and auto-advanced before the viewer saw a
 * frame. Metadata that describes different media from the media being served
 * produces exactly that class of bug.
 *
 * Real episodes are 60-120s (PRD §1). These are short because they are test
 * patterns, not content.
 */
export const FIXTURES = [
  { id: 'ep01', durationSec: 30 },
  { id: 'ep02', durationSec: 45 },
  { id: 'ep03', durationSec: 20 },
  { id: 'ep04', durationSec: 60 },
  { id: 'ep05', durationSec: 90 },
] as const;

export interface Fixture {
  id: string;
  durationSec: number;
}

/** Which fixture backs a given episode number. Round-robin over the five. */
export function fixtureForEpisode(episodeNumber: number): Fixture {
  const index = (episodeNumber - 1) % FIXTURES.length;
  // Non-null: index is always in range for a positive episode number.
  return FIXTURES[index] ?? FIXTURES[0];
}

function buildDrama(seed: DramaSeed): DramaDetail {
  return dramaDetailSchema.parse({
    id: seed.id,
    slug: seed.slug,
    title: seed.title,
    englishTitle: seed.englishTitle,
    description: seed.description,
    englishDescription: seed.englishDescription,
    posterUrl: assetUrl(seed.slug, 'poster'),
    bannerUrl: assetUrl(seed.slug, 'banner'),
    language: { code: TAMIL.code, name: TAMIL.name },
    categories: categoryNames(seed.categoryIds),
    contentRating: seed.contentRating,
    releaseStatus: seed.releaseStatus,
    totalEpisodes: seed.episodeCount,
    freeEpisodeCount: seed.freeEpisodeCount,
    isFavorited: false,
    // No trailer asset exists yet. Null rather than a fabricated id — the UI
    // hides the trailer action instead of offering a button that fails
    // (CLAUDE.md §16.13: do not invent API values).
    trailerPlaybackId: null,
    cast: seed.cast,
    seasonNumber: 1,
    publishedAt: seed.publishedAt,
  });
}

function buildEpisodes(seed: DramaSeed): EpisodeSummary[] {
  return Array.from({ length: seed.episodeCount }, (_, index) => {
    const episodeNumber = index + 1;
    const isFree = episodeNumber <= seed.freeEpisodeCount;
    return episodeSummarySchema.parse({
      id: `${seed.id}_ep${String(episodeNumber).padStart(2, '0')}`,
      dramaId: seed.id,
      episodeNumber,
      title: `Episode ${episodeNumber}`,
      description: null,
      thumbnailUrl: assetUrl(seed.slug, 'thumb'),
      durationSec: fixtureForEpisode(episodeNumber).durationSec,
      accessType: isFree ? 'FREE' : 'PREMIUM',
      // In production this is computed per caller from the viewer's
      // entitlements. The mock profile has no subscription, so every premium
      // episode is locked — which is the state the UI most needs to prove.
      isLocked: !isFree,
      unlockOptions: isFree ? [] : ['SUBSCRIPTION', 'COIN', 'REWARDED_AD'],
      coinPrice: isFree ? 0 : 20,
      watchState: null,
    });
  });
}

export interface MockCatalogue {
  dramas: readonly DramaDetail[];
  /** dramaId -> that drama's episodes, in episode order. */
  episodesByDrama: ReadonlyMap<string, readonly EpisodeSummary[]>;
  popularity: ReadonlyMap<string, number>;
  publishedAt: ReadonlyMap<string, string>;
  /**
   * Which drama the home banner shows.
   *
   * Kept here rather than as a field on `DramaDetail`, because "is featured"
   * is a *catalogue* decision, not a property of the drama the client is
   * given: the real `GET /home` returns the featured drama in its own slot
   * (API_DOCUMENTATION.md §4) and never ships an `isFeatured` flag for the
   * client to re-derive the banner from.
   */
  featuredId: string | null;
}

function buildCatalogue(): MockCatalogue {
  const dramas = DRAMA_SEEDS.map(buildDrama);
  const episodesByDrama = new Map<string, readonly EpisodeSummary[]>();
  const popularity = new Map<string, number>();
  const publishedAt = new Map<string, string>();

  for (const seed of DRAMA_SEEDS) {
    episodesByDrama.set(seed.id, buildEpisodes(seed));
    popularity.set(seed.id, seed.popularityScore);
    publishedAt.set(seed.id, seed.publishedAt);
  }

  const featured = DRAMA_SEEDS.find((seed) => seed.isFeatured) ?? DRAMA_SEEDS[0];

  return {
    dramas,
    episodesByDrama,
    popularity,
    publishedAt,
    featuredId: featured?.id ?? null,
  };
}

export const MOCK_CATALOGUE: MockCatalogue = buildCatalogue();

export const MOCK_TRENDING_SEARCHES: readonly string[] = [
  'Mazhai',
  'Thriller',
  'Night Train',
  'Romance',
  'Completed',
];

/**
 * The signed-in user for M2.1.
 *
 * `isAnonymous: false` with no real credential: this is a mock profile, not an
 * authenticated session. Real authentication is M3 (CLAUDE.md §15 Stage 3) and
 * is explicitly out of scope for this milestone.
 */
export const MOCK_PROFILE: UserProfile = userProfileSchema.parse({
  id: 'user_seed_test',
  displayName: 'Dev Viewer',
  email: 'viewer@minidrama.local',
  phone: null,
  isAnonymous: false,
  avatarUrl: null,
  preferredLanguage: TAMIL,
  preferredGenres: ['Romance', 'Thriller'],
  autoplayNext: true,
  notificationsOptIn: true,
  subscriptionStatus: 'NONE',
  memberSince: '2026-09-01T00:00:00.000Z',
});

/** Starting watch progress, so Continue Watching has content on first run. */
export interface SeededProgress {
  dramaId: string;
  episodeNumber: number;
  positionSec: number;
  lastWatchedAt: string;
}

export const MOCK_SEEDED_PROGRESS: readonly SeededProgress[] = [
  // Positions are against the real fixture lengths (see FIXTURES), and all
  // sit well short of the completion threshold so Continue Watching has
  // something to resume into rather than an episode that is already finished.
  {
    dramaId: 'drama_mazhai',
    episodeNumber: 2, // fixture ep02, 45s
    positionSec: 18,
    lastWatchedAt: '2026-11-15T19:40:00.000Z',
  },
  {
    dramaId: 'drama_kadhal',
    episodeNumber: 1, // fixture ep01, 30s
    positionSec: 12,
    lastWatchedAt: '2026-11-14T21:05:00.000Z',
  },
  {
    dramaId: 'drama_iravu',
    episodeNumber: 2, // fixture ep02, 45s
    positionSec: 31,
    lastWatchedAt: '2026-11-13T08:15:00.000Z',
  },
];

/** Dramas favourited out of the box, so My List is not empty on first run. */
export const MOCK_SEEDED_FAVORITES: readonly string[] = ['drama_nizhal', 'drama_mazhai'];

export function findDramaBySlug(slug: string): DramaDetail | undefined {
  return MOCK_CATALOGUE.dramas.find((drama) => drama.slug === slug);
}

export function findDramaById(id: string): DramaDetail | undefined {
  return MOCK_CATALOGUE.dramas.find((drama) => drama.id === id);
}

export function episodesFor(dramaId: string): readonly EpisodeSummary[] {
  return MOCK_CATALOGUE.episodesByDrama.get(dramaId) ?? [];
}
