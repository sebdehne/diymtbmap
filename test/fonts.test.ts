import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { resolveGlyphFile } from "../src/fonts.js";

const dir = mkdtempSync(join(tmpdir(), "mtb-fonts-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Creates a self-contained public dir with the given fonts (each with the pbf). */
function withFonts(fonts: string[], fn: (publicDir: string) => void): void {
  const pub = join(dir, `pub-${fonts.length}-${fonts.join("_").replace(/[ ,]/g, "-")}`);
  for (const font of fonts) {
    const fdir = join(pub, font);
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, "0-255.pbf"), `glyphs:${font}`);
  }
  fn(pub);
}

test("resolves a joined stack to the first font that provides the range", () => {
  withFonts(["Noto Sans Regular", "Open Sans Semibold"], (pub) => {
    const file = resolveGlyphFile(pub, "Open Sans Semibold,Noto Sans Regular", "0-255.pbf");
    assert.equal(file, join(pub, "Open Sans Semibold", "0-255.pbf"));
  });
});

test("falls through to later fonts when the first has no such range", () => {
  withFonts(["Open Sans Semibold", "Noto Sans Regular"], (pub) => {
    // Remove the range from the first font so resolution must skip it.
    rmSync(join(pub, "Open Sans Semibold", "0-255.pbf"));
    const file = resolveGlyphFile(pub, "Open Sans Semibold,Noto Sans Regular", "0-255.pbf");
    assert.equal(file, join(pub, "Noto Sans Regular", "0-255.pbf"));
  });
});

test("whitespace and empty stack entries are tolerated", () => {
  withFonts(["Open Sans Regular"], (pub) => {
    const file = resolveGlyphFile(pub, " Open Sans Regular ,, ", "0-255.pbf");
    assert.equal(file, join(pub, "Open Sans Regular", "0-255.pbf"));
  });
});

test("returns null when no font in the stack has the range", () => {
  withFonts(["Open Sans Semibold"], (pub) => {
    assert.equal(resolveGlyphFile(pub, "Open Sans Semibold,Missing Font", "1000-1100.pbf"), null);
  });
});

test("single-font paths (no comma) are left to the static handler", () => {
  withFonts(["Open Sans Regular"], (pub) => {
    assert.equal(resolveGlyphFile(pub, "Open Sans Regular", "0-255.pbf"), null);
  });
});

test("non-glyph ranges are left to the static handler even with a stack", () => {
  withFonts(["Open Sans Semibold", "Open Sans Regular"], (pub) => {
    assert.equal(
      resolveGlyphFile(pub, "Open Sans Semibold,Open Sans Regular", "sprite.png"),
      null,
    );
  });
});

test("path traversal in the stack cannot escape the public dir", () => {
  withFonts(["Noto Sans Regular"], (pub) => {
    const file = resolveGlyphFile(pub, "../..,Noto Sans Regular", "0-255.pbf");
    assert.equal(file, join(pub, "Noto Sans Regular", "0-255.pbf"));
  });
});
