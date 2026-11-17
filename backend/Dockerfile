FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@12.5.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json eslint.config.mjs ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PRG32_BACKEND_HOST=0.0.0.0
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /writer-data /writer-shadow /writer-store \
    && chmod 700 /writer-data /writer-shadow /writer-store \
    && chown -R node:node /writer-data /writer-shadow /writer-store

USER node
EXPOSE 5090
CMD ["node", "dist/server.js"]
