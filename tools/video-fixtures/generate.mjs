#!/usr/bin/env node
/**
 * Generates five local HLS test streams for the M1.2 video player spike.
 *
 * Free and open-source only (CLAUDE.md §18): FFmpeg generates everything from
 * synthetic sources. No sample footage is downloaded, nothing is hosted.
 *
 * Why synthetic test patterns rather than real video:
 *   - `testsrc2` renders a frame counter and a moving pattern, so a dropped or
 *     black frame is visible rather than inferred.
 *   - Each episode gets a DIFFERENT audio tone. Overlapping audio is then
 *     audible as a chord instead of something you have to squint at a log for.
 *   - Each episode gets a different solid background colour, so "the wrong
 *     episode is on screen" is obvious at a glance during a fast swipe.
 *
 * Usage:  node tools/video-fixtures/generate.mjs [--out <dir>] [--force]
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT_DIR = path.resolve(
  outFlag !== -1 && args[outFlag + 1] ? args[outFlag + 1] : 'tools/video-fixtures/out',
);
const FORCE = args.includes('--force');

/**
 * Five episodes spanning the range a real short-drama catalogue would have.
 * Durations are deliberately short for episodes 3 and 5 so a 30-swipe run does
 * not take ten minutes, and long for episode 5 so the soak test has something
 * to chew on.
 */
const EPISODES = [
  {
    id: 'ep01',
    label: 'Ep 1 - 1080p high',
    width: 1080,
    height: 1920,
    bitrate: '2500k',
    duration: 30,
    tone: 440,
    color: '0x1D202B',
  },
  {
    id: 'ep02',
    label: 'Ep 2 - 720p mid',
    width: 720,
    height: 1280,
    bitrate: '1200k',
    duration: 45,
    tone: 554,
    color: '0x2B1D20',
  },
  {
    id: 'ep03',
    label: 'Ep 3 - 540p low',
    width: 540,
    height: 960,
    bitrate: '800k',
    duration: 20,
    tone: 659,
    color: '0x1D2B22',
  },
  {
    id: 'ep04',
    label: 'Ep 4 - 1080p very high',
    width: 1080,
    height: 1920,
    bitrate: '4000k',
    duration: 60,
    tone: 880,
    color: '0x2B2A1D',
  },
  {
    id: 'ep05',
    label: 'Ep 5 - 480p long',
    width: 480,
    height: 854,
    bitrate: '500k',
    duration: 90,
    tone: 988,
    color: '0x221D2B',
  },
];

const HLS_SEGMENT_SECONDS = 2;

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

async function hasFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** A WebVTT track that names the episode and counts seconds, so you can tell
 *  at a glance whether subtitles belong to the episode actually on screen. */
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

function formatTimestamp(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}.000`;
}

/**
 * Master playlist wiring the video rendition to its WebVTT subtitle rendition.
 * Written by hand because FFmpeg's HLS muxer does not emit a master playlist
 * with an EXT-X-MEDIA subtitle group.
 */
function buildMasterPlaylist(episode) {
  const bandwidth = Number.parseInt(episode.bitrate, 10) * 1000;
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="en",URI="subtitles.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${episode.width}x${episode.height},SUBTITLES="subs"`,
    'video.m3u8',
    '',
  ].join('\n');
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

async function generateEpisode(episode) {
  const dir = path.join(OUT_DIR, episode.id);
  await mkdir(dir, { recursive: true });

  // testsrc2 gives a frame counter and motion; the colour source tints it so
  // each episode is instantly distinguishable mid-swipe.
  const videoFilter = `testsrc2=size=${episode.width}x${episode.height}:rate=30:duration=${episode.duration}`;
  const audioFilter = `sine=frequency=${episode.tone}:duration=${episode.duration}`;

  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    videoFilter,
    '-f',
    'lavfi',
    '-i',
    audioFilter,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-b:v',
    episode.bitrate,
    '-maxrate',
    episode.bitrate,
    '-bufsize',
    `${Number.parseInt(episode.bitrate, 10) * 2}k`,
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    String(HLS_SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(dir, 'segment%03d.ts'),
    path.join(dir, 'video.m3u8'),
  ]);

  await writeFile(path.join(dir, 'subtitles.vtt'), buildVtt(episode), 'utf8');
  await writeFile(path.join(dir, 'subtitles.m3u8'), buildSubtitlePlaylist(episode), 'utf8');
  await writeFile(path.join(dir, 'master.m3u8'), buildMasterPlaylist(episode), 'utf8');

  return {
    id: episode.id,
    label: episode.label,
    width: episode.width,
    height: episode.height,
    bitrate: episode.bitrate,
    durationSeconds: episode.duration,
    toneHz: episode.tone,
    master: `${episode.id}/master.m3u8`,
    video: `${episode.id}/video.m3u8`,
  };
}

async function main() {
  if (!(await hasFfmpeg())) {
    process.stderr.write(
      '\nFFmpeg was not found on PATH.\n\n' +
        'It is free and open source. Install it, then re-run this script:\n\n' +
        '  Windows   winget install Gyan.FFmpeg\n' +
        '  macOS     brew install ffmpeg\n' +
        '  Linux     sudo apt install ffmpeg\n\n' +
        'Open a NEW terminal afterwards so PATH refreshes.\n\n',
    );
    process.exit(1);
  }

  const exists = await access(OUT_DIR).then(
    () => true,
    () => false,
  );
  if (exists) {
    if (!FORCE) {
      process.stdout.write(`${OUT_DIR} already exists. Re-run with --force to regenerate.\n`);
      process.exit(0);
    }
    await rm(OUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUT_DIR, { recursive: true });

  process.stdout.write(`Generating ${EPISODES.length} HLS test streams into ${OUT_DIR}\n\n`);

  const manifest = [];
  for (const episode of EPISODES) {
    process.stdout.write(`  ${episode.id}  ${episode.label} ... `);
    const entry = await generateEpisode(episode);
    manifest.push(entry);
    process.stdout.write('done\n');
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), episodes: manifest }, null, 2)}\n`,
    'utf8',
  );

  process.stdout.write(`\nWrote manifest.json\n\nNext: node tools/video-fixtures/serve.mjs\n\n`);
}

main().catch((error) => {
  process.stderr.write(`\nGeneration failed: ${error.message}\n\n`);
  process.exit(1);
});
