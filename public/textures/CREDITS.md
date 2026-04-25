# Planet Texture Credits

The planet maps in this directory (`IMG_0314.png` … `IMG_0352.png`, 39 maps in
total) are project-original equirectangular textures. Each one is treated by
the in-game sphere baker (`src/game/render/planetAssets.ts`) as a 2:1 source
map that gets re-projected onto a lit 2D disc at runtime.

Every planet in the game picks one of the 39 archetypes deterministically from
its seed via `assignPlanetArchetypes`, so a match's texture set is stable
within itself but varies across matches.
