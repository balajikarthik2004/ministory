#!/usr/bin/env node
/**
 * Validates the multi-variant ABR fixtures produced by generate-abr.mjs.
 *
 * An ABR ladder that looks fine in a directory listing can still be unplayable
 * or unswitchable. These checks target the failure modes that actually matter:
 *
 *   1  every variant decodes, with the expected codec and resolution
 *   2  all renditions have the same segment count
 *   3  KEYFRAMES ALIGN across renditions  <- the one that breaks ABR switching
 *   4  segment durations align
 *   5  master playlist is well formed and variants ascend by bandwidth
 *   6  measured bitrate is within tolerance of target
 *   7  every file serves correctly over HTTP (optional, needs --base-url)
 *
 * Exits non-zero if any check fails.
 *
 * Usage:
 *   node tools/video-fixtures/validate-abr.mjs [--dir <path>] [--base-url http://127.0.0.1:8787]
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : (args[i + 1] ?? d);
};

const DIR = path.resolve(flag('dir', 'tools/video-fixtures/out-abr'));
const BASE_URL = flag('base-url', null);
/** Encoded output is allowed to exceed target by this much. TS packetisation
 *  alone adds ~4-5%, and x264 overshoots a little at constant rate. */
const BITRATE_TOLERANCE = 0.2;

let failures = 0;
let checks = 0;

function ok(msg) {
  checks += 1;
  process.stdout.write(`  PASS  ${msg}\n`);
}
function fail(msg) {
  checks += 1;
  failures += 1;
  process.stdout.write(`  FAIL  ${msg}\n`);
}

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-1500)))));
  });
}

async function parsePlaylist(file) {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n').map((l) => l.trim());
  const segments = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i] ?? '');
    if (!m) continue;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) continue;
    segments.push({ uri, duration: Number.parseFloat(m[1]) });
  }
  return { text, lines, segments };
}

/** Keyframe presentation timestamps for a variant, via ffprobe. */
async function keyframeTimes(playlistPath) {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-skip_frame',
    'nokey',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    playlistPath,
  ]);
  return out
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter(Boolean)
    .map((v) => Number.parseFloat(v))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.round(v * 1000) / 1000);
}

