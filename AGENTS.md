# AGENTS.md

Guidance for coding agents working in this repository.

## Scope

This file applies to the whole repository. Follow it unless a more specific
`AGENTS.md` exists deeper in the tree.

## Project Context

PRG32 Cartrige Store is the classroom service for PRG32 cartridges. It hosts:

- a Flask/PWA catalog for `.prg32` cartridge artifacts;
- the ScoreServer-compatible `/api/scores` leaderboard API;
- the MetricsServer-compatible `/api/runs` and `/api/metrics/batch` receiver;
- the MultiplayerServer-compatible WebSocket relay at `/api/multiplayer`.

The service name is intentionally **Cartrige Store**. The file format remains
PRG32 "cartridge" terminology.

Preserve the educational character of the project: prefer readable, explicit
Python over clever abstractions, keep API contracts easy to explain in class,
and keep setup instructions reproducible.

## Repository Layout

```text
.
|-- app.py                    Development server entrypoint, exports app:app
|-- cartridge_store/          Flask app, storage, cartridge format, services
|-- templates/                Jinja templates for the PWA
|-- static/                   PWA assets
|-- tests/                    pytest coverage
|-- docs/                     Setup, deployment, and API documentation
|-- Dockerfile                Container image for quick deployment
`-- docker-compose.yml        Local persistent deployment
```

## Naming Rules

- Use `PRG32` for the platform name.
- Use `Cartrige Store` for the server/product name.
- Use `cartridge` for `.prg32` file terminology.
- Keep public metadata ABI names stable:
  - `prg32-metadata-1.0`
  - `prg32-colophon-1.0`
  - `prg32-store-discovery-1.0`

## API Compatibility

Do not break existing firmware/tool clients:

- `GET /api/games`
- `GET /api/games/<id>`
- `GET /api/games/<id>/icon`
- `GET /api/games/<id>/screenshot`
- `GET /api/games/<id>/colophon`
- `GET /api/games/<id>/download`
- `POST /api/publish`
- `GET /api/scores`
- `POST /api/scores`
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

## Storage Rules

- `PRG32_STORE_DATA` controls filesystem cartridge storage and the default
  SQLite database location.
- `PRG32_STORE_DB` controls the unified SQLite database path.
- Preserve support for legacy `PRG32_SCORE_DB` and `PRG32_METRICS_DB` as
  compatibility fallbacks.
- Do not store uploaded cartridge data in SQLite; keep cartridge files in the
  filesystem store.
- Keep SQLite schema migrations idempotent through `CREATE TABLE IF NOT EXISTS`
  and `CREATE INDEX IF NOT EXISTS` unless a deliberate migration plan is added.

## Docker Rules

- Keep the container listening on port `5080`.
- Keep persistent data mounted at `/data`.
- Keep the WebSocket relay on the same HTTP port as the web/API service.
- The Docker image should run without requiring host-specific paths.

## Validation

Before reporting completion, run the relevant subset:

```bash
python3 -m py_compile app.py cartridge_store/*.py
pytest -q
git diff --check
```

For Docker changes, also run when Docker is available:

```bash
docker compose config
docker build -t prg32-cartrige-store:local .
```

If Docker or network access is unavailable, say so clearly.
