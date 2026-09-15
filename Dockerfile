# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

# The HLS integration test converts real media during the build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg p7zip-full python3 libarchive13 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm test && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Debian's non-free component provides unrar for multi-volume RAR releases.
RUN sed -i 's/Components: main/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg gosu intel-media-va-driver mesa-va-drivers passwd unrar p7zip-full python3 libarchive13 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /app/data \
    && chown node:node /app/data

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
