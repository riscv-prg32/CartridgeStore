# PRG32 Cartrige Store

An installable Flask/PWA catalog for PRG32 `.prg32` game cartridges. Developers
can upload a legacy cartridge plus metadata, icon, optional screenshot,
signature, and colophon; the server publishes a monolithic `PRG32META`
cartridge artifact for firmware and QEMU clients to download.

The same service also hosts the classroom score API, frame metrics receiver, and
cartridge multiplayer relay. The standalone ScoreServer, MetricsServer, and
MultiplayerServer contracts are preserved so existing firmware clients can point
at one Cartrige Store host.

The server name is **Cartrige Store**. The file format remains PRG32
"cartridge" terminology.

## Run

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
| `GET` | `/api/games` |
| `GET` | `/api/games/<id>` |
| `GET` | `/api/games/<id>/icon` |
| `GET` | `/api/games/<id>/screenshot` |
| `GET` | `/api/games/<id>/colophon` |
| `GET` | `/api/games/<id>/download` |
| `POST` | `/api/publish` |
| `GET` | `/api/scores` |
| `POST` | `/api/scores` |
| `GET` | `/api/runs` |
| `POST` | `/api/runs` |
| `POST` | `/api/metrics/batch` |
| `POST` | `/api/runs/<run_id>/finish` |
| `GET` | `/api/runs/<run_id>` |
| `GET` | `/api/runs/<run_id>/samples.csv` |
| `GET` | `/api/runs/<run_id>/report.md` |
| `GET` | `/api/multiplayer/status` |
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
  -d '{"run_id":"demo","samples":[]}'
```

Useful URLs:

- `http://127.0.0.1:5080/api/runs`
- `http://127.0.0.1:5080/api/runs/demo`
- `http://127.0.0.1:5080/api/runs/demo/samples.csv`
- `http://127.0.0.1:5080/api/runs/demo/report.md`

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

## Tests

```bash
pytest -q
```