function parseMaster(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrText = lines[i].slice('#EXT-X-STREAM-INF:'.length);
    const attrs = {};
    for (const part of attrText.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
      const eq = part.indexOf('=');
      if (eq > 0)
        attrs[part.slice(0, eq).trim()] = part
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, '');
    }
    variants.push({ attrs, uri: lines[i + 1] });
  }
  return { lines, variants };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(DIR, 'manifest.json'), 'utf8'));
  process.stdout.write(`\nValidating ${manifest.episodes.length} episodes in ${DIR}\n`);
  process.stdout.write(`Ladder: ${manifest.ladder.map((r) => r.name).join(', ')}\n`);

  for (const episode of manifest.episodes) {
    const epDir = path.join(DIR, episode.id);
    process.stdout.write(`\n=== ${episode.id} (${episode.durationSeconds}s) ===\n`);

    // ── 5. master playlist structure ──────────────────────────────────
    const masterText = await readFile(path.join(epDir, 'master.m3u8'), 'utf8');
    const { variants } = parseMaster(masterText);

    if (variants.length === manifest.ladder.length)
      ok(`master declares ${variants.length} variants`);
    else fail(`master declares ${variants.length} variants, expected ${manifest.ladder.length}`);

    let ascending = true;
    for (let i = 1; i < variants.length; i += 1) {
      if (Number(variants[i].attrs.BANDWIDTH) <= Number(variants[i - 1].attrs.BANDWIDTH))
        ascending = false;
    }
    ascending ? ok('variants ascend by BANDWIDTH') : fail('variants do not ascend by BANDWIDTH');

    for (const v of variants) {
      const missing = ['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'RESOLUTION', 'CODECS'].filter(
        (a) => !v.attrs[a],
      );
      if (missing.length) fail(`variant ${v.uri} missing ${missing.join(', ')}`);
    }
    if (
      variants.every(
        (v) =>
          v.attrs.BANDWIDTH && v.attrs['AVERAGE-BANDWIDTH'] && v.attrs.RESOLUTION && v.attrs.CODECS,
      )
    ) {
      ok('every variant carries BANDWIDTH, AVERAGE-BANDWIDTH, RESOLUTION, CODECS');
    }

    if (masterText.includes('#EXT-X-INDEPENDENT-SEGMENTS'))
      ok('EXT-X-INDEPENDENT-SEGMENTS present');
    else fail('EXT-X-INDEPENDENT-SEGMENTS missing');

    // Playlist entries are URIs, not filesystem paths. FFmpeg on Windows
    // writes "v0\playlist.m3u8", which a Windows origin may resolve by
    // accident while any real CDN will not.
    const backslashed = variants.filter((v) => (v.uri ?? '').includes('\\'));
    backslashed.length === 0
      ? ok('variant URIs use forward slashes')
      : fail(`${backslashed.length} variant URI(s) contain a backslash: ${backslashed[0].uri}`);

    // Per-variant checks
    const segmentCounts = [];
    const extinfSets = [];
    const keyframeSets = [];

    for (let i = 0; i < manifest.ladder.length; i += 1) {
      const rung = manifest.ladder[i];
      const variantDir = path.join(epDir, `v${i}`);
      const playlistPath = path.join(variantDir, 'playlist.m3u8');

      // ── 1. decodes with expected codec + resolution ─────────────────
      const probe = await run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type,width,height:format=duration',
        '-of',
        'json',
        playlistPath,
      ]);
      const parsed = JSON.parse(probe);
      const video = parsed.streams.find((s) => s.codec_type === 'video');
      const audio = parsed.streams.find((s) => s.codec_type === 'audio');

      if (video?.codec_name === 'h264' && audio?.codec_name === 'aac')
        ok(`${rung.name}: h264 + aac`);
      else fail(`${rung.name}: unexpected codecs ${video?.codec_name}/${audio?.codec_name}`);

      if (video?.width === rung.width && video?.height === rung.height) {
        ok(`${rung.name}: ${video.width}x${video.height} as specified`);
      } else {
        fail(
          `${rung.name}: got ${video?.width}x${video?.height}, expected ${rung.width}x${rung.height}`,
        );
      }

      const probedDuration = Number.parseFloat(parsed.format?.duration ?? '0');
      if (Math.abs(probedDuration - episode.durationSeconds) <= 1.0) {
        ok(`${rung.name}: duration ${probedDuration.toFixed(2)}s`);
      } else {
        fail(
          `${rung.name}: duration ${probedDuration.toFixed(2)}s, expected ~${episode.durationSeconds}s`,
        );
      }

      // ── 6. measured bitrate within tolerance ────────────────────────
      const measured = episode.renditions[i];
      const ratio = measured.measuredAverageBandwidth / measured.targetTotalBitsPerSec;
      if (ratio <= 1 + BITRATE_TOLERANCE && ratio >= 1 - BITRATE_TOLERANCE) {
        ok(
          `${rung.name}: measured avg ${Math.round(measured.measuredAverageBandwidth / 1000)}k ` +
            `vs target ${Math.round(measured.targetTotalBitsPerSec / 1000)}k (${((ratio - 1) * 100).toFixed(1)}%)`,
        );
      } else {
        fail(
          `${rung.name}: measured avg ${Math.round(measured.measuredAverageBandwidth / 1000)}k ` +
            `is ${((ratio - 1) * 100).toFixed(1)}% from target - outside ±${BITRATE_TOLERANCE * 100}%`,
        );
      }

      // peak must be >= average, by definition
      if (measured.measuredBandwidth >= measured.measuredAverageBandwidth) {
        ok(`${rung.name}: BANDWIDTH >= AVERAGE-BANDWIDTH`);
      } else {
        fail(`${rung.name}: BANDWIDTH < AVERAGE-BANDWIDTH - measurement is wrong`);
      }

      const { segments } = await parsePlaylist(playlistPath);
      segmentCounts.push(segments.length);
      extinfSets.push(segments.map((s) => Math.round(s.duration * 1000)));

      // every segment file exists and is non-empty
      let emptySegments = 0;
      for (const s of segments) {
        const st = await stat(path.join(variantDir, s.uri)).catch(() => null);
        if (!st || st.size === 0) emptySegments += 1;
      }
      emptySegments === 0
        ? ok(`${rung.name}: all ${segments.length} segments present and non-empty`)
        : fail(`${rung.name}: ${emptySegments} missing or empty segments`);

      keyframeSets.push(await keyframeTimes(playlistPath));
    }

    // ── 2. segment counts match ───────────────────────────────────────
    new Set(segmentCounts).size === 1
      ? ok(`segment count identical across renditions (${segmentCounts[0]})`)
      : fail(`segment counts differ across renditions: ${segmentCounts.join(', ')}`);

    // ── 4. segment durations align ────────────────────────────────────
    const extinfRef = JSON.stringify(extinfSets[0]);
    extinfSets.every((s) => JSON.stringify(s) === extinfRef)
      ? ok('EXTINF durations identical across renditions')
      : fail('EXTINF durations differ across renditions - segment boundaries do not align');

    // ── 3. KEYFRAME ALIGNMENT ─────────────────────────────────────────
    const kfRef = keyframeSets[0];
    let kfAligned = true;
    let kfDetail = '';
    for (let i = 1; i < keyframeSets.length; i += 1) {
      const a = keyframeSets[i];
      if (a.length !== kfRef.length) {
        kfAligned = false;
        kfDetail = `rendition ${i} has ${a.length} keyframes vs ${kfRef.length}`;
        break;
      }
      for (let k = 0; k < a.length; k += 1) {
        if (Math.abs(a[k] - kfRef[k]) > 0.005) {
          kfAligned = false;
          kfDetail = `rendition ${i} keyframe ${k} at ${a[k]}s vs ${kfRef[k]}s`;
          break;
        }
      }
      if (!kfAligned) break;
    }
    kfAligned
      ? ok(`keyframes aligned across all renditions (${kfRef.length} per rendition)`)
      : fail(`KEYFRAMES NOT ALIGNED - ABR switching will glitch: ${kfDetail}`);

    // ── 7. HTTP serving ───────────────────────────────────────────────
    if (BASE_URL) {
      const probes = [
        { url: `${BASE_URL}/${episode.master}`, type: 'application/vnd.apple.mpegurl' },
        {
          url: `${BASE_URL}/${episode.id}/v0/playlist.m3u8`,
          type: 'application/vnd.apple.mpegurl',
        },
        { url: `${BASE_URL}/${episode.id}/v0/segment000.ts`, type: 'video/mp2t' },
        { url: `${BASE_URL}/${episode.id}/subtitles.vtt`, type: 'text/vtt' },
      ];
      // Fetch the URIs the MASTER actually declares, resolved relative to it -
      // not URLs the validator builds for itself. A playlist that only works
      // against hand-made URLs is not a playlist that works.
      for (const v of variants) {
        const declared = `${BASE_URL}/${episode.id}/${v.uri}`;
        try {
          const res = await fetch(declared);
          if (!res.ok) fail(`master-declared URI not fetchable: ${declared} -> ${res.status}`);
          await res.arrayBuffer();
        } catch (e) {
          fail(`master-declared URI not fetchable: ${declared} -> ${e.message}`);
        }
      }

      let httpOk = true;
      for (const p of probes) {
        try {
          const res = await fetch(p.url);
          const ct = (res.headers.get('content-type') ?? '').split(';')[0];
          if (!res.ok || ct !== p.type) {
            httpOk = false;
            fail(`HTTP ${p.url} -> ${res.status} ${ct}`);
          }
          await res.arrayBuffer();
        } catch (e) {
          httpOk = false;
          fail(`HTTP ${p.url} -> ${e.message}`);
        }
      }
      if (httpOk) ok('served over HTTP with correct content types');
    }
  }

  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`${checks - failures}/${checks} checks passed`);
  process.stdout.write(failures === 0 ? '  — ALL VALID\n\n' : `  — ${failures} FAILURE(S)\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`\nValidation error: ${e.message}\n\n`);
  process.exit(1);
});
