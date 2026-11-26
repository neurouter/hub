# syntax=docker/dockerfile:1.7
# Neurouter Hub image (backend plan §16.1). glibc base: onnxruntime-node and the sqlite-vec prebuilds target glibc.
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -t neurouter:dev .
ARG NODE_IMAGE=node:26.13.1-bookworm-slim

# ---------------------------------------------------------------- toolchain for native modules (better-sqlite3 builds from source when no prebuild matches)
FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- all dependencies (build)
FROM toolchain AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build shared + web + server, fetch the model
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
RUN npm run build -w @neurouter/shared && npm run build -w @neurouter/web && npm run build -w @neurouter/server
ARG EMBEDDINGS_MODEL=onnx-community/granite-embedding-small-english-r2-ONNX
ARG EMBEDDINGS_DTYPE=q8
# baked into the image so it runs air-gapped (EMBEDDINGS_ALLOW_REMOTE=false at runtime)
RUN EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL} EMBEDDINGS_DTYPE=${EMBEDDINGS_DTYPE} MODELS_DIR=/app/models node apps/server/dist/scripts/fetch-model.js

# ---------------------------------------------------------------- production dependencies of the server only
FROM toolchain AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @neurouter/server --include-workspace-root=false \
 && mkdir -p apps/server/node_modules packages/shared/node_modules

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG EMBEDDINGS_MODEL=onnx-community/granite-embedding-small-english-r2-ONNX
ARG EMBEDDINGS_DTYPE=q8
ENV NODE_ENV=production \
    PORT=3000 \
    MODELS_DIR=/app/models \
    EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL} \
    EMBEDDINGS_DTYPE=${EMBEDDINGS_DTYPE} \
    EMBEDDINGS_ALLOW_REMOTE=false \
    WEB_DIST_DIR=/app/apps/web/dist \
    SERVE_WEB=true \
    DATABASE_URL=sqlite:/data/neurouter.db
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# npm nests a workspace's dependency when another version is hoisted to the root (ajv 8 here)
COPY --from=prod-deps --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/models ./models
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Neurouter Hub" \
      org.opencontainers.image.description="Self-hosted, open-source MCP gateway: SSO, OAuth 2.1, per-tool access control, human approvals, tamper-evident audit log." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/neurouter/hub" \
      org.opencontainers.image.url="https://hub.neurouter.com" \
      org.opencontainers.image.documentation="https://hub.neurouter.com/docs" \
      org.opencontainers.image.vendor="Perspektives Digital Oy" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      io.modelcontextprotocol.server.name="com.neurouter/hub"
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# a 16 MB young generation keeps RSS flat on long streams (100k-row audit export: ~190 MB peak instead of ~300 MB)
CMD ["node", "--max-semi-space-size=16", "--import", "./apps/server/dist/instrumentation.js", "apps/server/dist/main.js"]
