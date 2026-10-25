FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @agent-recorder/mcp... --filter @agent-recorder/hosted... --filter @content-layer/render-worker... build
RUN rm -rf node_modules && CI=true pnpm install --prod --offline --frozen-lockfile
# Only decoder WASM and the bundled default cursor are used; don't ship optional artwork.
RUN rm -rf vendor/openscreen/public

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3002 DATA_DIR=/data RENDER_BROWSER_BINARY=/usr/bin/chromium RENDER_BUNDLE_DIRECTORY=/app/apps/render-worker/dist-web
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-driver ffmpeg dumb-init gosu util-linux ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
# Capture encodes timestamped browser frames as VP9 before the presentation render.
# A working ffmpeg executable alone does not establish this runtime prerequisite.
RUN ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libvpx-vp9 '
COPY --from=build /app /app
RUN chmod +x infra/start.sh
ENTRYPOINT ["dumb-init", "--", "/app/infra/start.sh"]
