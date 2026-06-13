# PRG32 Cartridge Store

An installable Flask/PWA catalog and classroom service hub for PRG32 `.prg32`
game cartridges.

## Quick Deploy With Docker

```bash
docker compose up --build
```

Open <http://127.0.0.1:5080/>.

The compose file mounts `./data` to `/data` in the container so uploaded
cartridges, scores, metrics, and the catalog index persist across restarts.

Stop the service:

```bash
docker compose down
```

See [docs/docker.md](docs/docker.md) for manual `docker run`, LAN deployment,
logs, and maintenance notes.

## Run With Python

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:5080/>.

Set `PRG32_STORE_DATA=/path/to/data` to move filesystem storage. By default the
store writes cartridges to `data/cartridges`, the extracted index to
`data/index.json`, and service data to `data/cartridge_store.sqlite`.

Set `PRG32_STORE_DB=/path/to/cartridge_store.sqlite` to choose a different
SQLite database. Legacy `PRG32_SCORE_DB` and `PRG32_METRICS_DB` environment
variables are also honored when `PRG32_STORE_DB` is not set.

For a detailed environment setup, see
[docs/getting_started.md](docs/getting_started.md).

## Users and Roles

The service seeds a default administrator account:

```text
username: admin
password: password
```

Change that password before real use. New users register by entering an email
address, receiving a verification link, and setting a password from that link.
Their username is the verified email address.

Authenticated users can upload cartridge packages. Users in the `editors` group
verify pending packages before they appear in the public catalog. Legacy
`PRG32_USERS` tokens are still accepted for API and multiplayer clients.

Administrators use `/setup` for store, publish, mDNS, SMTP, OpenID Connect,
and SAML2 settings. `/admin/users`, `/admin/groups`, `/admin/roles`,
`/admin/cartridges`, and `/admin/backup` cover user/group/role assignment,
cartridge administration, and full backup/restore.

## Versioning and Architectures

A `.prg32` file contains one linked executable image. The store groups uploads
by metadata `id` and `version`, and then stores one artifact per architecture:

- `esp32c6`: physical ESP32-C6 PRG32 firmware.
- `qemu`: ESP32-C3 QEMU RGB screen workflow.

Download endpoints accept `version` and `architecture` query parameters:

```http
GET /api/games/org.example.game/download?version=1.0.0&architecture=esp32c6
```

## REST API

| Method | Path |
| --- | --- |
| `GET` | `/api` |
| `GET` | `/api/me` |
| `GET` | `/api/games` |
| `GET` | `/api/games/<id>` |
| `GET` | `/api/games/<id>/icon` |
| `GET` | `/api/games/<id>/screenshot` |
| `GET` | `/api/games/<id>/colophon` |
| `GET` | `/api/games/<id>/download` |
| `POST` | `/api/publish` |
| `GET` | `/api/scores` |
| `POST` | `/api/scores` |
| `GET` | `/api/metrics` |
| `GET` | `/api/runs` |
| `POST` | `/api/runs` |
| `POST` | `/api/metrics/batch` |
| `POST` | `/api/runs/<run_id>/finish` |
| `GET` | `/api/runs/<run_id>` |
| `GET` | `/api/runs/<run_id>/samples.csv` |
| `GET` | `/api/runs/<run_id>/report.md` |
| `GET` | `/api/multiplayer` |
| `GET` | `/api/multiplayer/status` |
| `WS` | `/api/multiplayer` |
| `GET` | `/.well-known/prg32-store.json` |

`POST /api/publish` and `POST /api/publish/bundle` accept `multipart/form-data`
with a single `bundle=@game.zip` package. Uploads enter the editor review queue.

## Scores

The score API is compatible with the standalone PRG32 ScoreServer:

```bash
curl http://localhost:5080/api/scores
curl -X POST http://localhost:5080/api/scores \
  -H 'Content-Type: application/json' \
  -d '{"game":"pong","player":"Ada","score":42}'
```

Use `?game=<name>` to filter scores for one game and `?limit=<n>` to choose a
result limit between 1 and 100. Add `?player=<name>` to show scores for one
player. The browser scoreboard is available from the navigation bar at
`/scores` and accepts the same `game`, `player`, and `limit` query filters.

## Metrics

The metrics API is compatible with the standalone PRG32 MetricsServer:

```bash
curl -X POST http://127.0.0.1:5080/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"demo","board_id":"board-1","target":"esp32c6"}'

curl -X POST http://127.0.0.1:5080/api/metrics/batch \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"demo","samples":[{"frame":1,"frame_us":23500}]}'
```

Useful URLs:

- `http://127.0.0.1:5080/api/runs`
- `http://127.0.0.1:5080/api/runs/demo`
- `http://127.0.0.1:5080/api/runs/demo/samples.csv`
- `http://127.0.0.1:5080/api/runs/demo/report.md`

