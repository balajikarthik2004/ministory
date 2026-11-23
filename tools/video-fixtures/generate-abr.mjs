#!/usr/bin/env node
/**
 * Generates MULTI-VARIANT (ABR) HLS test fixtures for M1.3.
 *
 * Separate from generate.mjs, which produces the single-variant fixtures used
 * by the M1.2 benchmark series. That generator and its output are untouched so
 * the earlier results stay reproducible.
 *
 * Free and open-source only (CLAUDE.md §18): FFmpeg encodes everything from a
 * synthetic source. Nothing is downloaded, nothing is hosted externally.
 *
 * ──────────────────────── WHY IT IS BUILT THIS WAY ────────────────────────
 *
 * One source, four renditions, one encoder pass. Encoding each rendition in a
 * separate pass would let their keyframes drift apart, and an ABR player can
 * only switch cleanly at a segment boundary that is an IDR in BOTH renditions.
 * Alignment therefore comes from three things applied together:
 *
 *   -g 60 / -keyint_min 60   fixed 2-second GOP at 30fps
 *   -sc_threshold 0          scene detection cannot insert extra keyframes
 *   -force_key_frames        IDR pinned to exact 2-second boundaries
 *   -hls_flags independent_segments  declares every segment starts on an IDR
 *
 * BANDWIDTH metadata is MEASURED, not copied from the encoder targets.
 * FFmpeg writes the target bitrate into the master playlist; a constant-rate
 * encoder never hits its target exactly, and RFC 8216 defines BANDWIDTH as the
 * observed peak segment bit rate. We therefore let FFmpeg write the master
 * (it derives the CODECS string correctly from the real encoder settings) and
 * then rewrite ONLY the bandwidth attributes from the encoded bytes on disk.
 *
 * Usage:  node tools/video-fixtures/generate-abr.mjs [--out <dir>] [--force]
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ABR_EPISODES } from './episodes.abr.mjs';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT_DIR = path.resolve(
  outFlag !== -1 && args[outFlag + 1] ? args[outFlag + 1] : 'tools/video-fixtures/out-abr',
);
const FORCE = args.includes('--force');
/** Re-measure and rewrite master playlists from the encoded output already on
 *  disk, without re-encoding. */
const MASTERS_ONLY = args.includes('--masters-only');

const SEGMENT_SECONDS = 2;
const FRAME_RATE = 30;
const SOURCE_WIDTH = 1080;
const SOURCE_HEIGHT = 1920;

/**
 * The rendition ladder. 9:16 vertical, every dimension even (H.264 requires it
 * for 4:2:0 chroma).
 *
 * Targets are TOTAL stream bandwidth (video + audio), which is what HLS
 * BANDWIDTH means. Video is set below the target so the audio makes up the
 * remainder.
 */
const LADDER = [
  { name: '360p', width: 360, height: 640, videoKbps: 290, audioKbps: 64, targetTotalKbps: 354 },
  { name: '480p', width: 480, height: 854, videoKbps: 550, audioKbps: 96, targetTotalKbps: 646 },
  {
    name: '720p',
    width: 720,
    height: 1280,
    videoKbps: 1070,
    audioKbps: 128,
    targetTotalKbps: 1198,
  },
  {
    name: '1080p',
    width: 1080,
    height: 1920,
    videoKbps: 2370,
    audioKbps: 128,
    targetTotalKbps: 2498,
  },
];

/**
 * Same five episodes as the single-variant fixtures: identical ids, labels,
 * durations and audio tones, so episode identity is not a new variable in the
 * ABR-vs-single-variant comparison. Only the encoding ladder differs.
 */
/**
 * The episode specification now lives in `episodes.abr.mjs` so that
 * `tools/verify-mock-catalogue.mjs` can compare the mock catalogue's
 * durations against it without importing this module — which would run
 * ffmpeg, since `main()` is invoked at the bottom of this file.
 *
 * Same values as before, one source of truth instead of two.
 */
const EPISODES = ABR_EPISODES;

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2500)}`)),
    );
  });
}

async function hasBinary(name) {
  try {
    await run(name, ['-version']);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  return `${h}:${m}:${s}.000`;
}

function buildVtt(episode) {
  const lines = ['WEBVTT', ''];
  for (let second = 0; second < episode.duration; second += 5) {
    const end = Math.min(second + 5, episode.duration);
    lines.push(
      `${formatTimestamp(second)} --> ${formatTimestamp(end)}`,
      `${episode.label} - ${second}s`,
      '',
    );
  }
  return lines.join('\n');
}

function buildSubtitlePlaylist(episode) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${episode.duration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${episode.duration}.000,`,
    'subtitles.vtt',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

