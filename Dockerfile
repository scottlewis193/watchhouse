# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS ffmpeg-build

ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ARG NV_CODEC_HEADERS_VERSION=n11.1.5.4
ARG NV_CODEC_HEADERS_SHA256=cbad7c68365ae50b03fe4cfbea05975c94406bdcc0a995bd094a3ea355656ffb

# Keep the encoder and filter support used by the player when building FFmpeg.
RUN sed -i 's/Components: main/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config nasm yasm \
       libx264-dev libzimg-dev libva-dev libdrm-dev libgnutls28-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp
RUN curl -fsSL --retry 3 -o nv-codec-headers.tar.gz "https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/${NV_CODEC_HEADERS_VERSION}.tar.gz" \
    && echo "${NV_CODEC_HEADERS_SHA256}  nv-codec-headers.tar.gz" | sha256sum -c - \
    && mkdir nv-codec-headers \
    && tar -xf nv-codec-headers.tar.gz -C nv-codec-headers --strip-components=1 \
    && make -C nv-codec-headers install
RUN curl -fsSL --retry 3 -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && mkdir ffmpeg-src \
    && tar -xf ffmpeg.tar.xz -C ffmpeg-src --strip-components=1 \
    && cd ffmpeg-src \
    && ./configure --prefix=/opt/ffmpeg --disable-doc --enable-gpl --enable-libx264 \
       --enable-libzimg --enable-vaapi --enable-libdrm --enable-gnutls --enable-nvenc \
    && make -j "$(nproc)" \
    && make install

FROM node:24-bookworm-slim AS build
WORKDIR /app

# The HLS integration test converts real media during the build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libx264-164 libzimg2 libva2 libva-drm2 libdrm2 libgnutls30 p7zip-full python3 libarchive13 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm test && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Debian's non-free component provides unrar for multi-volume RAR releases.
RUN sed -i 's/Components: main/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libx264-164 libzimg2 libva2 libva-drm2 libdrm2 libgnutls30 gosu intel-media-va-driver mesa-va-drivers passwd unrar p7zip-full python3 libarchive13 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /app/data \
    && chown node:node /app/data
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build

COPY --from=build --chown=node:node /app/scripts/progressive-archive.py ./scripts/progressive-archive.py
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "build"]
