# Single image: builds the dashboard, then runs the server which serves both the
# API/gateway and the built dashboard on one port.
FROM node:20-alpine

WORKDIR /app

# Server deps
COPY package.json ./
RUN npm install --omit=dev

# Web deps + build
COPY web/package.json ./web/package.json
RUN npm --prefix web install
COPY web ./web
RUN npm --prefix web run build

# Server source
COPY server ./server

ENV PORT=4100
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# SEED_ON_BOOT=true loads the synthetic demo dataset. WARNING: seeding WIPES
# existing request records — demo/eval only, never in production (default: skip).
CMD ["sh", "-c", "if [ \"$SEED_ON_BOOT\" = \"true\" ]; then node server/src/seed/seed.js; fi; exec node server/src/index.js"]
