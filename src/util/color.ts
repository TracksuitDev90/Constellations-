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