Export one metrics run:

```bash
python -m cartridge_store.export_run demo \
  --db data/cartridge_store.sqlite \
  --out metrics_export/demo
```

The export directory contains metadata JSON, sample CSV, summary CSV, a LaTeX
summary table, a Markdown report, and plots when `matplotlib` is available.

## Multiplayer

The multiplayer relay keeps the standalone MultiplayerServer JSON protocol, but
runs on the same Cartridge Store service:

```text
ws://127.0.0.1:5080/api/multiplayer
```

Clients send:

```json
{"type":"join","signature":"pong-v1","flags":1,"player_id":123}
{"type":"state","x":120,"y":80,"sprite":0,"flags":0,"input":2,"frame":42}
{"type":"leave"}
```

The relay replies with `welcome`, `peer`, `leave`, or `error` messages. Clients
with different cartridge signatures stay isolated. Set `PRG32_MP_MAX_PEERS` to
change the per-signature room limit.

## Compatibility and Safety

- The store never executes uploaded cartridge code.
- Upload size is limited by Flask `MAX_CONTENT_LENGTH`.
- Game IDs and versions are restricted to path-safe characters.
- Metadata and colophon JSON are validated before publishing.
- Icon and screenshot uploads must be PNG or JPEG bytes.
- Unknown metadata trailer TLV blocks are preserved when rewriting a cartridge.
- Score and metrics inputs are length-limited before storage.
- Multiplayer rooms are isolated by path-safe cartridge signatures.
- The game colophon is shown after the cartridge is activated, before the player
  starts a new play.
- Score, metrics, and multiplayer APIs keep the legacy request and response
  contracts from the archived standalone servers.

## Tests

```bash
pytest -q
```

## Documentation

Start here:

- [Getting started](docs/getting_started.md): local Python setup, first-run
  Store configuration, default administrator login, package upload and review,
  score submission, metrics smoke tests, mDNS, SMTP, external auth, and theme
  customization.
- [Getting started with PRG32 game development](docs/getting_started_game_development.md):
  host tool installation on Windows, Linux, and macOS; PlatformIO and ESP-IDF
  setup; creating a hello world cartridge from scratch; running it in QEMU;
  uploading it to ESP32-C6 hardware; packaging and publishing it to the Store.

Operate and deploy the Store:

- [Docker deployment](docs/docker.md): Docker Compose quick start, persistent
  `/data` storage, manual `docker run`, classroom LAN URLs, mDNS behavior,
  full backup/restore, logs, restarts, and data reset.
- [Deployment](docs/deployment.md): production environment variables,
  reverse-proxy notes, WebSocket proxying, SMTP, OIDC, SAML2, mDNS, backup
  expectations, and production hardening checklist.
- [Operations](docs/operations.md): daily classroom operations, backup and
  restore, health checks, publishing workflow, user registration, admin pages,
  access-token rotation, logs, network checks, and full data reset.

Integrate with clients and tools:

- [Unified service API](docs/api.md): discovery document, auth endpoints,
  admin endpoints, cartridge package format, editor verification API, scores,
  metrics, statistics, multiplayer, and compatibility notes.

What to read for common tasks:

- Run the Store locally: [Getting started](docs/getting_started.md).
- Deploy the Store with Docker: [Docker deployment](docs/docker.md).
- Deploy the Store behind HTTPS: [Deployment](docs/deployment.md).
- Administer users, groups, cartridges, setup, or backups:
  [Operations](docs/operations.md).
- Create a new PRG32 game cartridge:
  [Getting started with PRG32 game development](docs/getting_started_game_development.md).
- Publish a cartridge package: [Getting started](docs/getting_started.md) for
  the browser flow, or [Unified service API](docs/api.md) for the API flow.
- Build firmware or prepare PlatformIO/ESP-IDF:
  [Getting started with PRG32 game development](docs/getting_started_game_development.md).
- Run a cartridge in QEMU:
  [Getting started with PRG32 game development](docs/getting_started_game_development.md).
- Upload a cartridge to physical hardware:
  [Getting started with PRG32 game development](docs/getting_started_game_development.md).
- Perform performance or metrics tests: [Getting started](docs/getting_started.md)
  for a smoke test, [Unified service API](docs/api.md) for ingestion endpoints,
  and [Operations](docs/operations.md) for service checks.
- Contribute to game development:
  [Getting started with PRG32 game development](docs/getting_started_game_development.md).
- Contribute to firmware development:
  [Getting started with PRG32 game development](docs/getting_started_game_development.md)
  for PlatformIO/ESP-IDF setup, then use the firmware SDK's own contribution
  guide for board-specific internals.
- Integrate firmware, launchers, classroom dashboards, or CI tools:
  [Unified service API](docs/api.md).
