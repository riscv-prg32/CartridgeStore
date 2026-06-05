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
`data/index.json`, and service data to `data/cartrige_store.sqlite`.

Set `PRG32_STORE_DB=/path/to/cartrige_store.sqlite` to choose a different
SQLite database. Legacy `PRG32_SCORE_DB` and `PRG32_METRICS_DB` environment
variables are also honored when `PRG32_STORE_DB` is not set.

For a detailed environment setup, see
[docs/getting_started.md](docs/getting_started.md).

## Unified Users and Roles

All services share one optional token model. With no users configured, the app
runs in open classroom mode and keeps the legacy firmware contracts working.

Set `PRG32_USERS` to enable role checks for write operations:

```bash
export PRG32_USERS='teacher:admin:teach-secret,board:player:board-secret'
```

JSON is also accepted:

```bash
export PRG32_USERS='[
  {"name":"teacher","role":"admin","token":"teach-secret"},
  {"name":"board","role":"player","token":"board-secret"}
]'
```

Roles are cumulative:

- `reader`: browse the store, download games, read scores and metrics.
- `player`: submit scores, create metrics runs, upload metrics batches, and join
  multiplayer rooms.
- `publisher`: publish cartridges.
- `admin`: full access.

HTTP clients may send `Authorization: Bearer <token>`, `X-PRG32-Token`, or
`?token=<token>`. Browser publishing also accepts the token field. Multiplayer
clients may send the token in the WebSocket query string or in the `join`
message as `token`.

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

`POST /api/publish` accepts `multipart/form-data` with:

- `cartridge`: legacy or already-monolithic `.prg32`.
- `metadata`: optional `prg32-metadata-1.0` JSON object. If omitted, form
  fields such as `id`, `title`, `version`, `summary`, and `tags` are used.
- `icon`: PNG or JPEG icon.
- `screenshot`: optional PNG or JPEG screenshot.
- `signature`: optional bytes or JSON signature object.
- `colophon`: optional `prg32-colophon-1.0` JSON object. If omitted, colophon
  form fields are used.
- `architecture`: `esp32c6` or `qemu`.

## Scores

The score API is compatible with the standalone PRG32 ScoreServer:

```bash
curl http://localhost:5080/api/scores
curl -X POST http://localhost:5080/api/scores \
  -H 'Content-Type: application/json' \
  -d '{"game":"pong","player":"Ada","score":42}'
```

Use `?game=<name>` to filter scores for one game and `?limit=<n>` to choose a
result limit between 1 and 100.

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
  --db data/cartrige_store.sqlite \
  --out metrics_export/demo
```

The export directory contains metadata JSON, sample CSV, summary CSV, a LaTeX
summary table, a Markdown report, and plots when `matplotlib` is available.

## Multiplayer

The multiplayer relay keeps the standalone MultiplayerServer JSON protocol, but
runs on the same Cartrige Store service:

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

- [Getting started](docs/getting_started.md)
- [Docker deployment](docs/docker.md)
- [Unified service API](docs/api.md)
- [Operations](docs/operations.md)
