#!/usr/bin/env node
// Procedurally generates equirectangular PNG planet maps (2:1 aspect)
// for fictional archetypes and writes them to public/textures/.
//
// The in-game sphere baker (planetAssets.ts) adds lighting, so these maps
// only need to carry base surface colors — no shading.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'textures');
mkdirSync(OUT, { recursive: true });

const W = 1024;
const H = 512;

// ─── RNG ──────────────────────────────────────────────────────────────────
const mulberry32 = (seed) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ─── Value-noise-ish 2D field tiled along longitude ───────────────────────
const makeNoise = (seed, scaleX, scaleY) => {
  const rng = mulberry32(seed);
  const gridW = Math.max(2, Math.round(scaleX));
  const gridH = Math.max(2, Math.round(scaleY));
  const grid = new Float32Array(gridW * gridH);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const sample = (x, y) => {
    // x wraps (longitude), y clamps (latitude).
    const gx = ((x % 1) + 1) % 1 * gridW;
    const gy = Math.max(0, Math.min(0.9999, y)) * gridH;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const x1 = (x0 + 1) % gridW;
    const y1 = Math.min(gridH - 1, y0 + 1);
    const a = grid[y0 * gridW + x0];
    const b = grid[y0 * gridW + x1];
    const c = grid[y1 * gridW + x0];
    const d = grid[y1 * gridW + x1];
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
  };
  return sample;
};

const fbm = (samplers, x, y) => {
  let v = 0;
  let amp = 0.5;
  let totalAmp = 0;
  for (let i = 0; i < samplers.length; i++) {
    v += samplers[i](x * (1 << i), y * (1 << i)) * amp;
    totalAmp += amp;
    amp *= 0.55;
  }
  return v / totalAmp;
};

