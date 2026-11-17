# Configuration reference

Environment variables are read at process startup. Compose interpolation
happens before services start. Values below are examples, never credentials.

## Fastify API

| Variable | Meaning |
| --- | --- |
| `PRG32_BACKEND_HOST` | Listen host; use `0.0.0.0` in a container |
| `PRG32_BACKEND_PORT` | Listen port; deployment default is `5080` |
| `PRG32_BACKEND_DB` | Unified SQLite path |
| `PRG32_BACKEND_STORE_DATA` | Canonical filesystem root |
| `PRG32_BACKEND_CATALOG_READ_MODE` | `canonical-disposable` or `canonical-operational` |
| `PRG32_BACKEND_CANONICAL_STORAGE_ROOT` | Canonical storage root |
| `PRG32_BACKEND_SESSION_SECRET[_FILE]` | Session signing secret |
| `PRG32_BACKEND_BOOTSTRAP_TOKEN[_FILE]` | One-time first administrator secret |
| `PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN` | Exact storefront origin |
| `PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN` | Exact API/federation origin |
| `PRG32_BACKEND_CORS_ORIGINS` | Exact browser origins |
| `PRG32_BACKEND_EMAIL_TRANSPORT` | `memory` for tests or `smtp` for deployment |
| `PRG32_BACKEND_MDNS_ENABLED` | Enable classroom discovery advertisement |
| `PRG32_BACKEND_FIRMWARE_REPOSITORY` | GitHub repository that publishes `prg32-firmware.json` releases; default `riscv-prg32/PRG32` |
| `PRG32_BACKEND_FIRMWARE_DIRECTORY` | Optional offline firmware directory with one release folder per tag |
| `PRG32_BACKEND_FIRMWARE_LIST_TTL_SECONDS` | In-memory release-list cache duration; default `600` |
| `PRG32_BACKEND_FIRMWARE_HTTP_TIMEOUT_MS` | GitHub fetch timeout; default `30000` |
| `PRG32_BACKEND_FIRMWARE_GITHUB_TOKEN[_FILE]` | Optional GitHub token for private/rate-limited release reads |

Secrets may be supplied through Docker secrets with the `_FILE` suffix. Do not
put operational secrets in Compose YAML or source control.

## Frontend

| Variable | Meaning |
| --- | --- |
| `NEXT_PUBLIC_PRG32_API_ORIGIN` | Fastify API origin used by browser clients |
| `NEXT_PUBLIC_PRG32_STORE_ORIGIN` | Public Store origin used in links and previews |
| `NEXT_PUBLIC_PRG32_WS_URL` | Public WebSocket URL when configured |
| `NEXT_TELEMETRY_DISABLED` | Disable Next telemetry |

The frontend has no API rewrite target or second backend origin.

## Local edge

The generic development overlay reads these values from the root `.env`:

| Variable | Meaning |
| --- | --- |
| `PRG32_STORE_DOMAIN` | Store and `/docs` hostname used by the edge |
| `PRG32_API_DOMAIN` | API hostname used by the edge |
| `PRG32_STORE_ORIGIN` | Full Store origin passed to backend, frontend and docs |
| `PRG32_API_ORIGIN` | Full API origin passed to backend and frontend |
| `PRG32_SESSION_COOKIE_DOMAIN` | Cookie domain shared by browser origins |
| `PRG32_TRAEFIK_NETWORK` | Docker network used by repository-owned Traefik |
| `PRG32_TLS_DIR` | Directory containing the mkcert certificate and key |

Keep the domain, origin, dnsmasq and certificate values synchronized. The
optional Dream overlay additionally uses `DREAM_EDGE_NETWORK` and
`DREAM_MAIL_NETWORK` for its external networks.

## Production host variables

The `prg32.test` values in the root development Compose file are local-only
dnsmasq names. A production server must provide its own registered domains and
HTTPS endpoints to the operational template:

| Variable | Meaning |
| --- | --- |
| `PRG32_STORE_DOMAIN` | Production storefront hostname |
| `PRG32_API_DOMAIN` | Production API hostname |
| `PRG32_FRONTEND_PUBLIC_ORIGIN` | Production storefront origin |
| `PRG32_API_PUBLIC_ORIGIN` | Production API origin |
| `PRG32_API_WS_URL` | Production WebSocket origin and path |
| `PRG32_COOKIE_DOMAIN` | Production session-cookie domain |

The operational template intentionally fails Compose interpolation when these
values are missing; it must never silently deploy the local `.prg32.test`
names.

## Compatibility fallbacks

`PRG32_STORE_DATA` and `PRG32_STORE_DB` remain accepted for existing
installations. `PRG32_SCORE_DB` and `PRG32_METRICS_DB` remain read-compatible
fallbacks where the backend configuration supports them.
