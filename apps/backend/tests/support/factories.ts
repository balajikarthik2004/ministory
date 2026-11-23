import { prisma, TEST_USER_ID } from './harness.js';

/**
 * Test data builders.
 *
 * Each test states only what it is actually about: a pagination test should
 * not be twenty lines of drama construction. Everything has a sensible
 * default and an override.
 */

const EPOCH = new Date('2026-11-16T00:00:00.000Z');

export async function seedReferenceData(): Promise<void> {
  await prisma.language.createMany({
    data: [
      { id: 'lang_ta', code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', sortOrder: 1 },
      { id: 'lang_te', code: 'te', name: 'Telugu', nativeName: 'తెలుగు', sortOrder: 2 },
      { id: 'lang_en', code: 'en', name: 'English', nativeName: 'English', sortOrder: 6 },
    ],
    skipDuplicates: true,
  });

  await prisma.category.createMany({
    data: [
      { id: 'cat_romance', slug: 'romance', name: 'Romance', sortOrder: 1 },
      { id: 'cat_thriller', slug: 'thriller', name: 'Thriller', sortOrder: 2 },
    ],
    skipDuplicates: true,
  });
}

export async function createTestUser(id = TEST_USER_ID): Promise<string> {
  await prisma.user.upsert({
    where: { id },
    update: {},
    create: { id, email: `${id}@test.local`, createdAt: EPOCH, updatedAt: EPOCH },
  });
  return id;
}

export interface DramaOptions {
  id: string;
  slug?: string;
  title?: string;
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'SCHEDULED';
  archived?: boolean;
  languageId?: string;
  categoryIds?: string[];
  popularityScore?: number;
  publishedAt?: Date;
  episodes?: number;
  freeEpisodes?: number;
  /** Per-episode durations, cycled. Mirrors the real fixture lengths. */
  durations?: number[];
  englishTitle?: string;
  isFeatured?: boolean;
}

export async function createDrama(options: DramaOptions): Promise<string> {
  const slug = options.slug ?? options.id.replace(/_/g, '-');
  const episodes = options.episodes ?? 3;
  const freeEpisodes = options.freeEpisodes ?? 1;
  const durations = options.durations ?? [30, 45, 20, 60, 90];

  await prisma.drama.create({
    data: {
      id: options.id,
      slug,
      title: options.title ?? options.id,
      description: `Test drama ${options.id}`,
      languageId: options.languageId ?? 'lang_ta',
      status: options.status ?? 'PUBLISHED',
      ...(options.archived ? { archivedAt: EPOCH } : {}),
      isFeatured: options.isFeatured ?? false,
      popularityScore: options.popularityScore ?? 50,
      totalEpisodes: episodes,
      freeEpisodeCount: freeEpisodes,
      publishedAt: options.publishedAt ?? EPOCH,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      posterKey: `test/${slug}.jpg`,
    },
  });

  for (const categoryId of options.categoryIds ?? []) {
    await prisma.dramaCategory.create({ data: { dramaId: options.id, categoryId } });
  }

  if (options.englishTitle) {
    await prisma.dramaTranslation.create({
      data: {
        id: `${options.id}_en`,
        dramaId: options.id,
        languageId: 'lang_en',
        title: options.englishTitle,
        description: `English description for ${options.id}`,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    });
  }

  const seasonId = `${options.id}_s1`;
  await prisma.season.create({
    data: {
      id: seasonId,
      dramaId: options.id,
      seasonNumber: 1,
      title: 'Season 1',
      status: options.status ?? 'PUBLISHED',
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
  });

  for (let number = 1; number <= episodes; number += 1) {
    await prisma.episode.create({
      data: {
        id: episodeId(options.id, number),
        seasonId,
        episodeNumber: number,
        title: `Episode ${number}`,
        videoProvider: 'local',
        videoAssetId: `test/${options.id}/e${number}`,
        videoPlaybackId: `ep0${((number - 1) % 5) + 1}/master.m3u8`,
        processingStatus: 'READY',
        durationSec: durations[(number - 1) % durations.length] ?? 30,
        accessType: number <= freeEpisodes ? 'FREE' : 'PREMIUM',
        coinPrice: number <= freeEpisodes ? 0 : 15,
        status: options.status ?? 'PUBLISHED',
        publishedAt: EPOCH,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    });
  }

  return options.id;
}

export function episodeId(dramaId: string, number: number): string {
  return `${dramaId}_s1_e${String(number).padStart(2, '0')}`;
}

/** A contract-valid playback event, with overrides. */
export function playbackEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 12)}-${Date.now()}`,
    sessionId: 'ps_test_session',
    dramaId: 'drama_test',
    episodeId: episodeId('drama_test', 1),
    type: 'playback_started',
    occurredAt: new Date().toISOString(),
    positionSec: 0,
    durationSec: 30,
    errorCode: null,
    context: { platform: 'android', appVersion: '0.1.0-test' },
    ...overrides,
  };
}
