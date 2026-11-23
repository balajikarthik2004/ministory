#!/usr/bin/env node
/**
 * Static HTTP server for the generated HLS fixtures, with optional
 * application-layer network shaping.
 *
 * Deliberately NOT part of apps/backend - M1.2 forbids backend changes, and
 * this has nothing to do with the product API. It is a dev tool with no
 * dependencies beyond Node's standard library.
 *
 * ──────────────────────────── SHAPING ────────────────────────────
 *
 * WHAT THIS IS: a token-bucket byte-rate limiter plus a fixed delay before
 * the first byte of each response. Throttling is applied progressively to
 * streamed chunks, so a large segment arrives at the configured rate rather
 * than being delayed and then dumped at full speed.
 *
 * WHAT THIS IS NOT: real network shaping.
 *
 *   - `latency` is an APPLICATION-LAYER RESPONSE DELAY, not physical RTT.
 *     The server waits before sending the first byte of a response. The
 *     client observes it as added request->response time, so it adds roughly
 *     1x the configured value to each HTTP round trip. TCP handshakes, TLS,
 *     DNS and ACK round trips are NOT delayed. Real RTT would also slow
 *     connection setup and TCP's congestion window ramp; this does not.
 *   - There is NO packet loss, NO jitter, NO reordering, and no interaction
 *     with TCP congestion control. A real lossy link behaves worse.
 *   - The bucket is shared across all in-flight requests, which models one
 *     shared device link. Concurrent requests contend, as they would.
 *
 * Treat results as "how the player behaves when bytes arrive slowly and
 * responses start late", not as a 4G field measurement.
 *
 * Usage:
 *   node tools/video-fixtures/serve.mjs [--port 8787] [--dir <path>]
 *        [--profile none|p1|p2] [--bandwidth <bits/s>] [--latency <ms>]
 *        [--log <csv path>]
 *
 * Profiles:
 *   none  unlimited, 0 ms      - the unshaped baseline
 *   p1    1.5 Mbit/s, 120 ms   - "4G constrained"
 *   p2    5 Mbit/s,    60 ms   - "4G typical"
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ───────────────────────────── arguments ─────────────────────────────

const args = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const PORT = Number.parseInt(flag('port', '8787'), 10);
const ROOT = path.resolve(flag('dir', 'tools/video-fixtures/out'));
const LOG_PATH = flag('log', null);

const PROFILES = {
  none: { label: 'none (unshaped)', bandwidthBitsPerSec: Infinity, latencyMs: 0 },
  p1: { label: 'P1 "4G constrained"', bandwidthBitsPerSec: 1_500_000, latencyMs: 120 },
  p2: { label: 'P2 "4G typical"', bandwidthBitsPerSec: 5_000_000, latencyMs: 60 },
};

const profileName = String(flag('profile', 'none')).toLowerCase();
if (!(profileName in PROFILES)) {
  process.stderr.write(
    `Unknown profile "${profileName}". Use one of: ${Object.keys(PROFILES).join(', ')}\n`,
  );
  process.exit(1);
}

const profile = { ...PROFILES[profileName] };

// Explicit overrides win over the profile, so one-off conditions are possible
// without inventing a new profile name.
const bandwidthOverride = flag('bandwidth', null);
if (bandwidthOverride !== null)
  profile.bandwidthBitsPerSec = Number.parseInt(bandwidthOverride, 10);
const latencyOverride = flag('latency', null);
if (latencyOverride !== null) profile.latencyMs = Number.parseInt(latencyOverride, 10);

const BYTES_PER_SEC = profile.bandwidthBitsPerSec / 8;
const SHAPING_ON = Number.isFinite(BYTES_PER_SEC) || profile.latencyMs > 0;

/** Chunk size for progressive delivery. Small enough that the rate is smooth,
 *  large enough that per-chunk overhead stays negligible. */
const CHUNK_BYTES = 16 * 1024;

/**
 * Token-bucket burst: how many bytes may be delivered at full line speed
 * before the configured rate starts to bite.
 *
 * Default 32 KiB (two chunks) - deliberately small. A larger burst lets the
 * manifest and the opening bytes of the first segment arrive instantly, which
 * flatters time-to-first-frame. Earlier runs used a 0.25-second burst
 * (46,875 B at P1, 156,250 B at P2); those results are NOT comparable with
 * results produced at this default. See docs/VIDEO_PLAYER_SPIKE.md §9.7.
 *
 * Must be at least CHUNK_BYTES or a single chunk can never be admitted.
 */
const DEFAULT_BURST_BYTES = 32 * 1024;

const BURST_BYTES = Number.parseInt(flag('burst', String(DEFAULT_BURST_BYTES)), 10);

// ─────────────────────────── token bucket ────────────────────────────

/**
 * One bucket for the whole server: a device has one link, and concurrent
 * requests must contend for it.
 */
