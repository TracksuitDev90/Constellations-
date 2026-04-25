export interface PlayerPalette {
  core: number;
  glow: number;
  ship: number;
  ring: number;
}

export const NEUTRAL: PlayerPalette = {
  core: 0x9aa3b8,
  glow: 0x3a4358,
  ship: 0xb0b8cc,
  ring: 0x6a7488,
};

export const PLAYER_PALETTES: PlayerPalette[] = [
  {
    core: 0x7ad4ff,
    glow: 0x1d6fb8,
    ship: 0xaee5ff,
    ring: 0x4aa8e0,
  },
  {
    core: 0xff7a9c,
    glow: 0xb81d4f,
    ship: 0xffaec4,
    ring: 0xe04a78,
  },
  {
    core: 0x9cff7a,
    glow: 0x2f8a1d,
    ship: 0xc4ffae,
    ring: 0x78d04a,
  },
  {
    core: 0xffd27a,
    glow: 0xb8861d,
    ship: 0xffe8ae,
    ring: 0xe0b24a,
  },
];

export const paletteFor = (ownerId: number | null): PlayerPalette =>
  ownerId === null ? NEUTRAL : PLAYER_PALETTES[ownerId % PLAYER_PALETTES.length];

/** Multiply each RGB channel by factor; clamp to [0,255]. <1 darkens, >1 lightens. */
export const adjustColor = (color: number, factor: number): number => {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
};

/** Blend toward white by t in [0,1]. */
export const toward = (color: number, target: number, t: number): number => {
  const r0 = (color >> 16) & 0xff;
  const g0 = (color >> 8) & 0xff;
  const b0 = color & 0xff;
  const r1 = (target >> 16) & 0xff;
  const g1 = (target >> 8) & 0xff;
  const b1 = target & 0xff;
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return (r << 16) | (g << 8) | b;
};

const hash01 = (n: number): number => {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};

/**
 * Per-channel deterministic jitter. Each RGB channel is multiplied by an
 * independent factor in `[1-amount, 1+amount]` so the result is recognizably
 * the same hue with a small drift. Used per-planet so two planets owned by
 * the same player still feel individually unique.
 */
export const hueJitter = (color: number, seed: number, amount = 0.15): number => {
  const jr = 1 + (hash01(seed * 7 + 1) - 0.5) * amount * 2;
  const jg = 1 + (hash01(seed * 13 + 2) - 0.5) * amount * 2;
  const jb = 1 + (hash01(seed * 19 + 3) - 0.5) * amount * 2;
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 0xff) * jr)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 0xff) * jg)));
  const b = Math.min(255, Math.max(0, Math.round((color & 0xff) * jb)));
  return (r << 16) | (g << 8) | b;
};