/** Encodes all four renditions in a single pass with aligned keyframes. */
async function encodeEpisode(episode, dir) {
  const splitLabels = LADDER.map((_, i) => `[s${i}]`).join('');
  const scales = LADDER.map(
    (r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic[v${i}]`,
  ).join(';');
  const filterComplex = `[0:v]split=${LADDER.length}${splitLabels};${scales}`;

  const ffArgs = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:rate=${FRAME_RATE}:duration=${episode.duration}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${episode.tone}:duration=${episode.duration}`,
    '-filter_complex',
    filterComplex,
  ];

  for (let i = 0; i < LADDER.length; i += 1) {
    ffArgs.push('-map', `[v${i}]`, '-map', '1:a');
  }

  ffArgs.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
  );

  LADDER.forEach((r, i) => {
    ffArgs.push(
      `-b:v:${i}`,
      `${r.videoKbps}k`,
      `-maxrate:v:${i}`,
      `${Math.round(r.videoKbps * 1.1)}k`,
      `-bufsize:v:${i}`,
      `${r.videoKbps * 2}k`,
    );
  });

  ffArgs.push('-c:a', 'aac', '-ac', '2');
  LADDER.forEach((r, i) => ffArgs.push(`-b:a:${i}`, `${r.audioKbps}k`));

  // Keyframe alignment - the part that makes ABR switching clean.
  ffArgs.push(
    '-g',
    String(SEGMENT_SECONDS * FRAME_RATE),
    '-keyint_min',
    String(SEGMENT_SECONDS * FRAME_RATE),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
  );

  ffArgs.push(
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-var_stream_map',
    LADDER.map((_, i) => `v:${i},a:${i}`).join(' '),
    '-master_pl_name',
    'master.m3u8',
    '-hls_segment_filename',
    path.join(dir, 'v%v', 'segment%03d.ts'),
    path.join(dir, 'v%v', 'playlist.m3u8'),
  );

  await run('ffmpeg', ffArgs);
}

/**
 * Measures a rendition from the bytes actually written.
 *
 * RFC 8216:
 *   BANDWIDTH          peak segment bit rate = max(segment bits / its EXTINF)
 *   AVERAGE-BANDWIDTH  total bits / total duration
 *
 * Segments are muxed, so their size already includes audio.
 */
async function measureRendition(variantDir) {
  const playlist = await readFile(path.join(variantDir, 'playlist.m3u8'), 'utf8');
  const lines = playlist.split('\n').map((l) => l.trim());

  const segments = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^#EXTINF:([\d.]+)/.exec(lines[i] ?? '');
    if (!match) continue;
    const durationSec = Number.parseFloat(match[1]);
    const file = lines[i + 1];
    if (!file || file.startsWith('#')) continue;
    const { size } = await stat(path.join(variantDir, file));
    segments.push({ file, durationSec, bytes: size });
  }

  if (segments.length === 0) throw new Error(`no segments found in ${variantDir}`);

  const totalBytes = segments.reduce((s, x) => s + x.bytes, 0);
  const totalSec = segments.reduce((s, x) => s + x.durationSec, 0);

  const peakBitsPerSec = Math.max(
    ...segments.map((s) => (s.durationSec > 0 ? (s.bytes * 8) / s.durationSec : 0)),
  );
  const averageBitsPerSec = (totalBytes * 8) / totalSec;

  return {
    segments: segments.length,
    totalBytes,
    totalSec: Number(totalSec.toFixed(3)),
    bandwidth: Math.round(peakBitsPerSec),
    averageBandwidth: Math.round(averageBitsPerSec),
    extinf: segments.map((s) => s.durationSec),
  };
}

/**
 * Rewrites the master playlist with measured bandwidths.
 *
 * FFmpeg's CODECS and RESOLUTION attributes are preserved verbatim - FFmpeg
 * derives CODECS from the real encoder configuration, and a hand-built codec
 * string with a wrong constraint byte can make a player silently skip a
 * variant. Only BANDWIDTH / AVERAGE-BANDWIDTH are replaced, and the subtitle
 * group is attached.
 */
