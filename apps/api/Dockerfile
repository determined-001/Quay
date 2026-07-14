# Build context is the repo root (see fly.toml) — the API imports @checkout/core,
# @checkout/stellar, and @checkout/offramp as workspace TS source (no dist step),
# so the image needs those package sources alongside apps/api.

FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/stellar/package.json packages/stellar/package.json
COPY packages/offramp/package.json packages/offramp/package.json

RUN pnpm install --frozen-lockfile --filter @checkout/api...

COPY packages/core packages/core
COPY packages/stellar packages/stellar
COPY packages/offramp packages/offramp
COPY apps/api apps/api

WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "start"]
