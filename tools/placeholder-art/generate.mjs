#!/usr/bin/env node
/**
 * MiniDrama — placeholder artwork generator (M2.1).
 *
 * WHY THIS EXISTS
 * ---------------
 * The mobile UI needs real images to be reviewable: a streaming app judged
 * against grey rectangles is not judged at all. CLAUDE.md §16.16 forbids
 * copying assets from reference apps, §18/§19 forbid paid image services, and
 * the M2.1 brief forbids depending on external image URLs. So the art is
 * generated here: original, deterministic, offline, and free.
 *
 * WHAT IT PRODUCES
 * ----------------
 * For each drama in ART_DIRECTION, three PNGs under
 * apps/mobile/assets/posters/:
 *
 *   <slug>-poster.png    360x540   2:3   rail and grid cards
 *   <slug>-banner.png   1024x576  16:9   featured home banner, detail header
 *   <slug>-thumb.png     252x448   9:16  episode list thumbnails
 *
 * These are ABSTRACT GRADIENT COMPOSITIONS, not depictions. They are honest
 * placeholders: they set the right tone for layout review without pretending
 * to be real key art. Replace them with licensed artwork before any release.
 *
 * HOW IT WORKS
 * ------------
 * A hand-rolled PNG encoder (truecolour, 8-bit, filter 0) over Node's built-in
 * zlib. No dependency is added to the repo for a build-time art step.
 *
 * Usage:  node tools/placeholder-art/generate.mjs [--out <dir>]
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEFAULT_OUT = resolve(REPO_ROOT, 'apps/mobile/assets/posters');

// ───────────────────────────── PNG encoding ──────────────────────────────

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Picks a PNG filter per scanline using the standard minimum-sum-of-absolute-
 * differences heuristic, and writes the filtered row.
 *
 * This is not an optimisation for its own sake. With filter 0 (None) deflate
 * has to compress raw RGB values, and these images came out at 7 MB for 24
 * files - far too heavy to ship inside an app bundle. Sub and Up turn a smooth
 * gradient into a run of near-zero deltas, which is what PNG is good at.
 */
