import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  AccessType,
  ContentRating,
  ProcessingStatus,
  PublishStatus,
  ReleaseStatus,
} from '../src/generated/prisma/enums.js';

/**
 * Deterministic development seed.
 *
 * Deterministic in two senses, both deliberate:
 *
 *  1. Every row has a hand-written id and a fixed timestamp. No cuid(), no
 *     `new Date()`. Two developers who seed a fresh database get byte-identical
 *     data, so a bug reproduces from a seeded database rather than only on the
 *     machine that found it.
 *  2. Every write is an upsert keyed on that id, so running the seed twice is
 *     the same as running it once. `prisma db seed` after a schema change does
 *     not duplicate the catalogue.
 *
 * CONTENT. All of it is invented placeholder material written for this
 * repository. No title, synopsis, image or video is taken from any real
 * production, and nothing here is copyrighted material. Video rows point at
 * the locally generated FFmpeg HLS fixtures from the M1.2 player spike
 * (tools/video-fixtures), which are colour-bar test patterns with a tone.
 */

// Fixed instant so repeated seeds produce identical rows. The date is the
// milestone date, which makes seeded data obvious in a listing.
const SEED_EPOCH = new Date('2026-11-15T00:00:00.000Z');

/**
 * The generated HLS fixtures, with the durations FFmpeg actually produced
 * (tools/video-fixtures/out-abr/manifest.json).
 *
 * Episode N streams fixture ((N-1) % 5) + 1, so the duration recorded against
 * an episode has to come from the same table as the stream it points at.
 *
 * An earlier version of this seed recorded a flat 90 s for every episode while
 * serving 20–90 s media. That mismatch is not cosmetic: M2.1's device run
 * found the mobile app skipping an episode on open, because a stored resume
 * position of 88 s landed past the end of a 45 s stream and the player reached
 * `playToEnd` before rendering a frame. Metadata describing different media
 * from the media being served produces exactly that class of bug, and it is
 * invisible until somebody watches on a real device.
 *
 * Real episodes are 60–120 s (PRD §1). These are short because they are
 * colour-bar test patterns, not content.
 */
const FIXTURE_DURATIONS_SEC = [30, 45, 20, 60, 90] as const;

function fixtureFor(episodeNumber: number): { name: string; durationSec: number } {
  const index = (episodeNumber - 1) % FIXTURE_DURATIONS_SEC.length;
  return {
    name: `ep0${index + 1}`,
    durationSec: FIXTURE_DURATIONS_SEC[index] ?? 30,
  };
}