class TokenBucket {
  constructor(bytesPerSec, burstBytes) {
    this.bytesPerSec = bytesPerSec;
    // Fixed burst, not rate-proportional: a rate-proportional burst silently
    // gives the faster profile a bigger head start, which makes profiles
    // incomparable on time-to-first-frame.
    this.capacity = Number.isFinite(bytesPerSec) ? Math.max(burstBytes, CHUNK_BYTES) : Infinity;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  #refill() {
    if (!Number.isFinite(this.bytesPerSec)) return;
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.bytesPerSec);
    this.lastRefill = now;
  }

  /** Resolves once `bytes` worth of allowance has been consumed. */
  async take(bytes) {
    if (!Number.isFinite(this.bytesPerSec)) return;
    for (;;) {
      this.#refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const deficitBytes = bytes - this.tokens;
      const waitMs = Math.ceil((deficitBytes / this.bytesPerSec) * 1000);
      await delay(Math.max(1, Math.min(waitMs, 250)));
    }
  }
}

const bucket = new TokenBucket(BYTES_PER_SEC, BURST_BYTES);

// ───────────────────────────── accounting ────────────────────────────

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  bytesSent: 0,
  firstByteAtMs: null,
  lastByteAtMs: null,
  responseMsTotal: 0,
};

function recordTransfer(bytes, durationMs) {
  const now = Date.now();
  stats.requests += 1;
  stats.bytesSent += bytes;
  stats.responseMsTotal += durationMs;
  if (stats.firstByteAtMs === null) stats.firstByteAtMs = now - durationMs;
  stats.lastByteAtMs = now;
}

/** Achieved throughput measured across the whole serving window. */
function achieved() {
  if (stats.firstByteAtMs === null || stats.lastByteAtMs === null) {
    return { windowSec: 0, bitsPerSec: 0, megabitsPerSec: 0 };
  }
  const windowSec = Math.max(0.001, (stats.lastByteAtMs - stats.firstByteAtMs) / 1000);
  const bitsPerSec = (stats.bytesSent * 8) / windowSec;
  return {
    windowSec: Number(windowSec.toFixed(3)),
    bitsPerSec: Math.round(bitsPerSec),
    megabitsPerSec: Number((bitsPerSec / 1_000_000).toFixed(3)),
  };
}

function shapingReport() {
  return {
    profile: profileName,
    label: profile.label,
    configured: {
      bandwidthBitsPerSec: Number.isFinite(profile.bandwidthBitsPerSec)
        ? profile.bandwidthBitsPerSec
        : null,
      bandwidthMegabitsPerSec: Number.isFinite(profile.bandwidthBitsPerSec)
        ? profile.bandwidthBitsPerSec / 1_000_000
        : null,
      responseDelayMs: profile.latencyMs,
      latencySemantics:
        'application-layer delay before the first byte of each HTTP response; approximately +1x per HTTP round trip. NOT physical network RTT. TCP/TLS handshakes are not delayed.',
      packetLoss: 'none - not modelled',
      jitter: 'none - not modelled',
      bucket: {
        chunkBytes: CHUNK_BYTES,
        burstBytes: Number.isFinite(bucket.capacity) ? Math.round(bucket.capacity) : null,
        burstPolicy: 'fixed, not rate-proportional, so profiles stay comparable on TTFF',
        shared: 'one bucket for all concurrent requests',
      },
    },
    measured: {
      ...achieved(),
      requests: stats.requests,
      bytesSent: stats.bytesSent,
      meanResponseMs: stats.requests ? Math.round(stats.responseMsTotal / stats.requests) : 0,
      startedAt: stats.startedAt,
    },
  };
}

let logReady = LOG_PATH === null;
async function logRow(row) {
  if (LOG_PATH === null) return;
  if (!logReady) {
    await writeFile(
      LOG_PATH,
      'at_iso,path,status,bytes,duration_ms,achieved_bits_per_sec\n',
      'utf8',
    );
    logReady = true;
  }
  await appendFile(LOG_PATH, `${row}\n`, 'utf8');
}

// ──────────────────────────── media types ────────────────────────────

/** HLS needs exact content types or players reject the manifest outright. */
const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
};

function lanAddresses() {
  const results = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) results.push(entry.address);
    }
  }
  return results;
}

// ───────────────────────── throttled delivery ────────────────────────

/**
 * Streams a file to the client at the bucket's rate.
 * Returns the number of bytes actually written (less than requested if the
 * client went away mid-transfer, which happens constantly in a swipe feed).
 */
