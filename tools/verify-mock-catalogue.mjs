#!/usr/bin/env node
/**
 * Verifies the M2.1 mock catalogue against the shared contracts, and against
 * the artwork that actually exists on disk.
 *
 * WHY
 * ---
 * `apps/mobile/data/catalogue.mock.ts` parses every record through a Zod
 * schema at module load. That is the right place for the check — but it means
 * a mistake surfaces as a crash on app start, on a device, which is the
 * slowest possible feedback loop and the one place where there is no device
 * available to find it.
 *
 * This runs the same parses in Node, in about a second. It is a verification
 * step, not a test suite: no test framework is added, and nothing here is
 * mocked. It loads the real mock module and the real schemas.
 *
 * It also checks the things TypeScript cannot: that every artwork file the
 * catalogue references is present on disk at a sensible size, and that the
 * free/locked split in the episode data matches each drama's
 * `freeEpisodeCount`.
 *
 * Usage:  node --experimental-strip-types tools/verify-mock-catalogue.mjs
 *         (or `pnpm --filter @minidrama/mobile verify:mocks`)
 */

import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const MOBILE = resolve(REPO_ROOT, 'apps/mobile');

/**
 * `tools/` is not a workspace package, so `@minidrama/contracts` is not on its
 * resolution path. Anchoring the require at the mobile app's package.json
 * resolves it exactly the way the app does, rather than hard-coding a path
 * into `packages/contracts/dist`.
 */
const requireFromMobile = createRequire(resolve(MOBILE, 'package.json'));
const CONTRACTS_ENTRY = pathToFileURL(requireFromMobile.resolve('@minidrama/contracts')).href;

const FIXTURE_HINT =
  '        (run: node tools/video-fixtures/generate-abr.mjs)' + String.fromCharCode(10);
let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok    ${label}\n`);
    return true;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`);
  return false;
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

const mock = await import(pathToFileURL(resolve(MOBILE, 'data/catalogue.mock.ts')).href);
const assetUrlModule = await import(pathToFileURL(resolve(MOBILE, 'data/asset-url.ts')).href);
const contracts = await import(CONTRACTS_ENTRY);

const { MOCK_CATALOGUE, MOCK_PROFILE, MOCK_SEEDED_PROGRESS, MOCK_SEEDED_FAVORITES } = mock;
const { ARTWORK_SLUGS, parseAssetUrl } = assetUrlModule;
const { dramaDetailSchema, episodeSummarySchema, userProfileSchema, homePayloadSchema } = contracts;

// ─────────────────────────── Contract conformance ────────────────────────
// The mock module already parses on import, so reaching this line at all
// proves the happy path. Re-parsing explicitly makes the check visible and
// catches anything constructed outside `buildDrama` / `buildEpisodes`.

section('Contract conformance');

for (const drama of MOCK_CATALOGUE.dramas) {
  const result = dramaDetailSchema.safeParse(drama);
  check(
    `drama ${drama.slug} matches dramaDetailSchema`,
    result.success,
    result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3)),
  );
}

for (const [dramaId, episodes] of MOCK_CATALOGUE.episodesByDrama) {
  let allValid = true;
  let firstIssue = '';
  for (const episode of episodes) {
    const result = episodeSummarySchema.safeParse(episode);
    if (!result.success) {
      allValid = false;
      firstIssue = JSON.stringify(result.error.issues.slice(0, 2));
      break;
    }
  }
  check(`${dramaId}: ${episodes.length} episodes match episodeSummarySchema`, allValid, firstIssue);
}

{
  const result = userProfileSchema.safeParse(MOCK_PROFILE);
  check(
    'mock profile matches userProfileSchema',
    result.success,
    result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3)),
  );
}

// ──────────────────────────── Referential sanity ─────────────────────────

section('Referential integrity');

check(
  'featuredId names a real drama',
  MOCK_CATALOGUE.dramas.some((drama) => drama.id === MOCK_CATALOGUE.featuredId),
  `featuredId=${MOCK_CATALOGUE.featuredId}`,
);

