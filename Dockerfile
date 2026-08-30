# syntax=docker/dockerfile:1
#
# Single multi-process toolchain image for the Norway MTB map.
# Node 26 on Debian bookworm + Temurin JRE 21 + Martin 1.14.
# All versions are pinned for reproducible builds.
#
# Pinned upstream / apt versions:
#   node            26.8.1   (base image)
#   curl            7.88.1-10+deb12u15
#   ca-certificates 20250419~deb12u1
#   unzip           6.0-28+deb12u1
#   martin          1.14.0    (static musl binary, SHA256-pinned)
#   jre             Temurin 21.0.9+10 (eclipse-temurin:21.0.9_10-jre-jammy)
#   tileset profile openmaptiles/planetiler-openmaptiles v3.16 release jar
#                   (self-contained: profile + planetiler 0.9.3 + deps,
#                   Main-Class org.openmaptiles.OpenMapTilesMain), SHA256-pinned
#   mtb profile     ./mtb-profile (this repo) built with
#                   maven:3.9.11-eclipse-temurin-21 (self-contained:
#                   profile + planetiler 0.9.3 core,
#                   Main-Class com.diymtbmap.mtb.MtbMain)
#   glyph fonts     openmaptiles/fonts v2.0 noto-open-sans.zip, SHA256-pinned
#   OMT style       openmaptiles/openmaptiles v3.16 source tarball,
#                   SHA256-pinned, compiled with openmaptiles-tools:7.2
#   npm deps        pinned via package-lock.json (npm ci)

# --- Stage 1: compile the server + build the React UI -----------------------
# Separate build stage keeps dev-only tooling (typescript, eslint, tsx, vite,
# react) out of the runtime image: npm ci -> tsc + vite build -> prune dev
# deps. react / react-dom / maplibre-gl are devDependencies on purpose — Vite
# bundles them into public/assets, so the runtime never needs them.
FROM node:26.8.1-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY vite.config.js ./
COPY src/ ./src/
COPY web/ ./web/
COPY shared/ ./shared/
RUN npm run build \
    && npm run build:web \
    && npm prune --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# --- Stage: build the MapLibre style + spritesheet from OMT source ---------
# openmaptiles/openmaptiles v3.16 (style-header + 16 per-layer snippets +
# 306 icons) compiled with the official tools image (style-tools recompose
# + spreet). Deterministic: output verified byte-identical to the local
# `npm run vendor-style` result.
FROM openmaptiles/openmaptiles-tools:7.2 AS style
ARG OMT_STYLE_VERSION=v3.16
# SHA256 of https://github.com/openmaptiles/openmaptiles/archive/refs/tags/v3.16.tar.gz
ARG OMT_STYLE_SHA256=91309732d52ec2323bbf1d8ddb9c8d750d2ca571f43d034cc071bbc5d2d26756
RUN set -eux; \
    curl -fsSL -o /tmp/omt.tar.gz \
        "https://github.com/openmaptiles/openmaptiles/archive/refs/tags/${OMT_STYLE_VERSION}.tar.gz"; \
    echo "${OMT_STYLE_SHA256}  /tmp/omt.tar.gz" | sha256sum --check -; \
    mkdir -p /omt /out; \
    tar -xzf /tmp/omt.tar.gz -C /omt --strip-components=1; \
    rm -f /tmp/omt.tar.gz; \
    cd /omt; \
    style-tools recompose openmaptiles.yaml /out/style.json style/style-header.json; \
    spreet style/icons /out/sprite; \
    spreet --retina style/icons /out/sprite@2x; \
    test -s /out/style.json; \
    test -s /out/sprite.json; test -s /out/sprite.png; \
    test -s /out/sprite@2x.json; test -s /out/sprite@2x.png

