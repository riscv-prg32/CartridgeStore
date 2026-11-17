# PRG32 Cartridge Store

PRG32 Cartridge Store is the classroom service for `.prg32` cartridges. The
runtime is a Fastify/TypeScript API paired with a Next.js frontend.

## Development

The local development stack can use any private DNS suffix. The documented
default is `prg32.test`, resolved by dnsmasq and terminated by the repository's
generic Traefik overlay:

- <https://store.prg32.test> — Next.js storefront and dashboard;
- <https://store.prg32.test/docs> — dedicated Fumadocs documentation service;
- <https://api.prg32.test> — Fastify API and WebSocket relay.

Dream Platform is not required. Email is kept in memory in the disposable
development profile; configure SMTP from the Store settings when a real mail
service is needed.

These are local-only development hosts. Production runs on another server and
must configure its own registered storefront/API domains, HTTPS origins,
cookie domain, certificates and WebSocket URL through the operational Compose
template.

Start the development topology with Node.js 24 and Docker Desktop:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
cp .env.example .env
# Add the two hosts to dnsmasq; see docs/development.md.
./deploy/local/setup-tls.sh
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

Persistent canonical development data is kept in `.local/candidate/canonical`;
it is not modified by the application build. Local TLS files are generated in
`.local/tls` and are not committed.

## Public contracts

The Fastify service preserves the catalog, download, scores, metrics,
multiplayer, discovery, authentication, federation, and publishing contracts.
Firmware-facing constants remain unchanged, including `esp32c6`, `qemu`,
`prg32-metadata-1.0`, `prg32-colophon-1.0`, and
`prg32-store-discovery-1.0`.

The public API is documented in [docs/api.md](docs/api.md). The current
topology and operational boundaries are described in
[docs/architecture.md](docs/architecture.md).
The dedicated Fumadocs application and its content workflow are described in
[docs-site/README.md](docs-site/README.md).
The generic local DNS, TLS and Traefik contract is documented in
[docs/development.md](docs/development.md). Dream Platform remains an optional
integration documented in [docs/dream-platform.md](docs/dream-platform.md).

## Validation

```bash
pnpm --dir frontend run typecheck
pnpm --dir frontend run lint
pnpm --dir frontend run test
pnpm --dir frontend run build
pnpm --dir backend run typecheck
pnpm --dir backend run lint
pnpm --dir backend run test
pnpm --dir backend run build
pnpm --dir docs-site run typecheck
pnpm --dir docs-site run build
docker compose -f docker-compose.yml -f docker-compose.traefik.yml config
pytest -q
git diff --check
```

The runtime cutover audit and remaining work are tracked in
`docs/modernization/`.
