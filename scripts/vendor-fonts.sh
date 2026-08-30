#!/bin/sh
# Fetch the OpenMapTiles glyph fonts (openmaptiles/fonts release v2.0,
# asset noto-open-sans.zip) into public/<fontstack>/<range>.pbf.
#
# The container image does this at build time (Dockerfile, same pin +
# SHA256); run this once locally before `npm run dev` / `npm start` so the
# style's glyphs: "{fontstack}/{range}.pbf" URLs resolve.
set -eu

FONT_TAG=v2.0
FONT_ZIP=noto-open-sans.zip
FONT_URL="https://github.com/openmaptiles/fonts/releases/download/${FONT_TAG}/${FONT_ZIP}"
FONT_SHA256=1a5d6323621d556ec120eaf95398d5093abb9f5181a17c9b8867e214b3f4312b

cd "$(dirname "$0")/.."
cd public

# Already vendored?
if [ -d "Open Sans Regular" ]; then
    echo "[vendor-fonts] public/ already has the font stacks — nothing to do"
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[vendor-fonts] downloading ${FONT_URL}"
curl -fL --retry 3 -o "$TMP/$FONT_ZIP" "$FONT_URL"

echo "[vendor-fonts] verifying SHA256"
if command -v shasum > /dev/null; then
    ( cd "$TMP" && echo "${FONT_SHA256}  ${FONT_ZIP}" | shasum -a 256 -c - )
else
    ( cd "$TMP" && echo "${FONT_SHA256}  ${FONT_ZIP}" | sha256sum -c - )
fi

echo "[vendor-fonts] extracting into public/"
unzip -q -o "$TMP/$FONT_ZIP" -d .

echo "[vendor-fonts] done: $(ls -d */ | wc -l | tr -d ' ') font stacks, $(find . -name '*.pbf' | wc -l | tr -d ' ') pbf files"
