#!/bin/sh
# Build the OpenMapTiles v3.16 MapLibre style + spritesheet into public/
# (style.json, sprite.json, sprite.png, sprite@2x.json, sprite@2x.png).
#
# Runs the official openmaptiles/openmaptiles-tools:7.2 image — the exact
# same build the Dockerfile `style` stage does (same tarball pin + SHA256,
# same commands), so the output is byte-identical. Needs docker or podman.
#
# Run this once locally before `npm run dev` / `npm start` so the style's
# "sprite": "sprite" URLs resolve.
set -eu

TOOLS_IMAGE=openmaptiles/openmaptiles-tools:7.2
OMT_TAG=v3.16
OMT_SHA256=91309732d52ec2323bbf1d8ddb9c8d750d2ca571f43d034cc071bbc5d2d26756

cd "$(dirname "$0")/.."

# Already built?
if [ -f public/style.json ] && [ -f public/sprite@2x.png ]; then
    echo "[vendor-style] public/ already has style + sprite — nothing to do"
    exit 0
fi

if command -v docker > /dev/null 2>&1; then
    RUN=docker
elif command -v podman > /dev/null 2>&1; then
    RUN=podman
else
    echo "[vendor-style] need docker or podman to build the style" >&2
    exit 1
fi

echo "[vendor-style] building OMT ${OMT_TAG} style with ${TOOLS_IMAGE}"
"$RUN" run --rm -e OMT_TAG="$OMT_TAG" -e OMT_SHA256="$OMT_SHA256" "$TOOLS_IMAGE" sh -c '
set -eu
mkdir -p /omt /out
curl -fsSL -o /tmp/omt.tar.gz \
    "https://github.com/openmaptiles/openmaptiles/archive/refs/tags/${OMT_TAG}.tar.gz"
echo "${OMT_SHA256}  /tmp/omt.tar.gz" | sha256sum --check - 1>&2
tar -xzf /tmp/omt.tar.gz -C /omt --strip-components=1
cd /omt
style-tools recompose openmaptiles.yaml /out/style.json style/style-header.json
spreet style/icons /out/sprite
spreet --retina style/icons /out/sprite@2x
tar -cf - -C /out style.json sprite.json sprite.png sprite@2x.json sprite@2x.png
' | tar -xf - -C public

echo "[vendor-style] done: $(ls public/style.json public/sprite*.* | wc -l | tr -d ' ') files in public/"
