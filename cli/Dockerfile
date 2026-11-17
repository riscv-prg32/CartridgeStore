FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@12.5.1
COPY cli/package.json cli/pnpm-lock.yaml cli/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --no-optional

FROM dependencies AS builder
COPY cli/tsconfig.json ./
COPY cli/src ./src
RUN pnpm run build
RUN pnpm prune --prod --no-optional

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/main.js"]
