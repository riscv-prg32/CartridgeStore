# PRG32 Cartridge Store frontend

This is the Next.js/TypeScript application for the public storefront and
authenticated dashboard. All application API calls use the explicit Fastify
origin in `NEXT_PUBLIC_PRG32_API_ORIGIN`.

## Development

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
NEXT_PUBLIC_PRG32_API_ORIGIN=http://127.0.0.1:5090 pnpm dev
```

The complete local stack, including the Store, API, Fumadocs and generic
Traefik edge, is:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

Then open `https://store.prg32.test`. Documentation is available at
`https://store.prg32.test/docs`; the API and WebSocket endpoint are published
at `https://api.prg32.test`.

## Checks

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```
