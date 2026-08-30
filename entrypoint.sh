#!/bin/sh
# Container entrypoint: the Node orchestrator is the container's main
# process. On startup it either builds the tileset (Planetiler one-shot) or
# skips to serving when openmaptiles.mbtiles already exists, then spawns
# and supervises Martin for the life of the container (see README.md).
set -eu

# /data holds the PBF, openmaptiles.mbtiles, and Planetiler's cached
# source data (Natural Earth + water polygons) — usually a podman volume.
mkdir -p /data

exec node /app/dist/server.js
