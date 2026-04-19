# Planet Texture Credits

The equirectangular planet maps in this directory were sourced from the
public `jeromeetienne/threex.planets` repository
(<https://github.com/jeromeetienne/threex.planets>), which in turn sources
them from Jim Hastings-Trew's **Planet Pixel Emporium**
(<https://planetpixelemporium.com/planets.html>).

Per Planet Pixel Emporium's terms, these maps are free to use for any
purpose, including commercial, with no attribution strictly required —
but we list the source here out of respect for the author.

| File             | Source map        | Used for archetype |
|------------------|-------------------|--------------------|
| terrestrial.jpg  | earthmap1k.jpg    | terrestrial        |
| gasgiant.jpg     | jupitermap.jpg    | gasGiant           |
| icy.jpg          | neptunemap.jpg    | icy                |
| molten.jpg       | venusmap.jpg      | molten             |
| alien.jpg        | marsmap1k.jpg     | alien              |

Each planet in the game picks one of the five archetypes deterministically
from its seed; the baker in `src/game/render/planetAssets.ts` re-projects
the equirectangular map onto a lit 2D disc at runtime.
