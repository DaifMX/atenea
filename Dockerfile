# syntax=docker/dockerfile:1.7
#
# ATENEA agent image (phase 1).
# Multi-stage: install workspace deps → build TS packages → slim runtime.
# A second image for the Python indexer service will live under
# services/indexer/ once phase 3 lands; compose.yaml is shaped to host both.

ARG NODE_VERSION=22

# ─── base ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app

# ─── deps: install with only manifests for cache friendliness ───────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json       packages/cli/package.json
COPY packages/config/package.json    packages/config/package.json
COPY packages/core/package.json      packages/core/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/tools/package.json     packages/tools/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── build: compile all workspace packages ──────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm -r build

# ─── runtime: minimal image with built artifacts ────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    ATENEA_HOME=/data
WORKDIR /app

# Copy resolved workspace (pnpm symlinks are preserved across COPY).
COPY --from=build /app/package.json      /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules      ./node_modules
COPY --from=build /app/packages          ./packages

# Persistent state (~/.atenea/ equivalent) and host project mount point.
# Reuse the upstream `node` user (uid 1000) shipped by node:*-bookworm-slim
# so bind-mounted host files keep matching ownership on Linux.
RUN mkdir -p /data /work && chown -R node:node /app /data /work
USER node
WORKDIR /work

ENTRYPOINT ["node", "/app/packages/cli/dist/index.js"]
