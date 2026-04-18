import { defineConfig } from 'vite';

// GitHub Pages serves this project at /Constellations-/ (note trailing hyphen).
// Use an absolute base in production so Pixi's worker / asset URLs resolve
// correctly; `./` (relative) can break worker loads under a subpath.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Constellations-/' : '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: true,
  },
}));
