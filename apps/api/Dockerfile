# Deploy artefact for the Render service defined in render.yaml.
#
# Base image update cadence: the digest below should be bumped at least
# monthly (or immediately on a disclosed CVE affecting node:22-alpine) by
# re-checking https://hub.docker.com/_/node/tags?name=22-alpine and updating
# the ARG below - both stages that FROM it pick up the new digest together,
# since they both reference the same ARG.
#
# node:22-alpine, tag "22-alpine", resolved 2026-07-28.
ARG BASE_IMAGE=node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

# ---------------------------------------------------------------------------
# Stage: deps - full (dev + prod) install for the filtered workspace subset,
# reused by the build stage below.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS deps
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/stellar/package.json packages/stellar/package.json
COPY packages/offramp/package.json packages/offramp/package.json
COPY packages/soroban/package.json packages/soroban/package.json

RUN pnpm install --frozen-lockfile --filter @checkout/api...

# ---------------------------------------------------------------------------
# Stage: build - bundles apps/api into a single compiled artefact
# (apps/api/dist/index.js). All workspace source (@checkout/core/stellar/
# offramp) is inlined by esbuild; only apps/api's own real npm dependencies
# (hono, @hono/node-server, drizzle-orm, @libsql/client, zod,
# @stellar/stellar-sdk - see apps/api/package.json's build script's
# --external flags) stay as bare imports, resolved from node_modules at
# runtime. This is what lets the runtime stage below carry no workspace TS
# source or dev tooling at all - just that one file + those six packages.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY packages/core packages/core
COPY packages/stellar packages/stellar
COPY packages/offramp packages/offramp
COPY packages/soroban packages/soroban
COPY apps/api apps/api

WORKDIR /app/apps/api
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage: runtime - slim, production-only. No workspace source, no
# TypeScript/tsx/esbuild/drizzle-kit - just the compiled bundle and its real
# npm runtime dependencies.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime
RUN apk add --no-cache tini && corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/stellar/package.json packages/stellar/package.json
COPY packages/offramp/package.json packages/offramp/package.json
COPY packages/soroban/package.json packages/soroban/package.json

# pnpm's content-addressable store hardlinks into node_modules, but both live in
# this layer, so the store is pure duplicated weight in the shipped image. It has
# to be removed in the SAME `RUN` — a later layer cannot shrink an earlier one.
# (The comment sits above the instruction rather than inside it: a `#` line
# between `\` continuations is a well-known way to silently comment out the rest
# of the command.)
RUN pnpm install --prod --frozen-lockfile --filter @checkout/api... \
 && pnpm store prune \
 && rm -rf /root/.local/share/pnpm/store /root/.cache /root/.npm \
 # The image runs `node dist/index.js` and never a package manager, but the
 # base image ships npm — and npm's own bundled dependencies (tar, sigstore,
 # …) were the source of every CVE Trivy flagged here, including the one
 # CRITICAL. Nothing installs anything at run time, so the package managers
 # are pure attack surface once the install above has finished. Removing them
 # also takes a large bite out of the image size.
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build /app/apps/api/dist /app/apps/api/dist

WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 8787

# Runs as the `node` user baked into the official image (uid 1000) - never
# root. The app writes nothing to disk in production (DATABASE_URL points at
# remote Turso, not a local file) so this image is compatible with running
# under a read-only root filesystem with a tmpfs mounted at /tmp (e.g.
# `docker run --read-only --tmpfs /tmp ...`, or the equivalent
# securityContext on Kubernetes/ECS) - not expressible in render.yaml's
# blueprint format today, so it isn't set there, but nothing in this image
# depends on the root filesystem being writable.
RUN chown -R node:node /app/apps/api
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# tini as PID 1 so SIGTERM (from Docker/Render/Kubernetes) actually reaches
# the Node process and its handlers (see apps/api/src/index.ts's graceful
# shutdown) - without it, `node` running as PID 1 default-ignores several
# signals, and going through a package-manager wrapper (`pnpm start`) adds
# another layer that isn't guaranteed to forward signals either.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