function at(offsetMinutes: number): Date {
  return new Date(SEED_EPOCH.getTime() + offsetMinutes * 60_000);
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. See apps/backend/.env.example.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

// ─────────────────────────── Reference data ───────────────────────────

/** Launch language first, then the roadmap's expansion languages (PRD §1). */
const LANGUAGES = [
  { id: 'lang_ta', code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', sortOrder: 1 },
  { id: 'lang_te', code: 'te', name: 'Telugu', nativeName: 'తెలుగు', sortOrder: 2 },
  { id: 'lang_hi', code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', sortOrder: 3 },
  { id: 'lang_ml', code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', sortOrder: 4 },
  { id: 'lang_kn', code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', sortOrder: 5 },
  { id: 'lang_en', code: 'en', name: 'English', nativeName: 'English', sortOrder: 6 },
] as const;

/** The nine categories listed in CLAUDE.md §2. */
const CATEGORIES = [
  { id: 'cat_romance', slug: 'romance', name: 'Romance', sortOrder: 1 },
  { id: 'cat_thriller', slug: 'thriller', name: 'Thriller', sortOrder: 2 },
  { id: 'cat_mystery', slug: 'mystery', name: 'Mystery', sortOrder: 3 },
  { id: 'cat_action', slug: 'action', name: 'Action', sortOrder: 4 },
  { id: 'cat_comedy', slug: 'comedy', name: 'Comedy', sortOrder: 5 },
  { id: 'cat_family', slug: 'family-drama', name: 'Family Drama', sortOrder: 6 },
  { id: 'cat_fantasy', slug: 'fantasy', name: 'Fantasy', sortOrder: 7 },
  { id: 'cat_crime', slug: 'crime', name: 'Crime', sortOrder: 8 },
  { id: 'cat_horror', slug: 'horror', name: 'Horror', sortOrder: 9 },
] as const;

interface SeedDrama {
  id: string;
  slug: string;
  title: string;
  description: string;
  categoryIds: readonly string[];
  episodeCount: number;
  freeEpisodeCount: number;
  contentRating: (typeof ContentRating)[keyof typeof ContentRating];
  releaseStatus: (typeof ReleaseStatus)[keyof typeof ReleaseStatus];
  isFeatured: boolean;
  popularityScore: number;
  englishTitle: string;
  englishDescription: string;
}

const DRAMAS: readonly SeedDrama[] = [
  {
    id: 'drama_mazhai',
    slug: 'mazhai-ninaivugal',
    title: 'Mazhai Ninaivugal',
    description:
      'SAMPLE FIXTURE CONTENT. A flooded Chennai street throws two strangers together for one monsoon night, and neither of them can leave it behind. Placeholder synopsis written for local development.',
    categoryIds: ['cat_romance', 'cat_family'],
    episodeCount: 10,
    freeEpisodeCount: 3,
    contentRating: ContentRating.UA_13,
    releaseStatus: ReleaseStatus.ONGOING,
    isFeatured: true,
    popularityScore: 87.5,
    englishTitle: 'Rain Memories',
    englishDescription:
      'SAMPLE FIXTURE CONTENT. English metadata for the same drama, exercising DramaTranslation.',
  },
  {
    id: 'drama_nila',
    slug: 'nila-theru-rahasiyam',
    title: 'Nila Theru Rahasiyam',
    description:
      'SAMPLE FIXTURE CONTENT. A night-shift radio host starts receiving calls from a listener describing crimes that have not happened yet. Placeholder synopsis written for local development.',
    categoryIds: ['cat_thriller', 'cat_mystery'],
    episodeCount: 8,
    freeEpisodeCount: 2,
    contentRating: ContentRating.UA_16,
    releaseStatus: ReleaseStatus.COMPLETED,
    isFeatured: false,
    popularityScore: 64.25,
    englishTitle: 'Moon Street Secret',
    englishDescription:
      'SAMPLE FIXTURE CONTENT. English metadata for the same drama, exercising DramaTranslation.',
  },
  /*
   * Six more, added in M2.3.
   *
   * Two dramas cannot demonstrate a catalogue: a 20-per-page cursor never
   * produces a second page, "Popular Tamil Dramas" and "Trending Now" return
   * the same two cards, and a genre filter either matches everything or
   * nothing. Eight is the same set the mobile mock catalogue carries, so the
   * live API and mock mode show a comparable app and a regression between
   * them is visible rather than hidden behind a different dataset.
   *
   * All of it is invented placeholder material written for this repository.
   */
  {
    id: 'drama_kadhal',
    slug: 'kadhal-kanakku',
    title: 'Kadhal Kanakku',
    description:
      'SAMPLE FIXTURE CONTENT. A maths tutor who calculates every decision meets a student who refuses to be a variable. Placeholder synopsis written for local development.',
    categoryIds: ['cat_romance', 'cat_comedy'],
    episodeCount: 12,
    freeEpisodeCount: 3,
    contentRating: ContentRating.U,
    releaseStatus: ReleaseStatus.ONGOING,
    isFeatured: false,
    popularityScore: 91.4,
    englishTitle: 'Love Arithmetic',
    englishDescription: 'SAMPLE FIXTURE CONTENT. Every equation has a solution.',
  },
  {
    id: 'drama_iravu',
    slug: 'iravu-rayil',
    title: 'Iravu Rayil',
    description:
      'SAMPLE FIXTURE CONTENT. Six strangers board the last train out of Madurai. By morning one of them is missing and nobody remembers boarding with them. Placeholder synopsis written for local development.',
    categoryIds: ['cat_thriller', 'cat_crime'],
    episodeCount: 9,
    freeEpisodeCount: 2,
    contentRating: ContentRating.UA_16,
    releaseStatus: ReleaseStatus.ONGOING,
    isFeatured: false,
    popularityScore: 78.9,
    englishTitle: 'Night Train',
    englishDescription:
      'SAMPLE FIXTURE CONTENT. The train arrives on time. One passenger does not.',
  },
  {
    id: 'drama_veliyil',
    slug: 'veliyil-oru-veedu',
    title: 'Veliyil Oru Veedu',
    description:
      'SAMPLE FIXTURE CONTENT. Three siblings return to sell the family house and find someone has been living in it for eleven years. Placeholder synopsis written for local development.',
    categoryIds: ['cat_family', 'cat_mystery'],
    episodeCount: 11,
    freeEpisodeCount: 3,
    contentRating: ContentRating.UA_13,
    releaseStatus: ReleaseStatus.COMPLETED,
    isFeatured: false,
    popularityScore: 55.1,
    englishTitle: 'A House Outside',
    englishDescription: 'SAMPLE FIXTURE CONTENT. The deed says the house is theirs.',
  },
  {
    id: 'drama_nizhal',
    slug: 'nizhal-vettai',
    title: 'Nizhal Vettai',
    description:
      'SAMPLE FIXTURE CONTENT. A stunt double takes a job doubling for the man who ruined her father, and discovers the role comes with his enemies. Placeholder synopsis written for local development.',
    categoryIds: ['cat_action', 'cat_thriller'],
    episodeCount: 10,
    freeEpisodeCount: 2,
    contentRating: ContentRating.UA_16,
    releaseStatus: ReleaseStatus.ONGOING,
    isFeatured: false,
    popularityScore: 83.7,
    englishTitle: 'Shadow Hunt',
    englishDescription: 'SAMPLE FIXTURE CONTENT. She was hired to take his falls.',
  },
  {
    id: 'drama_kaanal',
    slug: 'kaanal-neer',
    title: 'Kaanal Neer',
    description:
      'SAMPLE FIXTURE CONTENT. Every night at 3:14 a woman wakes in a version of her life where one decision went differently. Placeholder synopsis written for local development.',
    categoryIds: ['cat_fantasy', 'cat_mystery'],
    episodeCount: 8,
    freeEpisodeCount: 3,
    contentRating: ContentRating.UA_13,
    releaseStatus: ReleaseStatus.UPCOMING,
    isFeatured: false,
    popularityScore: 42.3,
    englishTitle: 'Mirage',
    englishDescription: 'SAMPLE FIXTURE CONTENT. Same room, same hour, a different life each time.',
  },
  {
    id: 'drama_pournami',
    slug: 'pournami-kadhai',
    title: 'Pournami Kadhai',
    description:
      'SAMPLE FIXTURE CONTENT. A village tells one story on every full moon. This year the story starts telling itself. Placeholder synopsis written for local development.',
    categoryIds: ['cat_horror', 'cat_mystery'],
    episodeCount: 7,
    freeEpisodeCount: 2,
    contentRating: ContentRating.UA_16,
    releaseStatus: ReleaseStatus.ONGOING,
    isFeatured: false,
    popularityScore: 71.6,
    englishTitle: 'Full Moon Story',
    englishDescription: 'SAMPLE FIXTURE CONTENT. Some stories want an audience.',
  },
] as const;

const TEST_USER_ID = 'user_seed_test';

// ──────────────────────────────── Seed ────────────────────────────────

async function seedLanguages(): Promise<void> {
  for (const language of LANGUAGES) {
    await prisma.language.upsert({
      where: { id: language.id },
      update: { name: language.name, nativeName: language.nativeName, isActive: true },
      create: { ...language, isActive: true, createdAt: SEED_EPOCH },
    });
  }
  console.info(`  languages   ${LANGUAGES.length}`);
}

async function seedCategories(): Promise<void> {
  for (const category of CATEGORIES) {
    await prisma.category.upsert({
      where: { id: category.id },
      update: { name: category.name, isActive: true },
      create: { ...category, isActive: true, createdAt: SEED_EPOCH },
    });
  }
  console.info(`  categories  ${CATEGORIES.length}`);
}

/**
 * One drama, its season, its episodes, its category links and its English
 * translation — in a single transaction.
 *
 * Transactional because of the denormalised counters: Drama.totalEpisodes must
 * never disagree with the number of Episode rows. DATABASE_SCHEMA.md §7 makes
 * that rule explicit, and the seed is the first thing that would break it.
 */
async function seedDrama(drama: SeedDrama): Promise<number> {
  const seasonId = `${drama.id}_s1`;

  return prisma.$transaction(async (tx) => {
    await tx.drama.upsert({
      where: { id: drama.id },
      update: {
        title: drama.title,
        description: drama.description,
        status: PublishStatus.PUBLISHED,
        totalEpisodes: drama.episodeCount,
        popularityScore: drama.popularityScore,
      },
      create: {
        id: drama.id,
        slug: drama.slug,
        title: drama.title,
        description: drama.description,
        posterKey: `seed/posters/${drama.slug}.jpg`,
        coverKey: `seed/covers/${drama.slug}.jpg`,
        languageId: 'lang_ta',
        contentRating: drama.contentRating,
        releaseStatus: drama.releaseStatus,
        status: PublishStatus.PUBLISHED,
        isFeatured: drama.isFeatured,
        freeEpisodeCount: drama.freeEpisodeCount,
        publishedAt: SEED_EPOCH,
        totalEpisodes: drama.episodeCount,
        totalViews: BigInt(0),
        favoriteCount: 0,
        popularityScore: drama.popularityScore,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      },
    });

    for (const categoryId of drama.categoryIds) {
      await tx.dramaCategory.upsert({
        where: { dramaId_categoryId: { dramaId: drama.id, categoryId } },
        update: {},
        create: { dramaId: drama.id, categoryId },
      });
    }

    // PRD PD-4: localised metadata, not a second drama row.
    await tx.dramaTranslation.upsert({
      where: { dramaId_languageId: { dramaId: drama.id, languageId: 'lang_en' } },
      update: { title: drama.englishTitle, description: drama.englishDescription },
      create: {
        id: `${drama.id}_tr_en`,
        dramaId: drama.id,
        languageId: 'lang_en',
        title: drama.englishTitle,
        description: drama.englishDescription,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      },
    });

    await tx.season.upsert({
      where: { id: seasonId },
      update: { status: PublishStatus.PUBLISHED },
      create: {
        id: seasonId,
        dramaId: drama.id,
        seasonNumber: 1,
        title: 'Season 1',
        status: PublishStatus.PUBLISHED,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      },
    });

    for (let number = 1; number <= drama.episodeCount; number += 1) {
      const episodeId = episodeIdFor(drama.id, number);
      // PRD PD-2: the first N episodes of a drama are free.
      const isFree = number <= drama.freeEpisodeCount;
      // The five spike fixtures cycle, so every seeded episode resolves to a
      // real local HLS stream rather than a dead reference — and carries that
      // stream's own duration.
      const fixture = fixtureFor(number);

      await tx.episode.upsert({
        where: { id: episodeId },
        update: {
          title: `Episode ${number}`,
          accessType: isFree ? AccessType.FREE : AccessType.PREMIUM,
          status: PublishStatus.PUBLISHED,
          // Corrects rows written by an earlier seed that recorded a flat
          // 90 s against 20–90 s media.
          durationSec: fixture.durationSec,
          videoPlaybackId: `${fixture.name}/master.m3u8`,
        },
        create: {
          id: episodeId,
          seasonId,
          episodeNumber: number,
          title: `Episode ${number}`,
          description: `SAMPLE FIXTURE CONTENT. Placeholder synopsis for episode ${number}.`,
          videoProvider: 'local',
          // Unique per episode: videoAssetId identifies this episode's asset,
          // so it cannot be the fixture name — the five fixtures cycle, and
          // two episodes sharing an asset id is exactly what the @unique on
          // this column exists to prevent.
          videoAssetId: `local/${drama.slug}/s1/e${String(number).padStart(2, '0')}`,
          // The playback id may repeat: several seeded episodes deliberately
          // stream the same local fixture.
          videoPlaybackId: `${fixture.name}/master.m3u8`,
          processingStatus: ProcessingStatus.READY,
          durationSec: fixture.durationSec,
          aspectRatio: '9:16',
          thumbnailKey: `seed/thumbs/${drama.slug}/e${String(number).padStart(2, '0')}.jpg`,
          accessType: isFree ? AccessType.FREE : AccessType.PREMIUM,
          coinPrice: isFree ? 0 : 15,
          status: PublishStatus.PUBLISHED,
          publishedAt: at(number),
          viewCount: BigInt(0),
          likeCount: 0,
          createdAt: SEED_EPOCH,
          updatedAt: SEED_EPOCH,
        },
      });
    }

    // One subtitle track on the opening episode of each drama, so subtitle
    // handling has something to read without seeding 18 near-identical rows.
    await tx.subtitle.upsert({
      where: {
        episodeId_languageId: {
          episodeId: episodeIdFor(drama.id, 1),
          languageId: 'lang_en',
        },
      },
      update: {},
      create: {
        id: `${drama.id}_e01_sub_en`,
        episodeId: episodeIdFor(drama.id, 1),
        languageId: 'lang_en',
        label: 'English',
        storageKey: 'ep01/subtitles.vtt',
        isDefault: true,
        createdAt: SEED_EPOCH,
      },
    });

    return drama.episodeCount;
  });
}

function episodeIdFor(dramaId: string, episodeNumber: number): string {
  return `${dramaId}_s1_e${String(episodeNumber).padStart(2, '0')}`;
}

/**
 * One test viewer, part-way through the first drama.
 *
 * Mid-watch rather than empty on purpose: Continue Watching, resume position
 * and the favourites list all have an empty state that looks identical to a
 * broken query. Seeded progress makes the difference visible immediately.
 */
async function seedTestUser(): Promise<void> {
  await prisma.user.upsert({
    where: { id: TEST_USER_ID },
    update: { email: 'test@minidrama.local' },
    create: {
      id: TEST_USER_ID,
      email: 'test@minidrama.local',
      phone: '+910000000000',
      isAnonymous: false,
      lastSeenAt: at(120),
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
      profile: {
        create: {
          id: `${TEST_USER_ID}_profile`,
          displayName: 'Test Viewer',
          preferredLanguageId: 'lang_ta',
          preferredGenres: ['romance', 'thriller'],
          createdAt: SEED_EPOCH,
          updatedAt: SEED_EPOCH,
        },
      },
    },
  });

  const [first] = DRAMAS;
  if (!first) return;

  const episode1 = episodeIdFor(first.id, 1);
  const episode2 = episodeIdFor(first.id, 2);

  // Episode 1 finished, episode 2 part-way through.
  const episode1Duration = fixtureFor(1).durationSec;
  const episode2Duration = fixtureFor(2).durationSec;
  // Comfortably short of the 90% completion threshold, so Continue Watching
  // has something to resume into rather than an episode already finished.
  const episode2Position = Math.floor(episode2Duration * 0.4);

  await prisma.watchHistory.upsert({
    where: { userId_episodeId: { userId: TEST_USER_ID, episodeId: episode1 } },
    update: { positionSec: episode1Duration, watchedSec: episode1Duration },
    create: {
      id: `${TEST_USER_ID}_wh_1`,
      userId: TEST_USER_ID,
      episodeId: episode1,
      positionSec: episode1Duration,
      watchedSec: episode1Duration,
      isCompleted: true,
      lastWatchedAt: at(100),
      createdAt: at(100),
    },
  });

  await prisma.watchHistory.upsert({
    where: { userId_episodeId: { userId: TEST_USER_ID, episodeId: episode2 } },
    update: { positionSec: episode2Position, watchedSec: episode2Position },
    create: {
      id: `${TEST_USER_ID}_wh_2`,
      userId: TEST_USER_ID,
      episodeId: episode2,
      positionSec: episode2Position,
      watchedSec: episode2Position,
      isCompleted: false,
      lastWatchedAt: at(120),
      createdAt: at(120),
    },
  });

  // The Continue Watching row that HIST-04 actually reads.
  await prisma.dramaProgress.upsert({
    where: { userId_dramaId: { userId: TEST_USER_ID, dramaId: first.id } },
    update: { lastEpisodeId: episode2, positionSec: episode2Position },
    create: {
      id: `${TEST_USER_ID}_progress_1`,
      userId: TEST_USER_ID,
      dramaId: first.id,
      lastEpisodeId: episode2,
      positionSec: episode2Position,
      episodesWatched: 1,
      isCompleted: false,
      lastWatchedAt: at(120),
    },
  });

  // Favourite, with the drama's denormalised counter kept in step.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.favorite.findUnique({
      where: { userId_dramaId: { userId: TEST_USER_ID, dramaId: first.id } },
    });
    if (existing) return;

    await tx.favorite.create({
      data: { userId: TEST_USER_ID, dramaId: first.id, createdAt: at(110) },
    });
    await tx.drama.update({
      where: { id: first.id },
      data: { favoriteCount: { increment: 1 } },
    });
  });

  console.info('  test user   1 (test@minidrama.local) with profile, history, progress, favourite');
}

async function main(): Promise<void> {
  console.info('Seeding MiniDrama development data…');

  await seedLanguages();
  await seedCategories();

  let episodes = 0;
  for (const drama of DRAMAS) {
    episodes += await seedDrama(drama);
  }
  console.info(
    `  dramas      ${DRAMAS.length} (Tamil), ${episodes} episodes across ${DRAMAS.length} seasons`,
  );

  await seedTestUser();

  console.info('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
