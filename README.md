# PRG32 Cartrige Store

An installable Flask/PWA catalog and classroom service hub for PRG32 `.prg32`
game cartridges.

This repository now contains the functionality that used to live in:

- `riscv-prg32/ScoreServer`
- `riscv-prg32/MetricsServer`
- `riscv-prg32/MultiplayerServer`

The older standalone repositories can be archived once deployments point here.
The server name remains **Cartrige Store**. The file format and public PRG32
terms remain "cartridge".

## Install

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## Run the HTTP Store

```bash
python app.py
```

Open <http://127.0.0.1:5080/>.

Set `PRG32_STORE_DATA=/path/to/data` to move filesystem storage. By default the
store writes cartridges to `data/cartridges` and the extracted index to
`data/index.json`. Scores and metrics share `data/services.sqlite3`.

Use `PRG32_STORE_DB=/path/to/services.sqlite3` to choose a different shared
SQLite database. Existing `PRG32_SCORE_DB` and `PRG32_METRICS_DB` variables are
also honored as compatibility aliases when `PRG32_STORE_DB` is not set.

## Run the Multiplayer Relay

```bash
python -m cartridge_store.multiplayer --host 0.0.0.0 --port 8081
```

Equivalent environment variables:

```bash
PRG32_MP_HOST=0.0.0.0 PRG32_MP_PORT=8081 PRG32_MP_MAX_PEERS=8 \
  python -m cartridge_store.multiplayer
```

Point PRG32 firmware at `ws://<classroom-host>:8081`.

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
`?token=<token>`. Multiplayer clients may send the token in the WebSocket query
string or in the `join` message as `token`.

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
| `GET` | `/api/runs/<run_id>` |
| `POST` | `/api/runs/<run_id>/finish` |
| `POST` | `/api/metrics/batch` |
| `GET` | `/api/runs/<run_id>/samples.csv` |
| `GET` | `/api/runs/<run_id>/report.md` |
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

### Scores

```bash
curl http://localhost:5080/api/scores
curl -X POST http://localhost:5080/api/scores \
  -H 'Content-Type: application/json' \
  -d '{"game":"pong","player":"Ada","score":42}'
```

Use `?game=<name>` to filter scores for one game and `?limit=<n>` to choose a
result limit between 1 and 100.

### Metrics

```bash
curl -X POST http://127.0.0.1:5080/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"demo","board_id":"board-1","target":"esp32c6"}'

curl -X POST http://127.0.0.1:5080/api/metrics/batch \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"demo","samples":[{"frame":1,"frame_us":23500}]}'
```

Export one metrics run:

```bash
python -m cartridge_store.export_run demo \
  --db data/services.sqlite3 \
  --out metrics_export/demo
```

The export directory contains metadata JSON, sample CSV, summary CSV, a LaTeX
summary table, a Markdown report, and plots when `matplotlib` is available.

### Multiplayer

Clients send JSON messages over WebSocket:

```json
{"type":"join","signature":"pong-v1","flags":1,"player_id":123}
{"type":"state","x":120,"y":80,"sprite":0,"flags":0,"input":2,"frame":42}
{"type":"leave"}
```

The relay replies with:

```json
{"type":"welcome","player_id":123}
{"type":"peer","player_id":456,"x":128,"y":80,"sprite":0,"flags":0,"input":0,"frame":42}
{"type":"leave","player_id":456}
```

Only clients with the same `signature` receive each other's snapshots.
Signatures may contain letters, digits, `_`, `-`, `.`, and `:`, up to 47
characters.

## Compatibility and Safety

- The store never executes uploaded cartridge code.
- Upload size is limited by Flask `MAX_CONTENT_LENGTH`.
- Game IDs and versions are restricted to path-safe characters.
- Metadata and colophon JSON are validated before publishing.
- Icon and screenshot uploads must be PNG or JPEG bytes.
- Unknown metadata trailer TLV blocks are preserved when rewriting a cartridge.
- The game colophon is shown after the cartridge is activated, before the player
  starts a new play.
- Score, metrics, and multiplayer APIs keep the legacy request and response
  contracts from the archived standalone servers.

## Tests

```bash
pytest -q
```