# --- Stage: build the mtb-profile jar (step 11) ------------------------------
# The dedicated low-zoom MTB overlay profile (every way with an mtb:scale tag
# as layer `mtb` / attribute `mtb_scale`, z MTB_MINZOOM..14) from the
# ./mtb-profile source in this repo. Built once at image build time with
# Maven + JDK 21; the shaded jar is self-contained (planetiler 0.9.3 core,
# Main-Class com.diymtbmap.mtb.MtbMain) and runs on the JRE stage below.
FROM maven:3.9.11-eclipse-temurin-21 AS mtb-profile
WORKDIR /build
COPY mtb-profile/pom.xml ./pom.xml
COPY mtb-profile/src ./src
RUN mvn -B -ntp package \
    && test -f target/mtb-profile.jar

# --- Stage: the Temurin JRE 21 (exact version tag, multi-arch) --------------
FROM eclipse-temurin:21.0.9_10-jre-jammy AS jre

FROM node:26.8.1-bookworm

# Step 11 (decision B1): the MTB overlay tileset's start zoom. Build-time by
# design — it is baked into the tile data (which tiles exist), so changing it
# requires regenerating mtb.mbtiles: docker build --build-arg MTB_MINZOOM=<N>
# and FORCE_REIMPORT=1 at runtime (the mtb_minzoom metadata + the app's
# mismatch check fail fast on a stale artifact).
ARG MTB_MINZOOM=3

ARG TARGETARCH
ARG CURL_VERSION=7.88.1-10+deb12u15
ARG CA_CERTS_VERSION=20250419~deb12u1
ARG UNZIP_VERSION=6.0-28+deb12u1
ARG MARTIN_VERSION=1.14.0
# Static musl builds (portable; no glibc/libuv dependency on the host distro).
# SHA256 values verified against the downloaded release assets.
ARG MARTIN_SHA256_AMD64=8d1c2b0945a812e4c00a0af8504087e988f379ee9c8d51c6e961137d2dfd90a5
ARG MARTIN_SHA256_ARM64=56e938d666f38bd075c3ec9ae44e03380a6b4146ce6b47cadb4e9f4d4c1c6942
# openmaptiles/planetiler-openmaptiles release v3.16 (SHA256 verified against
# the release's planetiler-openmaptiles.jar.sha256).
ARG OMT_PROFILE_VERSION=v3.16
ARG OMT_PROFILE_SHA256=246cd5c9c10102a3bcc58465ae7dde5b97aa4cee6524ea25788e23333ba2579d
# openmaptiles/fonts release v2.0, asset noto-open-sans.zip (glyph pbf for the
# style's "{fontstack}/{range}.pbf"; SHA256 verified at build time).
ARG FONT_VERSION=v2.0
ARG FONT_SHA256=1a5d6323621d556ec120eaf95398d5093abb9f5181a17c9b8867e214b3f4312b

ENV DEBIAN_FRONTEND=noninteractive \
    OSM_FILE=/data/norway-latest.osm.pbf \
    DATA_DIR=/data \
    PLANETILER_JAR=/opt/planetiler/planetiler-openmaptiles.jar \
    MTB_MINZOOM="${MTB_MINZOOM}" \
    MTB_PROFILE_JAR=/opt/planetiler/mtb-profile.jar \
    MTB_MBTILES_FILE=/data/mtb.mbtiles \
    MTB_HEAP_MB=2048 \
    JAVA_HOME=/opt/java/openjdk \
    PATH="/opt/java/openjdk/bin:${PATH}"

