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
# Run as the host service user (uid 993 / gid 980 = dainipc-service) so the
# container process can write to the host bind-mount without sudo.
# /app is pre-owned by the same uid; /data ownership is set by the bind mount.
RUN mkdir -p /data && chown -R 993:980 /data /app
VOLUME /data
EXPOSE 8765
USER 993:980

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:8765/healthz || exit 1

# Apply migrations, then start the REST backend.
CMD ["sh", "-c", "node dist/bin/init-db.js && node dist/http/server.js"]