for (const favoriteId of MOCK_SEEDED_FAVORITES) {
  check(
    `seeded favourite ${favoriteId} names a real drama`,
    MOCK_CATALOGUE.dramas.some((drama) => drama.id === favoriteId),
  );
}

for (const entry of MOCK_SEEDED_PROGRESS) {
  const episodes = MOCK_CATALOGUE.episodesByDrama.get(entry.dramaId) ?? [];
  const episode = episodes.find((item) => item.episodeNumber === entry.episodeNumber);
  check(
    `seeded progress ${entry.dramaId} ep${entry.episodeNumber} exists`,
    episode !== undefined,
  );
  if (episode) {
    check(
      `  ...and its position ${entry.positionSec}s is within the ${episode.durationSec}s episode`,
      entry.positionSec <= episode.durationSec,
    );
    // Resuming into a locked episode would open the player straight onto the
    // unlock panel, which is a confusing first run rather than a crash — so
    // this is worth catching here.
    check(`  ...and it is not a locked episode`, !episode.isLocked);
  }
}

section('Episode access rules');

for (const drama of MOCK_CATALOGUE.dramas) {
  const episodes = MOCK_CATALOGUE.episodesByDrama.get(drama.id) ?? [];
  check(
    `${drama.slug}: episode count matches totalEpisodes (${drama.totalEpisodes})`,
    episodes.length === drama.totalEpisodes,
    `got ${episodes.length}`,
  );

  const free = episodes.filter((episode) => !episode.isLocked);
  check(
    `${drama.slug}: ${drama.freeEpisodeCount} free episodes, and they are the first ones`,
    free.length === drama.freeEpisodeCount &&
      free.every((episode) => episode.episodeNumber <= drama.freeEpisodeCount),
    `free=[${free.map((e) => e.episodeNumber).join(',')}]`,
  );

  const numbers = episodes.map((episode) => episode.episodeNumber);
  const expected = Array.from({ length: drama.totalEpisodes }, (_, i) => i + 1);
  check(
    `${drama.slug}: episode numbers are 1..${drama.totalEpisodes} with no gaps`,
    numbers.join(',') === expected.join(','),
  );
}

section('Episode duration matches the media served');

// The bug this catches: the catalogue reported invented 88-112s durations
// while serving 20-90s fixtures, so a seeded resume position landed past the
// end of the real media and the player hit `playToEnd` on load.

{
  const { FIXTURES, fixtureForEpisode } = mock;
  const manifestPath = resolve(REPO_ROOT, 'tools/video-fixtures/out-abr/manifest.json');
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }

  if (!check('the ABR fixture manifest is present', manifest !== null, manifestPath)) {
    process.stdout.write(FIXTURE_HINT);
  } else {
    for (const fixture of FIXTURES) {
      const real = manifest.episodes.find((episode) => episode.id === fixture.id);
      check(
        `FIXTURES ${fixture.id} duration ${fixture.durationSec}s matches the generated media`,
        real !== undefined && real.durationSeconds === fixture.durationSec,
        real ? `manifest says ${real.durationSeconds}s` : 'not in the manifest',
      );
    }

    for (const drama of MOCK_CATALOGUE.dramas) {
      const episodes = MOCK_CATALOGUE.episodesByDrama.get(drama.id) ?? [];
      const mismatched = episodes.filter(
        (episode) => episode.durationSec !== fixtureForEpisode(episode.episodeNumber).durationSec,
      );
      check(
        `${drama.slug}: every episode's durationSec matches its fixture`,
        mismatched.length === 0,
        mismatched.map((e) => `ep${e.episodeNumber}=${e.durationSec}s`).join(', '),
      );
    }
  }
}

// ───────────────────────────── Artwork on disk ───────────────────────────

section('Artwork');