WORKDIR /app

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64) MARTIN_TRIPLE=x86_64-unknown-linux-musl; MARTIN_SHA256="${MARTIN_SHA256_AMD64}" ;; \
        arm64) MARTIN_TRIPLE=aarch64-unknown-linux-musl; MARTIN_SHA256="${MARTIN_SHA256_ARM64}" ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates="${CA_CERTS_VERSION}" \
        curl="${CURL_VERSION}" \
        unzip="${UNZIP_VERSION}"; \
    curl -fsSL -o /tmp/martin.tar.gz \
        "https://github.com/maplibre/martin/releases/download/martin-v${MARTIN_VERSION}/martin-${MARTIN_TRIPLE}.tar.gz"; \
    echo "${MARTIN_SHA256}  /tmp/martin.tar.gz" | sha256sum --check -; \
    mkdir -p /opt/martin /data; \
    tar -xzf /tmp/martin.tar.gz -C /opt/martin; \
    ln -sf /opt/martin/martin /usr/local/bin/martin; \
    ln -sf /opt/martin/mbtiles /usr/local/bin/mbtiles; \
    rm -f /tmp/martin.tar.gz; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Temurin JRE 21 (the profile jar is compiled for Java 21).
COPY --from=jre /opt/java/openjdk /opt/java/openjdk

# The self-contained Planetiler OpenMapTiles profile jar (release v3.16):
# one jar to run the whole PBF -> openmaptiles.mbtiles build, no Maven.
RUN set -eux; \
    curl -fsSL -o /tmp/planetiler-openmaptiles.jar \
        "https://github.com/openmaptiles/planetiler-openmaptiles/releases/download/${OMT_PROFILE_VERSION}/planetiler-openmaptiles.jar"; \
    echo "${OMT_PROFILE_SHA256}  /tmp/planetiler-openmaptiles.jar" | sha256sum --check -; \
    mkdir -p /opt/planetiler; \
    mv /tmp/planetiler-openmaptiles.jar /opt/planetiler/planetiler-openmaptiles.jar

# The self-contained mtb-profile jar (step 11): one jar to run the whole
# PBF -> mtb.mbtiles build (ways with mtb:scale, z MTB_MINZOOM..14), no Maven
# at runtime.
COPY --from=mtb-profile /build/target/mtb-profile.jar /opt/planetiler/mtb-profile.jar

# Fail the build if any piece of the toolchain is missing.
RUN set -eux; \
    node --version; \
    java -version; \
    martin --version; \
    java -jar /opt/planetiler/planetiler-openmaptiles.jar --help > /dev/null; \
    java -jar /opt/planetiler/mtb-profile.jar --help > /dev/null; \
    echo "toolchain OK"

# Entrypoint: the Node orchestrator is the container's main process. It runs
# the one-shot tileset build if needed, then spawns + supervises Martin.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Compiled JS + production deps from the build stage, the built UI
# (public/index.html + public/assets/, from web/ via Vite), the Martin
# config, and the MapLibre style + spritesheet built in the `style` stage.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=style /out/style.json ./public/style.json
COPY --from=style /out/sprite.json ./public/sprite.json
COPY --from=style /out/sprite.png ./public/sprite.png
COPY --from=style /out/sprite@2x.json ./public/sprite@2x.json
COPY --from=style /out/sprite@2x.png ./public/sprite@2x.png
COPY martin.yaml ./martin.yaml

# Glyph pbf font stacks (gitignored in the repo; same pin + SHA256 as
# scripts/vendor-fonts.sh for local dev): ~2,570 files under
# public/<fontstack>/<range>.pbf.
RUN set -eux; \
    curl -fsSL -o /tmp/noto-open-sans.zip \
        "https://github.com/openmaptiles/fonts/releases/download/${FONT_VERSION}/noto-open-sans.zip"; \
    echo "${FONT_SHA256}  /tmp/noto-open-sans.zip" | sha256sum --check -; \
    unzip -q -o /tmp/noto-open-sans.zip -d /app/public; \
    rm -f /tmp/noto-open-sans.zip; \
    test -f /app/public/Open\ Sans\ Regular/0-255.pbf

ENTRYPOINT ["/entrypoint.sh"]

# Single-port serving (step 12): the app's port is the ONLY port the browser
# (and the world) sees — UI, style, sprite, glyphs AND tiles (proxied to
# Martin internally). Martin is loopback-bound; do not publish 3000.
EXPOSE 8080
