# Development

## Requirements

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
corepack enable
pnpm --version
```

The repository uses pnpm and Node 24. Install dependencies once with
`pnpm install` at the root and in each workspace when needed.

## Local development with dnsmasq, mkcert and Traefik

Dream Platform is not required. The repository includes a generic Traefik
edge overlay and uses `store.prg32.test` plus `api.prg32.test` by default.
These are local-only names; choose another suffix by changing the variables in
`.env`.

### 1. Configure local DNS

Install dnsmasq using the package manager for the host, then add a file such as
`/etc/dnsmasq.d/prg32.conf`:

```ini
address=/.prg32.test/127.0.0.1
```

Restart dnsmasq and verify that both names resolve to the machine running
Docker:

```bash
dig +short store.prg32.test
dig +short api.prg32.test
```

If Docker is running on another machine, replace `127.0.0.1` with that
machine's LAN address. The DNS suffix, Compose variables and certificate names
must all match.

### 2. Create trusted local TLS with mkcert

Install [mkcert](https://github.com/FiloSottile/mkcert), then run:

```bash
cp .env.example .env
./deploy/local/setup-tls.sh
```

The script runs `mkcert -install`, creates the local CA when needed, and writes
`.local/tls/prg32-local.pem` plus `.local/tls/prg32-local-key.pem` for both
configured hostnames. The files are ignored by Git. If you choose custom
domains, set `PRG32_STORE_DOMAIN` and `PRG32_API_DOMAIN` before running the
script so the certificate contains those exact names.

### 3. Start the stack with the repository-owned Traefik edge

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.traefik.yml \
  up -d --build
```

The overlay starts Traefik, publishes ports 80 and 443, redirects HTTP to
HTTPS, loads the mkcert certificate, routes `/api` and WebSocket traffic to
Fastify, `/` to Next.js and `/docs` to the separate Fumadocs service. It uses a
normal Docker network named by `PRG32_TRAEFIK_NETWORK`; no `dream_edge`,
Dream-specific middleware or Dream Platform installation is needed.

Open:

- `https://store.prg32.test` — Next storefront;
- `https://store.prg32.test/docs` — Fumadocs documentation;
- `https://api.prg32.test/health` — Fastify liveness;
- `https://api.prg32.test/ready` — Fastify readiness.

The base Compose file still supports the standalone Nginx edge through its
default `nginx` service. Use that mode only when you specifically want Nginx;
do not start it together with the Traefik overlay because both need ports 80
and 443.

Dream Platform remains an optional integration. Use
`docker-compose.dream-platform.yml` only when an existing Dream Traefik edge
and its external networks are intentionally available.

The canonical local data root defaults to `.local/candidate/canonical`; set
`PRG32_CANONICAL_DATA_DIR` to an explicit disposable directory when required.
Never point this development stack at operational data.

The root `.env` is loaded automatically by Compose. Keep these values aligned
when using a custom local suffix:

```dotenv
PRG32_STORE_DOMAIN=store.prg32.test
PRG32_API_DOMAIN=api.prg32.test
PRG32_STORE_ORIGIN=https://store.prg32.test
PRG32_API_ORIGIN=https://api.prg32.test
PRG32_SESSION_COOKIE_DOMAIN=.prg32.test
```

The certificate files live under `.local/tls` and are ignored by Git. If the
host ports are already in use, set `PRG32_HTTP_PORT` and `PRG32_HTTPS_PORT` for
a temporary alternate port, or stop the previous edge before starting this
stack. The normal standalone edge uses ports 80 and 443.

## Direct processes

Run the API:

```bash
pnpm --dir backend dev
```

Run the frontend with an explicit API origin:

```bash
NEXT_PUBLIC_PRG32_API_ORIGIN=http://127.0.0.1:5090 \
  pnpm --dir frontend dev
```

Run the documentation service directly when iterating on Fumadocs:

```bash
NEXT_PUBLIC_PRG32_STORE_ORIGIN=http://127.0.0.1:3000 \
  pnpm --dir docs-site dev
```

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
docker compose config
pytest -q
git diff --check
```
