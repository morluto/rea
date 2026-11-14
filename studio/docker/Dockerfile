# Build from the repository root: docker build -f studio/docker/Dockerfile .
FROM node:24.22.1-trixie-slim

ENV NEXT_TELEMETRY_DISABLED=1 HUSKY=0
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git procps chromium default-jdk-headless apktool \
    build-essential pkg-config rustc cargo golang-go python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@11.16.0

WORKDIR /app
COPY . .
RUN npm ci && npm run build:cached
WORKDIR /app/studio
RUN npm ci && npm run build

# Use the same pinned, digest-checked JADX engine as the REA checkout.
RUN mkdir -p /opt/reall/providers && node docker/install-jadx.mjs
ENV REA_JADX_MCP_JAR=/opt/reall/providers/jadx.jar \
    STUDIO_HOME=/data/reall STUDIO_HOST=0.0.0.0 STUDIO_PORT=4317 \
    STUDIO_BROWSER_PATH=/usr/bin/chromium
RUN mkdir -p /data/reall/projects && chown -R node:node /app /data/reall

USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
    CMD curl --fail --silent http://127.0.0.1:4317/ > /dev/null || exit 1
CMD ["npm", "run", "studio"]
