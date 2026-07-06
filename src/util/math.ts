export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const dist = (a: Vec2, b: Vec2): number => Math.sqrt(dist2(a, b));

export const norm = (v: Vec2): Vec2 => {
  const m = Math.hypot(v.x, v.y);
  return m > 0 ? { x: v.x / m, y: v.y / m } : { x: 0, y: 0 };
};

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });

/**
 * Length of the part of segment (ax,ay)–(bx,by) that lies inside the circle
 * centered at (cx,cy) with radius r. Zero when the segment misses the circle
 * entirely. Used to price flight paths through hazard zones: the time a wave
 * spends inside an asteroid field or a swarm's patrol band is proportional to
 * this chord length.
 */
export const segCircleIntersectionLength = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return Math.hypot(ax - cx, ay - cy) <= r ? 0 : 0;
  }
  // Solve |A + t*D - C|² = r² for t along the unit-parameterized segment.
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const sq = Math.sqrt(disc);
  const t0 = clamp((-b - sq) / (2 * a), 0, 1);
  const t1 = clamp((-b + sq) / (2 * a), 0, 1);
  return Math.max(0, (t1 - t0) * len);
};
