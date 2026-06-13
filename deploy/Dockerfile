# chest-memory REST backend image.
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t chest-memory .

# --- build stage -------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# OpenSSL is required by Prisma's engine on slim images.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY scripts ./scripts
RUN npm install

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY deploy/mcp-chest-memory.md ./deploy/mcp-chest-memory.md
RUN npm run build

# --- runtime stage -----------------------------------------------------------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# SQLite database and model cache live on the mounted volume.
ENV CHEST_DATA_DIR=/data
ENV CHEST_DB_PATH=/data/chest.db
ENV CHEST_PORT=8765
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8765
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:8765/healthz || exit 1

# Apply migrations, prefetch the embedding model (best-effort — failure must
# NOT block server startup per FR-036), then start the REST backend.
CMD ["sh", "-c", "node dist/bin/init-db.js && (node dist/bin/fetch-model.js || echo '[chest] fetch-model failed; server will start without prefetched model') && node dist/http/server.js"]
