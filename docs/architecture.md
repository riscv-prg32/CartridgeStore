# Architecture

## Runtime topology

```text
              Local Traefik edge (default)
                    or selected proxy
                              │
                 ┌────────────┼────────────┐
                 │                         │
       store.prg32.test      api.prg32.test
                 │                         │
             Next.js :3000             Fastify :5090
                 │
          `/docs` → Fumadocs :3000
                 │                         │
                 └────── browser API ────┘
                              │
                 optional configured SMTP service
```

The diagram shows the local dnsmasq-backed `.prg32.test` environment only.
Production uses the same service topology with operator-provided domains and
origins. The selected edge (generic Traefik by default, or Nginx/Dream when
explicitly configured) owns local TLS and host routing. The browser calls the
API origin directly; Next does not proxy application routes. Fastify owns HTTP, WebSocket,
authentication, catalog, publication, telemetry, statistics and discovery.

## Local Compose

The development Compose file has three application services plus the selected edge:

| Service | Responsibility |
| --- | --- |
| `backend` | Fastify API, canonical SQLite and filesystem store |
| `next` | Next.js development server and UI |
| `docs` | Dedicated Next.js/Fumadocs documentation service |
| `nginx` | Optional local TLS termination, host routing and WebSocket forwarding |

The generic Traefik overlay is the recommended local edge. It owns the same
routes as Nginx, loads the mkcert certificate and uses the configurable edge
network. Dream Platform is an optional integration, not a runtime dependency.

The application services join the private `prg32_store_dev` network and the
selected edge network. The default data directory is
`.local/candidate/canonical`, which is disposable and never replaces an
operator-controlled data root.

## Route ownership

| Boundary | Owner |
| --- | --- |
| `/api/games*` and cartridge media/downloads | Fastify catalog |
| `/api/publish*`, `/api/submissions*` | Fastify publication workflow |
| `/api/scores`, `/api/runs`, `/api/metrics/batch` | Fastify compatibility services |
| `/api/multiplayer*` | Fastify WebSocket/HTTP relay |
| `/auth/*` | Fastify authentication and federation |
| `/api/admin/*`, `/api/setup/*` | Fastify administration and setup |
| `/`, `/login`, `/dashboard/*` | Next.js |
| `/docs*` | Dedicated Fumadocs service |

The public firmware routes, discovery document, binary format, WebSocket
messages and SQLite schema are compatibility boundaries.

## Code boundaries

- `backend/src/app.ts` is the composition root.
- `backend/src/catalog`, `submission`, `review` and `consistency` own the
  cartridge lifecycle.
- `backend/src/auth`, `authorization`, `admin`, `settings`, `oidc`, `saml` and
  `federation` own identity and administrative policy.
- `backend/src/metrics`, `scores` and `stats` own telemetry compatibility.
- `backend/src/storage-v2` owns canonical storage, migration and backup.
- `frontend/src/app` contains route entrypoints; `components` contains UI;
  `lib/api` contains typed clients and schemas.

## Persistence

Uploaded cartridge binaries remain in the filesystem store. SQLite stores
metadata, identity, publication, scores, metrics and service records. Local
development uses a bind-mounted disposable canonical root. Deployment
templates use `/data/canonical` and Docker secrets for sensitive values.

## Readiness

Fastify exposes `/health` for liveness and `/ready` for database readiness.
Next and the documentation service expose health endpoints. The edge should
route only after all application services are healthy.
