import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Glyph font-stack resolution (step 9): MapLibre GL JS 6.x does not fall back
 * per font — it requests the glyph range for the WHOLE `text-font` stack
 * joined with commas (e.g. "Open Sans Semibold,Noto Sans Regular/0-255.pbf").
 * The vendored `openmaptiles/fonts` release ships one directory per font, so
 * the app resolves the stack to the first font that actually provides the
 * range (mirroring what OpenMapTiles' own font server does).
 */

const RANGE_RE = /^\d+-\d+\.pbf$/;

/**
 * Resolves a (possibly comma-joined) font stack + glyph range to an existing
 * file under `publicDir`. Returns null when the request is not a glyph-range
 * request for a multi-font stack (leave it to the static handler / 404).
 */
export function resolveGlyphFile(publicDir: string, fontstack: string, range: string): string | null {
  if (!fontstack.includes(",")) return null;
  if (!RANGE_RE.test(range)) return null;
  const root = path.resolve(publicDir);
  for (const raw of fontstack.split(",")) {
    const font = raw.trim();
    if (font === "") continue;
    const candidate = path.resolve(root, font, range);
    if (candidate === root || !candidate.startsWith(root + path.sep)) continue; // traversal guard
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
