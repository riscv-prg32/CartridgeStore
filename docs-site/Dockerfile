FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

COPY docs-site/package.json docs-site/pnpm-lock.yaml docs-site/pnpm-workspace.yaml ./
COPY docs-site/source.config.ts ./source.config.ts
COPY frontend/content ./content
RUN corepack enable && pnpm install --frozen-lockfile

FROM dependencies AS builder

ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production

COPY docs-site .
RUN corepack enable && pnpm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node

EXPOSE 3000

CMD ["node", "server.js"]