async function rewriteMaster(dir, measurements) {
  const masterPath = path.join(dir, 'master.m3u8');
  const original = (await readFile(masterPath, 'utf8')).split('\n');

  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  out.push(
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,' +
      'AUTOSELECT=NO,FORCED=NO,LANGUAGE="en",URI="subtitles.m3u8"',
  );

  let variantIndex = 0;
  for (let i = 0; i < original.length; i += 1) {
    const line = (original[i] ?? '').trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    // FFmpeg on Windows writes the OS path separator into the playlist
    // ("v0\playlist.m3u8"). Playlist entries are URIs, not paths: RFC 8216
    // requires forward slashes, and a backslash breaks any non-Windows
    // origin or CDN. Normalise it.
    const uri = (original[i + 1] ?? '').trim().replace(/\\/g, '/');
    if (!uri || uri.startsWith('#')) continue;

    const measured = measurements[variantIndex];
    if (!measured) break;

    // Keep every attribute FFmpeg emitted except the two we measured.
    const attrs =
      line
        .slice('#EXT-X-STREAM-INF:'.length)
        .match(/(?:[^,"]|"[^"]*")+/g)
        ?.map((a) => a.trim())
        .filter((a) => !/^BANDWIDTH=/.test(a) && !/^AVERAGE-BANDWIDTH=/.test(a)) ?? [];

    attrs.unshift(`AVERAGE-BANDWIDTH=${measured.averageBandwidth}`);
    attrs.unshift(`BANDWIDTH=${measured.bandwidth}`);
    if (!attrs.some((a) => a.startsWith('FRAME-RATE=')))
      attrs.push(`FRAME-RATE=${FRAME_RATE.toFixed(3)}`);
    attrs.push('SUBTITLES="subs"');

    out.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, uri);
    variantIndex += 1;
  }

  if (variantIndex !== LADDER.length) {
    throw new Error(`expected ${LADDER.length} variants in master, rewrote ${variantIndex}`);
  }

  out.push('');
  await writeFile(masterPath, out.join('\n'), 'utf8');
}

async function generateEpisode(episode) {
  const dir = path.join(OUT_DIR, episode.id);
  await mkdir(dir, { recursive: true });

  if (!MASTERS_ONLY) await encodeEpisode(episode, dir);

  const measurements = [];
  for (let i = 0; i < LADDER.length; i += 1) {
    measurements.push(await measureRendition(path.join(dir, `v${i}`)));
  }

  await rewriteMaster(dir, measurements);

  await writeFile(path.join(dir, 'subtitles.vtt'), buildVtt(episode), 'utf8');
  await writeFile(path.join(dir, 'subtitles.m3u8'), buildSubtitlePlaylist(episode), 'utf8');

  return {
    id: episode.id,
    label: episode.label,
    // Top rendition, so the manifest shape stays compatible with the harness.
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
    bitrate: `${LADDER[0].targetTotalKbps}k-${LADDER.at(-1).targetTotalKbps}k`,
    durationSeconds: episode.duration,
    toneHz: episode.tone,
    master: `${episode.id}/master.m3u8`,
    // Single-variant fallback path, top rendition.
    video: `${episode.id}/v${LADDER.length - 1}/playlist.m3u8`,
    renditions: LADDER.map((r, i) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      targetTotalBitsPerSec: r.targetTotalKbps * 1000,
      measuredBandwidth: measurements[i].bandwidth,
      measuredAverageBandwidth: measurements[i].averageBandwidth,
      segments: measurements[i].segments,
      totalBytes: measurements[i].totalBytes,
    })),
  };
}

async function main() {
  if (!(await hasBinary('ffmpeg')) || !(await hasBinary('ffprobe'))) {
    process.stderr.write(
      '\nFFmpeg and FFprobe must be on PATH.\n  Windows: winget install Gyan.FFmpeg\n\n',
    );
    process.exit(1);
  }

  const exists = await access(OUT_DIR).then(
    () => true,
    () => false,
  );
  if (exists && MASTERS_ONLY) {
    process.stdout.write('Re-measuring and rewriting master playlists only (no re-encode).\n\n');
  } else if (exists) {
    if (!FORCE) {
      process.stdout.write(`${OUT_DIR} already exists. Re-run with --force to regenerate.\n`);
      process.exit(0);
    }
    await rm(OUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUT_DIR, { recursive: true });

  process.stdout.write(
    `Generating ${EPISODES.length} multi-variant HLS episodes (${LADDER.length} renditions each)\n` +
      `into ${OUT_DIR}\n\n`,
  );

  const manifest = [];
  for (const episode of EPISODES) {
    process.stdout.write(`  ${episode.id} (${episode.duration}s) ... `);
    const entry = await generateEpisode(episode);
    manifest.push(entry);
    process.stdout.write('done\n');
    for (const r of entry.renditions) {
      process.stdout.write(
        `      ${r.name.padEnd(6)} ${String(r.width).padStart(4)}x${r.height}  ` +
          `target ${String(Math.round(r.targetTotalBitsPerSec / 1000)).padStart(4)}k  ` +
          `measured avg ${String(Math.round(r.measuredAverageBandwidth / 1000)).padStart(4)}k  ` +
          `peak ${String(Math.round(r.measuredBandwidth / 1000)).padStart(4)}k  ` +
          `${r.segments} segs\n`,
      );
    }
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: 'abr-multi-variant',
        ladder: LADDER,
        segmentSeconds: SEGMENT_SECONDS,
        frameRate: FRAME_RATE,
        episodes: manifest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  process.stdout.write(
    `\nWrote manifest.json\nNext: node tools/video-fixtures/validate-abr.mjs\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\nGeneration failed: ${error.message}\n\n`);
  process.exit(1);
});