async function streamThrottled(res, filePath, range) {
  const options = { highWaterMark: CHUNK_BYTES };
  if (range) {
    options.start = range.start;
    options.end = range.end;
  }

  const stream = createReadStream(filePath, options);
  let written = 0;

  try {
    for await (const chunk of stream) {
      if (res.destroyed || res.writableEnded) break;
      await bucket.take(chunk.length);
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(chunk)) {
        // Respect TCP backpressure, or the throttle becomes a memory leak.
        await once(res, 'drain');
      }
      written += chunk.length;
    }
  } catch (error) {
    // A client that swipes away aborts the socket. That is normal here.
    if (!res.destroyed) res.destroy(error);
    stream.destroy();
    return written;
  }

  stream.destroy();
  if (!res.destroyed && !res.writableEnded) res.end();
  return written;
}

// ──────────────────────────────── server ─────────────────────────────

const server = createServer(async (req, res) => {
  const requestStart = Date.now();

  // Permissive CORS: this serves synthetic test patterns on a LAN, never
  // production content. Do not copy this header policy into the real API.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // Control endpoints are never shaped - tooling must not be slowed by the
  // conditions under test.
  if (requestPath === '/' || requestPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', root: ROOT, shaping: profileName }));
    return;
  }

  if (requestPath === '/shaping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(shapingReport(), null, 2));
    return;
  }

  if (requestPath === '/shaping/reset') {
    stats.requests = 0;
    stats.bytesSent = 0;
    stats.firstByteAtMs = null;
    stats.lastByteAtMs = null;
    stats.responseMsTotal = 0;
    stats.startedAt = new Date().toISOString();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reset: true, startedAt: stats.startedAt }));
    return;
  }

  // Contain every request inside ROOT - a fixture server is still a server.
  const resolved = path.resolve(ROOT, `.${requestPath}`);
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(resolved);
    if (!fileStat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${requestPath}`);
    return;
  }

  const contentType =
    CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';

  // Application-layer response delay. Applied once per response, before any
  // byte is written. See the SHAPING note at the top of this file.
  if (profile.latencyMs > 0) await delay(profile.latencyMs);

  const rangeHeader = req.headers.range;
  let range = null;
  let status = 200;
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // no-store so a re-run measures a cold start, not yesterday's cache.
    'Cache-Control': 'no-store',
  };

  // Range support matters: ExoPlayer issues ranged reads against segments.
  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : fileStat.size - 1;

      if (start >= fileStat.size || end >= fileStat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}` }).end();
        return;
      }

      range = { start, end };
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${fileStat.size}`;
      headers['Content-Length'] = end - start + 1;
    }
  }

  if (!range) headers['Content-Length'] = fileStat.size;

  res.writeHead(status, headers);

  const written = await streamThrottled(res, resolved, range);
  const durationMs = Date.now() - requestStart;

  recordTransfer(written, durationMs);

  const rate = durationMs > 0 ? Math.round((written * 8) / (durationMs / 1000)) : 0;
  await logRow(
    `${new Date().toISOString()},${requestPath},${status},${written},${durationMs},${rate}`,
  );
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = lanAddresses();
  process.stdout.write(`\nHLS fixture server\n  root: ${ROOT}\n\n`);

  if (SHAPING_ON) {
    const mbps = Number.isFinite(profile.bandwidthBitsPerSec)
      ? `${(profile.bandwidthBitsPerSec / 1_000_000).toFixed(2)} Mbit/s`
      : 'unlimited';
    process.stdout.write(
      `  SHAPING: ${profile.label}\n` +
        `    bandwidth       ${mbps} (${Math.round(BYTES_PER_SEC)} B/s, token bucket, shared)\n` +
        `    burst           ${Math.round(bucket.capacity)} B (fixed)\n` +
        `    response delay  ${profile.latencyMs} ms  [application-layer, NOT physical RTT]\n` +
        `    packet loss     none - not modelled\n` +
        `    jitter          none - not modelled\n\n`,
    );
  } else {
    process.stdout.write('  SHAPING: off (unshaped baseline)\n\n');
  }

  process.stdout.write(`  local      http://localhost:${PORT}/\n`);
  for (const address of addresses) {
    process.stdout.write(`  device     http://${address}:${PORT}/\n`);
  }

  process.stdout.write(
    `\n  GET /shaping        configured + achieved throughput (JSON)\n` +
      `  GET /shaping/reset  zero the counters before a run\n`,
  );

  if (LOG_PATH) process.stdout.write(`  per-response CSV -> ${LOG_PATH}\n`);

  process.stdout.write(
    `\nPaste a "device" URL into the spike screen's Base URL field.\n` +
      `Phone and computer must be on the same Wi-Fi, and port ${PORT} must be\n` +
      `allowed through the firewall for private networks.\n\n`,
  );
});

// Periodic throughput line so a long run is observable while it happens.
if (SHAPING_ON) {
  const timer = setInterval(() => {
    if (stats.requests === 0) return;
    const a = achieved();
    process.stdout.write(
      `  [shaping] ${stats.requests} responses · ${(stats.bytesSent / 1_048_576).toFixed(1)} MiB · achieved ${a.megabitsPerSec} Mbit/s\n`,
    );
  }, 15_000);
  timer.unref();
}
