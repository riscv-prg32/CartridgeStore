# Deployment

Deployment templates use the Fastify API and Next.js frontend behind an
operator-controlled reverse proxy. Local development additionally runs the
standalone Fumadocs service and recommends the repository-owned Traefik edge;
the Nginx edge remains available as an alternative.

## Local and production hosts

The local dnsmasq setup resolves these development-only hosts. The generic
Traefik overlay terminates TLS and routes them; the root Compose file can also
be combined with the optional Nginx profile or the optional Dream integration:

| Local host | Service |
| --- | --- |
| `store.prg32.test` | Next.js storefront |
| `api.prg32.test` | Fastify API and WebSocket relay |

The Store host also serves `/docs` through the separate Fumadocs container.

Do not publish those names as production URLs. Production runs on a different
server and must set its own registered hostnames and HTTPS origins before
starting `deploy/operational/compose.yaml`:

| Variable | Production value |
| --- | --- |
| `PRG32_STORE_DOMAIN` | Store hostname used by the selected edge |
| `PRG32_API_DOMAIN` | API hostname used by the selected edge |
| `PRG32_FRONTEND_PUBLIC_ORIGIN` | Full HTTPS storefront origin |
| `PRG32_API_PUBLIC_ORIGIN` | Full HTTPS API origin |
| `PRG32_API_WS_URL` | Full `wss://` multiplayer endpoint |
| `PRG32_COOKIE_DOMAIN` | Cookie domain matching the production host policy |

TLS terminates at the reverse proxy. The API validates the configured public
origins and trusts forwarded headers only when `PRG32_BACKEND_TRUST_PROXY` is
explicitly enabled.

## Persistent data and secrets

Mount the canonical data directory at `/data/canonical`. It contains SQLite,
cartridge objects, publication state and managed assets. Do not mount a host
path from the repository for a production deployment.

Use Docker secrets for the session secret, bootstrap token, canonical read/write
authorizations and encrypted secret key registry.

Keep the container filesystem read-only, drop capabilities, and provide a
small writable `/tmp` tmpfs as shown in the deployment templates.

## Health checks

Route traffic only after:

```text
GET http://backend:5080/health -> 200
GET http://backend:5080/ready  -> 200
GET http://next:3000/health    -> 200
```

The public reverse proxy must preserve WebSocket upgrades for
`/api/multiplayer`.

## Verification

```bash
docker compose -f deploy/operational/compose.yaml config
docker compose -f deploy/standalone/compose.yaml config
docker compose -f docker-compose.yml -f docker-compose.traefik.yml config
docker build -f backend/Dockerfile.operational -t prg32-cartridge-store-backend:local backend
docker build -f frontend/Dockerfile.operational -t prg32-cartridge-store-frontend:local frontend
```
