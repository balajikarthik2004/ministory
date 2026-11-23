/**
 * The ABR fixture episode specification.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Two things need to agree about how long each fixture episode is:
 *
 *   1. `tools/video-fixtures/generate-abr.mjs`, which encodes the media and
 *      writes `out-abr/manifest.json`.
 *   2. `apps/mobile/data/catalogue.mock.ts` (`FIXTURES`), which tells the app
 *      how long each episode is.
 *
 * When those disagree the failure is nasty and specific: the catalogue once
 * reported invented 88-112s durations while serving 20-90s media, so a seeded
 * resume position landed past the end of the file and the player hit
 * `playToEnd` on load.
 *
 * `tools/verify-mock-catalogue.mjs` exists to catch exactly that. It used to
 * compare the mock against `out-abr/manifest.json` — which is a *generated*
 * artifact, gitignored, 146 MB of encoded video alongside it, and therefore
 * absent on any clean checkout. The check could only ever run on a machine
 * that had already generated the fixtures, and it failed outright in CI.
 *
 * Extracting the specification fixes that properly rather than by weakening
 * the check. The manifest's `durationSeconds` was never measured from the
 * encoded output — `generate-abr.mjs` copies it straight from this table — so
 * comparing the mock against this file verifies precisely the same
 * relationship, and now verifies it on every run instead of only on a machine
 * with 146 MB of fixtures on disk.
 *
 * The generated manifest is still checked against this table when it happens
 * to be present, so a stale `out-abr/` left over from an older generator run
 * is still caught locally.
 *
 * THIS FILE IS THE SOURCE OF TRUTH. Changing a duration here means
 * regenerating the fixtures and updating `FIXTURES` in the mock catalogue;
 * the verifier will fail until both agree.
 */

/**
 * @typedef {object} AbrEpisodeSpec
 * @property {string} id            Fixture directory name, e.g. `ep01`.
 * @property {string} label         Burned into the video for visual identification.
 * @property {number} duration      Seconds. Must match `FIXTURES[].durationSec`.
 * @property {number} tone          Audio test-tone frequency in Hz, unique per episode
 *                                  so the right stream is audible during manual testing.
 */

/** @type {readonly AbrEpisodeSpec[]} */
export const ABR_EPISODES = [
  { id: 'ep01', label: 'Ep 1 - ABR ladder', duration: 30, tone: 440 },
  { id: 'ep02', label: 'Ep 2 - ABR ladder', duration: 45, tone: 554 },
  { id: 'ep03', label: 'Ep 3 - ABR ladder', duration: 20, tone: 659 },
  { id: 'ep04', label: 'Ep 4 - ABR ladder', duration: 60, tone: 880 },
  { id: 'ep05', label: 'Ep 5 - ABR ladder', duration: 90, tone: 988 },
];