const referenced = new Set();
for (const drama of MOCK_CATALOGUE.dramas) {
  referenced.add(drama.posterUrl);
  referenced.add(drama.bannerUrl);
  for (const episode of MOCK_CATALOGUE.episodesByDrama.get(drama.id) ?? []) {
    referenced.add(episode.thumbnailUrl);
  }
}

for (const url of referenced) {
  const parsed = parseAssetUrl(url);
  if (!check(`${url} is a well-formed asset URL`, parsed !== null)) continue;
  const file = resolve(MOBILE, `assets/posters/${parsed.slug}-${parsed.variant}.png`);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  check(`  ...and ${parsed.slug}-${parsed.variant}.png exists`, size > 0);
  // A truncated or placeholder-of-a-placeholder file would still "exist".
  check(`  ...and is a plausible image (${(size / 1024).toFixed(0)} kB)`, size > 10_000);
}

check(
  'every slug in ARTWORK_SLUGS is used by a drama',
  ARTWORK_SLUGS.every((slug) => MOCK_CATALOGUE.dramas.some((drama) => drama.slug === slug)),
);

// ───────────────────────── Home payload composition ──────────────────────
// Builds the payload the way the mock API does, through the same schema, so a
// rail shape that the discriminated union rejects is caught here.

section('Home payload');

{
  const library = {
    favoriteIds: [...MOCK_SEEDED_FAVORITES],
    progress: MOCK_SEEDED_PROGRESS.map((entry) => ({ ...entry })),
    watchStates: {},
  };

  const api = await import(pathToFileURL(resolve(MOBILE, 'services/mock-api.ts')).href);
  const payload = await api.fetchHome(library);
  const result = homePayloadSchema.safeParse(payload);
  check(
    'fetchHome() output matches homePayloadSchema',
    result.success,
    result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3)),
  );
  check(
    'home payload includes a Continue Watching rail for the seeded progress',
    payload.rails.some((rail) => rail.key === 'continue_watching' && rail.items.length > 0),
  );
  check('home payload has a featured drama', payload.featured !== null);
  check(
    'every rail has at least one item (empty rails are omitted)',
    payload.rails.every((rail) => rail.items.length > 0),
  );
}

// ──────────────────────────── Playback tickets ───────────────────────────

section('Playback tickets');

{
  const api = await import(pathToFileURL(resolve(MOBILE, 'services/mock-api.ts')).href);
  const library = { favoriteIds: [], progress: [], watchStates: {} };

  const firstDrama = MOCK_CATALOGUE.dramas[0];
  const episodes = MOCK_CATALOGUE.episodesByDrama.get(firstDrama.id) ?? [];
  const freeEpisode = episodes.find((episode) => !episode.isLocked);
  const lockedEpisode = episodes.find((episode) => episode.isLocked);

  const ticket = await api.requestPlaybackTicket(freeEpisode.id, library);
  check('a free episode yields a playback ticket', typeof ticket.playbackUrl === 'string');
  check(
    '  ...pointing at an HLS master playlist',
    ticket.playbackUrl.endsWith('/master.m3u8'),
    ticket.playbackUrl,
  );
  check('  ...with an expiry in the future', new Date(ticket.expiresAt).getTime() > Date.now());
  check(
    '  ...and a next-episode id',
    ticket.nextEpisodeId !== null || freeEpisode.episodeNumber === episodes.length,
  );

  let refused = null;
  try {
    await api.requestPlaybackTicket(lockedEpisode.id, library);
  } catch (error) {
    refused = error;
  }
  check('a locked episode is refused, not served', refused !== null);
  check('  ...with EPISODE_LOCKED', refused?.code === 'EPISODE_LOCKED');
  check(
    '  ...carrying the unlock options',
    Array.isArray(refused?.locked?.unlockOptions) && refused.locked.unlockOptions.length > 0,
  );
}

// ──────────────────────────────── Result ─────────────────────────────────

process.stdout.write(
  `\n${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} FAILED` : ''}\n`,
);
process.exit(failures > 0 ? 1 : 0);