// ─── Color helpers ────────────────────────────────────────────────────────
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// ─── PNG encoder (RGB, 8-bit, no filter) ──────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
};
const encodePNG = (rgb, width, height) => {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Prepend each scanline with filter byte 0 (None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// ─── Archetype surface shaders ────────────────────────────────────────────
// Each returns an RGB triplet (0..255) for a given longitude/latitude pair.
// Lighting is applied later by the sphere baker.

const makeSamplers = (seed, counts = 5) => {
  const arr = [];
  for (let i = 0; i < counts; i++) arr.push(makeNoise(seed + i * 2003, 8 * (1 << i), 4 * (1 << i)));
  return arr;
};

const archetypes = {
  // Sickly toxic swamp — deep purples with bubbling green acid lakes.
  poison: (seed) => {
    const noise = makeSamplers(seed, 6);
    const spots = makeSamplers(seed + 91, 4);
    return (u, v) => {
      const n = fbm(noise, u, v);
      const s = fbm(spots, u * 1.8 + 0.3, v * 1.8);
      const deep = [30, 8, 52];
      const dark = [56, 18, 78];
      const mid = [92, 34, 128];
      const sick = [72, 110, 36]; // swampy olive
      const bile = [150, 210, 50]; // acid green
      const glow = [190, 255, 110]; // bright acid
      let c;
      if (n < 0.38) c = mix(deep, dark, n / 0.38);
      else if (n < 0.6) c = mix(dark, mid, (n - 0.38) / 0.22);
      else c = mix(mid, sick, (n - 0.6) / 0.4);
      // Acid pool blotches
      const pool = Math.max(0, (s - 0.58) / 0.42);
      if (pool > 0) {
        const poolColor = mix(sick, bile, Math.min(1, pool * 1.4));
        c = mix(c, poolColor, Math.min(1, pool * 1.6));
      }
      // Brightest hot spots of acid
      if (s > 0.82) c = mix(c, glow, (s - 0.82) / 0.18 * 0.8);
      // Subtle pole darkening
      const poleFade = Math.pow(Math.abs(v - 0.5) * 2, 3);
      c = mix(c, deep, poleFade * 0.4);
      return c;
    };
  },

  // Royal amethyst crystalline world — violet with frosted crystal veins.
  amethyst: (seed) => {
    const noise = makeSamplers(seed, 5);
    const veins = makeSamplers(seed + 77, 4);
    return (u, v) => {
      const n = fbm(noise, u, v);
      const w = fbm(veins, u * 3, v * 3);
      const dark = [34, 10, 58];
      const base = [90, 44, 140];
      const light = [170, 120, 220];
      const frost = [230, 210, 255];
      let c;
      if (n < 0.45) c = mix(dark, base, n / 0.45);
      else c = mix(base, light, Math.min(1, (n - 0.45) / 0.55));
      // Bright crystal veins where w is high.
      const veinStrength = Math.max(0, (w - 0.65) / 0.35);
      c = mix(c, frost, veinStrength * 0.7);
      // Darker limb rings
      const poleFade = Math.pow(Math.abs(v - 0.5) * 2, 2.5);
      c = mix(c, dark, poleFade * 0.5);
      return c;
    };
  },

  // Ember / obsidian — dark charcoal with glowing red fissures.
  ember: (seed) => {
    const noise = makeSamplers(seed, 6);
    const cracks = makeSamplers(seed + 131, 5);
    return (u, v) => {
      const n = fbm(noise, u, v);
      const cr = fbm(cracks, u * 2.5, v * 2.5);
      const black = [14, 10, 12];
      const char = [50, 30, 30];
      const rock = [92, 58, 46];
      const lava = [230, 90, 20];
      const core = [255, 220, 80];
      let c;
      if (n < 0.5) c = mix(black, char, n / 0.5);
      else c = mix(char, rock, (n - 0.5) / 0.5);
      // Narrow glowing crack band: emphasize a specific noise range.
      const f = Math.abs(cr - 0.5);
      const crack = Math.max(0, (0.06 - f) / 0.06);
      if (crack > 0) {
        c = mix(c, lava, crack * 0.85);
        if (crack > 0.7) c = mix(c, core, (crack - 0.7) / 0.3 * 0.8);
      }
      return c;
    };
  },

  // Pure oceanic — deep blues with swirling cloud cover.
  oceanic: (seed) => {
    const noise = makeSamplers(seed, 6);
    const clouds = makeSamplers(seed + 211, 5);
    return (u, v) => {
      const n = fbm(noise, u, v);
      const cl = fbm(clouds, u * 1.6, v * 1.6);
      const abyss = [4, 14, 46];
      const deep = [18, 46, 110];
      const shallow = [48, 130, 200];
      const foam = [210, 235, 255];
      let c;
      if (n < 0.45) c = mix(abyss, deep, n / 0.45);
      else c = mix(deep, shallow, (n - 0.45) / 0.55);
      // Clouds on top
      const cloud = Math.max(0, (cl - 0.55) / 0.45);
      c = mix(c, foam, cloud * 0.6);
      // Ice caps
      const poleFade = Math.pow(Math.abs(v - 0.5) * 2, 3);
      if (poleFade > 0.7) c = mix(c, foam, (poleFade - 0.7) / 0.3);
      return c;
    };
  },

  // Verdant jungle — lush greens with river-like dark veins.
  verdant: (seed) => {
    const noise = makeSamplers(seed, 6);
    const rivers = makeSamplers(seed + 333, 5);
    return (u, v) => {
      const n = fbm(noise, u, v);
      const r = fbm(rivers, u * 2.2, v * 2.2);
      const bark = [30, 42, 18];
      const moss = [56, 92, 32];
      const leaf = [96, 158, 48];
      const bright = [180, 220, 96];
      const water = [40, 70, 110];
      let c;
      if (n < 0.4) c = mix(bark, moss, n / 0.4);
      else if (n < 0.75) c = mix(moss, leaf, (n - 0.4) / 0.35);
      else c = mix(leaf, bright, (n - 0.75) / 0.25);
      // Dark water ribbons
      const rf = Math.abs(r - 0.5);
      const riv = Math.max(0, (0.05 - rf) / 0.05);
      if (riv > 0) c = mix(c, water, riv * 0.8);
      return c;
    };
  },

  // Desert / barren sands — rust and sand bands.
  desert: (seed) => {
    const noise = makeSamplers(seed, 5);
    const dunes = makeSamplers(seed + 401, 4);
    return (u, v) => {
      const n = fbm(noise, u, v);
      const d = fbm(dunes, u * 4, v * 1.5);
      const shadow = [90, 50, 30];
      const sand = [190, 140, 80];
      const rust = [170, 90, 50];
      const bright = [240, 210, 150];
      let c;
      if (n < 0.5) c = mix(shadow, rust, n / 0.5);
      else c = mix(rust, sand, (n - 0.5) / 0.5);
      // Lighter dune streaks
      const stripe = Math.max(0, (d - 0.62) / 0.38);
      c = mix(c, bright, stripe * 0.45);
      return c;
    };
  },
};

// ─── Render ───────────────────────────────────────────────────────────────
const renderArchetype = (name, seed) => {
  const surface = archetypes[name](seed);
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const c = surface(u, v);
      const i = (y * W + x) * 3;
      buf[i] = clamp255(c[0]);
      buf[i + 1] = clamp255(c[1]);
      buf[i + 2] = clamp255(c[2]);
    }
  }
  return encodePNG(buf, W, H);
};

const targets = [
  ['poison', 0xB00B1E],
  ['amethyst', 0xA77E57],
  ['ember', 0xE71B84],
  ['oceanic', 0x0CEA17],
  ['verdant', 0x7E7D47],
  ['desert', 0xDE5E27],
];

for (const [name, seed] of targets) {
  const png = renderArchetype(name, seed);
  const path = join(OUT, `${name}.png`);
  writeFileSync(path, png);
  const hash = createHash('sha1').update(png).digest('hex').slice(0, 8);
  console.log(`wrote ${path} (${png.length} bytes, sha1:${hash})`);
}
