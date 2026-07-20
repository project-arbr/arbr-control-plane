# Multi-stage: build the dashboard with the full toolchain, then run the server
# from a minimal layer that serves both the API/gateway and the built dashboard
# on one port. The runtime layer carries only production deps and no npm/yarn
# (npm's bundled dependencies are a recurring CVE source flagged by image scans).
FROM node:20-alpine AS webbuild

WORKDIR /app

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

FROM node:20-alpine

# Pick up base-image security fixes (e.g. openssl) without waiting on a new node tag.
RUN apk --no-cache upgrade

WORKDIR /app

# Server deps, then drop the package managers from the runtime layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
            /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Server source + built dashboard (server resolves web/dist relative to its own tree)
COPY server ./server
COPY --from=webbuild /app/web/dist ./web/dist

ENV PORT=4100
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# SEED_ON_BOOT=true loads the synthetic demo dataset. WARNING: seeding WIPES
# existing request records — demo/eval only, never in production (default: skip).
CMD ["sh", "-c", "if [ \"$SEED_ON_BOOT\" = \"true\" ]; then node server/src/seed/seed.js; fi; exec node server/src/index.js"]