function filterScanline(current, previous, bpp, out, outOffset) {
  const len = current.length;
  const candidates = [];

  // 0 None
  const none = Buffer.from(current);
  // 1 Sub
  const sub = Buffer.alloc(len);
  // 2 Up
  const up = Buffer.alloc(len);
  // 3 Average
  const avg = Buffer.alloc(len);
  // 4 Paeth
  const paeth = Buffer.alloc(len);

  for (let i = 0; i < len; i += 1) {
    const raw = current[i];
    const left = i >= bpp ? current[i - bpp] : 0;
    const above = previous[i];
    const upperLeft = i >= bpp ? previous[i - bpp] : 0;

    sub[i] = (raw - left) & 0xff;
    up[i] = (raw - above) & 0xff;
    avg[i] = (raw - ((left + above) >> 1)) & 0xff;

    const p = left + above - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - above);
    const pc = Math.abs(p - upperLeft);
    const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
    paeth[i] = (raw - predictor) & 0xff;
  }

  candidates.push(none, sub, up, avg, paeth);

  let bestType = 0;
  let bestScore = Infinity;
  for (let type = 0; type < candidates.length; type += 1) {
    const buf = candidates[type];
    let score = 0;
    // Signed magnitude: a delta of 254 is really -2 and costs little.
    for (let i = 0; i < len; i += 1) score += buf[i] < 128 ? buf[i] : 256 - buf[i];
    if (score < bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  out[outOffset] = bestType;
  candidates[bestType].copy(out, outOffset + 1);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb  width*height*3 bytes, row-major
 */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const bpp = 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const current = Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride);
    filterScanline(current, previous, bpp, raw, y * (stride + 1));
    previous = current;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method 0 (the adaptive set used above)
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ──────────────────────────── Colour helpers ─────────────────────────────

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Deterministic value noise so every run produces byte-identical files. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ─────────────────────────────── Art brief ───────────────────────────────

/**
 * Palette per drama, chosen for genre rather than at random: warm rose and
 * amber for romance, cold teal and indigo for thriller, desaturated crimson
 * for horror. The point is that a rail of eight cards reads as eight distinct
 * titles at a glance, which is what the layout is being reviewed for.
 *
 * `glow` positions are fractions of the frame, so the same composition works
 * at all three aspect ratios without re-authoring.
 */
const ART_DIRECTION = [
  {
    slug: 'mazhai-ninaivugal',
    deep: '#120B14',
    mid: '#5B2340',
    light: '#F0A07A',
    glow: [
      { x: 0.68, y: 0.3, r: 0.52, color: '#F5B544', strength: 0.55 },
      { x: 0.22, y: 0.72, r: 0.46, color: '#8E3C6B', strength: 0.4 },
    ],
    streaks: 'rain',
  },
  {
    slug: 'nila-theru-rahasiyam',
    deep: '#070B14',
    mid: '#16304C',
    light: '#79C6D8',
    glow: [
      { x: 0.5, y: 0.22, r: 0.4, color: '#CFE9F2', strength: 0.5 },
      { x: 0.18, y: 0.78, r: 0.5, color: '#1E4E6B', strength: 0.45 },
    ],
    streaks: 'fog',
  },
  {
    slug: 'kadhal-kanakku',
    deep: '#140D0A',
    mid: '#6B3A1E',
    light: '#FFD089',
    glow: [
      { x: 0.32, y: 0.28, r: 0.5, color: '#FFC46B', strength: 0.6 },
      { x: 0.76, y: 0.74, r: 0.42, color: '#B8563C', strength: 0.38 },
    ],
    streaks: 'bokeh',
  },
  {
    slug: 'iravu-rayil',
    deep: '#06090E',
    mid: '#1C2A3A',
    light: '#6FA8C9',
    glow: [
      { x: 0.8, y: 0.62, r: 0.46, color: '#F5B544', strength: 0.42 },
      { x: 0.26, y: 0.3, r: 0.44, color: '#2E5572', strength: 0.5 },
    ],
    streaks: 'motion',
  },
  {
    slug: 'veliyil-oru-veedu',
    deep: '#0D1010',
    mid: '#2F4034',
    light: '#A9C2A0',
    glow: [
      { x: 0.46, y: 0.68, r: 0.52, color: '#D8C48A', strength: 0.45 },
      { x: 0.74, y: 0.22, r: 0.38, color: '#44604A', strength: 0.42 },
    ],
    streaks: 'fog',
  },
  {
    slug: 'nizhal-vettai',
    deep: '#0A0A0D',
    mid: '#3A2030',
    light: '#D6705E',
    glow: [
      { x: 0.6, y: 0.4, r: 0.44, color: '#E8604B', strength: 0.5 },
      { x: 0.2, y: 0.8, r: 0.4, color: '#4A2340', strength: 0.45 },
    ],
    streaks: 'motion',
  },
  {
    slug: 'kaanal-neer',
    deep: '#0B0E16',
    mid: '#2A2A5C',
    light: '#9D9BE8',
    glow: [
      { x: 0.5, y: 0.5, r: 0.56, color: '#B9A7FF', strength: 0.52 },
      { x: 0.82, y: 0.18, r: 0.34, color: '#5BD6C4', strength: 0.34 },
    ],
    streaks: 'bokeh',
  },
  {
    slug: 'pournami-kadhai',
    deep: '#09060A',
    mid: '#3B1220',
    light: '#C76A72',
    glow: [
      { x: 0.5, y: 0.18, r: 0.34, color: '#E8D8C0', strength: 0.46 },
      { x: 0.32, y: 0.76, r: 0.5, color: '#6B1626', strength: 0.5 },
    ],
    streaks: 'fog',
  },
];

const VARIANTS = [
  // Bottom scrim is baked into the poster and thumbnail so the title and
  // episode number overlaid in the app stay readable without stacking a dozen
  // gradient views per card. The banner's scrim is applied in the UI, because
  // the banner's overlay has to sit above a safe-area-aware layout.
  { name: 'poster', width: 360, height: 540, scrim: 0.62 },
  { name: 'banner', width: 1024, height: 576, scrim: 0.18 },
  { name: 'thumb', width: 252, height: 448, scrim: 0.45 },
];

// ────────────────────────────── Compositor ───────────────────────────────

/**
 * 4x4 Bayer matrix, used as an ordered dither.
 *
 * A smooth gradient quantised to 8 bits bands visibly on a dark screen, and
 * per-pixel random dither is incompressible - the first version of this
 * generator produced 10 MB of PNG for 24 images because of it. An ordered
 * dither is a repeating 4x4 tile, so deflate encodes it almost for free, and
 * it kills the banding just as well.
 */
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function render({ width, height, art, scrim, seed }) {
  const rgb = new Uint8Array(width * height * 3);
  const random = makeRandom(seed);

  /**
   * Film-grain texture at 1/4 resolution, sampled nearest-neighbour. Coarse
   * blocks keep the texture visible while cutting the entropy deflate has to
   * encode by roughly 16x.
   */
  const grainW = Math.ceil(width / 4);
  const grainH = Math.ceil(height / 4);
  const grainField = new Int8Array(grainW * grainH);
  for (let i = 0; i < grainField.length; i += 1) {
    // Quantised to 3 levels. More levels cost bytes and buy nothing visible.
    grainField[i] = Math.round((random() - 0.5) * 2) * 3;
  }

  const deep = hexToRgb(art.deep);
  const mid = hexToRgb(art.mid);
  const light = hexToRgb(art.light);
  const glows = art.glow.map((g) => ({ ...g, rgb: hexToRgb(g.color) }));

  // A fixed set of streak/bokeh positions, drawn from the seeded generator so
  // the composition is stable across runs.
  const streakCount = art.streaks === 'bokeh' ? 14 : art.streaks === 'rain' ? 34 : 9;
  const streaks = Array.from({ length: streakCount }, () => ({
    x: random(),
    y: random(),
    size: 0.02 + random() * 0.09,
    alpha: 0.05 + random() * 0.18,
    len: 0.05 + random() * 0.25,
  }));

  const aspect = width / height;

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);

      // 1. Base: a diagonal three-stop gradient, deep -> mid -> light.
      const diagonal = smoothstep(Math.min(1, Math.max(0, u * 0.45 + (1 - v) * 0.75)));
      let r;
      let g;
      let b;
      if (diagonal < 0.62) {
        const t = smoothstep(diagonal / 0.62);
        r = lerp(deep[0], mid[0], t);
        g = lerp(deep[1], mid[1], t);
        b = lerp(deep[2], mid[2], t);
      } else {
        const t = smoothstep((diagonal - 0.62) / 0.38);
        r = lerp(mid[0], light[0], t);
        g = lerp(mid[1], light[1], t);
        b = lerp(mid[2], light[2], t);
      }

      // 2. Radial glows, screened on top. Distance is aspect-corrected so a
      //    circle stays a circle at 16:9 and at 9:16.
      for (const glow of glows) {
        const dx = (u - glow.x) * aspect;
        const dy = v - glow.y;
        const d = Math.sqrt(dx * dx + dy * dy) / glow.r;
        if (d >= 1) continue;
        const falloff = smoothstep(1 - d) * glow.strength;
        r = r + (255 - r) * (glow.rgb[0] / 255) * falloff;
        g = g + (255 - g) * (glow.rgb[1] / 255) * falloff;
        b = b + (255 - b) * (glow.rgb[2] / 255) * falloff;
      }

      // 3. Texture pass. Each style is a cheap analytic shape rather than a
      //    blur, which keeps the whole generator dependency-free.
      for (const s of streaks) {
        if (art.streaks === 'bokeh') {
          const dx = (u - s.x) * aspect;
          const dy = v - s.y;
          const d = Math.sqrt(dx * dx + dy * dy) / s.size;
          if (d >= 1) continue;
          const a = smoothstep(1 - d) * s.alpha;
          r = lerp(r, 255, a * 0.5);
          g = lerp(g, 255, a * 0.5);
          b = lerp(b, 255, a * 0.45);
        } else if (art.streaks === 'rain') {
          // Near-vertical streaks, slightly sheared.
          const dx = Math.abs(u - (s.x + (v - s.y) * 0.08)) * aspect;
          const within = v > s.y && v < s.y + s.len;
          if (!within || dx > s.size * 0.06) continue;
          const a = (1 - dx / (s.size * 0.06)) * s.alpha * 0.8;
          r = lerp(r, 255, a);
          g = lerp(g, 255, a);
          b = lerp(b, 255, a);
        } else if (art.streaks === 'motion') {
          // Horizontal light trails.
          const dy = Math.abs(v - s.y);
          const within = u > s.x - s.len && u < s.x + s.len;
          if (!within || dy > s.size * 0.05) continue;
          const a = (1 - dy / (s.size * 0.05)) * s.alpha * 0.7;
          r = lerp(r, light[0], a);
          g = lerp(g, light[1], a);
          b = lerp(b, light[2], a);
        } else {
          // fog: wide, very soft horizontal bands.
          const dy = Math.abs(v - s.y);
          if (dy > s.size * 1.6) continue;
          const a = smoothstep(1 - dy / (s.size * 1.6)) * s.alpha * 0.35;
          r = lerp(r, light[0], a);
          g = lerp(g, light[1], a);
          b = lerp(b, light[2], a);
        }
      }

      // 4. Vignette. Pulls the eye inward and stops the card edges glowing.
      const vx = (u - 0.5) * 2;
      const vy = (v - 0.5) * 2;
      const vignette = 1 - 0.34 * smoothstep(Math.min(1, Math.sqrt(vx * vx + vy * vy) / 1.3));
      r *= vignette;
      g *= vignette;
      b *= vignette;

      // 5. Baked bottom scrim, fading to the app background colour so a card
      //    sits on the page without a visible seam.
      if (scrim > 0) {
        const start = 1 - scrim;
        if (v > start) {
          const t = smoothstep((v - start) / scrim) * 0.92;
          r = lerp(r, 0x09, t);
          g = lerp(g, 0x0a, t);
          b = lerp(b, 0x0f, t);
        }
      }

      // 6. Coarse grain plus an ordered dither. Together these give the image
      //    texture and remove gradient banding without the file-size cost of
      //    per-pixel noise - see the note on BAYER_4.
      const grain = grainField[(y >> 2) * grainW + (x >> 2)];
      const dither = (BAYER_4[y & 3][x & 3] / 15 - 0.5) * 1.5;
      const offset = grain + dither;

      const i = (y * width + x) * 3;
      rgb[i] = clamp255(Math.round(r + offset));
      rgb[i + 1] = clamp255(Math.round(g + offset));
      rgb[i + 2] = clamp255(Math.round(b + offset));
    }
  }

  return encodePng(width, height, rgb);
}

// ──────────────────────────────── Driver ─────────────────────────────────

function parseArgs(argv) {
  const out = { outDir: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outDir = resolve(process.cwd(), argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  let total = 0;
  let bytes = 0;

  for (const art of ART_DIRECTION) {
    for (const variant of VARIANTS) {
      const png = render({
        width: variant.width,
        height: variant.height,
        art,
        scrim: variant.scrim,
        // Seeded per slug+variant so re-running never changes a byte, and so
        // a drama's three images share a family resemblance without being
        // identical crops.
        seed: hashString(`${art.slug}:${variant.name}`),
      });
      const file = resolve(outDir, `${art.slug}-${variant.name}.png`);
      writeFileSync(file, png);
      total += 1;
      bytes += png.length;
      process.stdout.write(
        `  ${art.slug}-${variant.name}.png  ${variant.width}x${variant.height}  ${(png.length / 1024).toFixed(0)} kB\n`,
      );
    }
  }

  process.stdout.write(
    `\nGenerated ${total} images (${(bytes / 1024 / 1024).toFixed(2)} MB) into ${outDir}\n`,
  );
}

main();
