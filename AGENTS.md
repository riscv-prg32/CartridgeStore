# AGENTS.md

Guidance for coding agents working in this repository.

## Project context

PRG32 Cartridge Store is the classroom service for PRG32 cartridges. The
repository contains one Fastify/TypeScript API and one Next.js frontend behind
an operator-controlled edge and a separate Fumadocs documentation service.
Local dnsmasq hostnames, TLS and mail services are operator-provided
development details, not application defaults. These names are not production
domains; production must provide its own registered DNS names, TLS
certificates, public origins, cookie domain, and WebSocket URL through the
operational Compose variables.

Keep the educational character of the project: prefer readable, explicit code,
keep API contracts easy to explain in class, and keep setup instructions
reproducible.

## Repository layout

```text
.
|-- backend/                 Fastify API, storage and service modules
|-- frontend/                Next.js application and browser tests
|-- docs/                    Setup, deployment, API and Fumadocs-ready Markdown
|-- docs-site/               Standalone Next.js/Fumadocs documentation app
|-- deploy/                  Deployment templates and backup tooling
|-- cli/                     Firmware-facing integration client
|-- docker-compose.yml       Local development topology
`-- tests/                   Repository-level smoke tests
```

## API compatibility

Do not break existing firmware/tool clients:

- `GET /api/games`
- `GET /api/games/<id>`
- `GET /api/games/<id>/icon`
- `GET /api/games/<id>/screenshot`
- `GET /api/games/<id>/colophon`
- `GET /api/games/<id>/download`
- `POST /api/publish`
- `GET/POST /api/scores`
- `POST /api/runs`
- `POST /api/metrics/batch`
- `POST /api/runs/<run_id>/finish`
- `GET /api/runs`
- `GET /api/runs/<run_id>`
- `GET /api/runs/<run_id>/samples.csv`
- `GET /api/runs/<run_id>/report.md`
- `GET /api/multiplayer/status`
- `WS /api/multiplayer`
- `GET /.well-known/prg32-store.json`

When changing response shapes, preserve old fields and add new optional fields
instead of replacing existing ones.

## Storage rules

- `PRG32_STORE_DATA` controls filesystem cartridge storage and the default
  SQLite database location.
- `PRG32_STORE_DB` controls the unified SQLite database path.
- Preserve support for `PRG32_SCORE_DB` and `PRG32_METRICS_DB` as compatibility
  fallbacks.
- Do not store uploaded cartridge data in SQLite; keep cartridge files in the
  filesystem store.
- Keep SQLite schema migrations idempotent with `CREATE TABLE IF NOT EXISTS`
  and `CREATE INDEX IF NOT EXISTS` unless a deliberate migration plan exists.

## Docker rules

- Keep the API listening on port `5080` in deployment images.
- Keep persistent data mounted at `/data` in deployment templates.
- Keep the WebSocket relay on the same HTTP port as the API.
- Images must run without host-specific paths.
- Local development uses `backend`, `next`, `docs` and one selected edge:
  repository-owned Traefik by default, or the optional Nginx/Dream integration.
- The generic local stack keeps email in memory. The optional Dream integration
  may attach only the backend to an external mail network; do not add a second
  Mailpit service to this Compose project.

## Firmware consistency

The companion repository is https://github.com/riscv-prg32/PRG32. Keep these
constants aligned in both repositories:

| Constant | Value |
|---|---|
| mDNS service type | `_prg32store._tcp` |
| mDNS default port | `5080` |
| Discovery ABI | `prg32-store-discovery-1.0` |
| Metadata ABI | `prg32-metadata-1.0` |
| Colophon ABI | `prg32-colophon-1.0` |
| Physical architecture | `esp32c6` |
| QEMU architecture | `qemu` |

Before changing a canonical constant, verify it in the companion repository.
Do not remove or rename fields from `/.well-known/prg32-store.json`.

## Validation

Use Node 24 and run the relevant checks before reporting completion:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
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
docker compose config
pytest -q
git diff --check
```

Do not reset, clean destructively, checkout existing files, modify operational
data, or push commits unless the user explicitly requests it.
