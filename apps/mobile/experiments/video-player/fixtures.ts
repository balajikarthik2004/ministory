import type { TestEpisode } from './types';

/**
 * Loads the HLS fixture manifest produced by tools/video-fixtures/generate.mjs
 * and served by tools/video-fixtures/serve.mjs.
 *
 * Edit DEFAULT_BASE_URL to your machine's LAN address, or override it in the
 * spike screen. `serve.mjs` prints the correct value when it starts.
 */

/**
 * Defaults to the USB tunnel created by `adb reverse tcp:8787 tcp:8787`.
 * That path avoids Wi-Fi and firewall entirely, so a failed fetch means the
 * fixture server is down rather than the network being in the way.
 *
 * Without adb reverse, replace this with the LAN address that serve.mjs prints.
 */
export const DEFAULT_BASE_URL = 'http://10.251.177.203:8787';

interface ManifestEntry {
  id: string;
  label: string;
  width: number;
  height: number;
  bitrate: string;
  durationSeconds: number;
  toneHz: number;
  master: string;
  video: string;
}

interface Manifest {
  generatedAt: string;
  episodes: ManifestEntry[];
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { episodes?: unknown };
  return Array.isArray(candidate.episodes);
}

export class FixtureLoadError extends Error {}

/**
 * @param baseUrl       root of the fixture server, no trailing slash
 * @param useSubtitles  master.m3u8 carries the WebVTT rendition; video.m3u8
 *                      does not. Both are generated so subtitle handling can
 *                      be measured with and without.
 */
export async function loadEpisodes(baseUrl: string, useSubtitles = true): Promise<TestEpisode[]> {
  const root = baseUrl.replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetch(`${root}/manifest.json`);
  } catch (cause) {
    throw new FixtureLoadError(
      `Could not reach ${root}. Check that serve.mjs is running, that the phone is on the same Wi-Fi, and that the firewall allows the port.`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new FixtureLoadError(`Fixture server returned ${response.status} for /manifest.json`);
  }

  const payload: unknown = await response.json();
  if (!isManifest(payload)) {
    throw new FixtureLoadError(
      'manifest.json is not in the expected shape. Regenerate the fixtures.',
    );
  }

  return payload.episodes.map((entry) => ({
    id: entry.id,
    label: entry.label,
    width: entry.width,
    height: entry.height,
    bitrate: entry.bitrate,
    durationSeconds: entry.durationSeconds,
    toneHz: entry.toneHz,
    url: `${root}/${useSubtitles ? entry.master : entry.video}`,
  }));
}

/**
 * Repeats the five fixtures until there are at least `minimum` entries, so a
 * 30-swipe run has somewhere to swipe to. IDs stay unique per position -
 * reusing an ID would make the pool think it already has that episode loaded
 * and silently skip the reload the test is trying to measure.
 */
export function buildPlaylist(episodes: readonly TestEpisode[], minimum: number): TestEpisode[] {
  if (episodes.length === 0) return [];
  const playlist: TestEpisode[] = [];
  for (let index = 0; index < Math.max(minimum, episodes.length); index += 1) {
    const source = episodes[index % episodes.length];
    if (!source) continue;
    playlist.push({ ...source, id: `${source.id}#${index}` });
  }
  return playlist;
}
