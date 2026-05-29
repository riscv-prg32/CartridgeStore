# Unified Service API

PRG32 Cartrige Store combines cartridge catalog, score, metrics, and multiplayer
service contracts on one host.

## Discovery

```http
GET /.well-known/prg32-store.json
```

The response includes:

```json
{
  "abi": "prg32-store-discovery-1.0",
  "name": "PRG32 Cartrige Store",
  "api": "http://host:5080/api",
  "web": "http://host:5080/",
  "services": {
    "cartridges": "http://host:5080/api/games",
    "scores": "http://host:5080/api/scores",
    "metrics": "http://host:5080/api/runs",
    "multiplayer": "ws://host:5080/api/multiplayer"
  }
}
```

## Cartridge Catalog

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/games` | List games |
| `GET` | `/api/games/<id>` | Fetch one game record |
| `GET` | `/api/games/<id>/icon` | Fetch icon bytes |
| `GET` | `/api/games/<id>/screenshot` | Fetch screenshot bytes |
| `GET` | `/api/games/<id>/colophon` | Fetch colophon JSON |
| `GET` | `/api/games/<id>/download` | Download `.prg32` artifact |
| `POST` | `/api/publish` | Publish a cartridge variant |

Download requests accept `version` and `architecture` query parameters. Firmware
should request `architecture=esp32c6`; QEMU clients should request
`architecture=qemu`.

## Scores

The score API is compatible with the standalone PRG32 ScoreServer.

```http
GET /api/scores?game=pong&limit=20
POST /api/scores
```

Submit JSON:

```json
{"game":"pong","player":"Ada","score":42}
```

Scores are ordered by highest score first, then oldest timestamp first.

## Metrics

The metrics API is compatible with the standalone PRG32 MetricsServer.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/runs` | Register or update a run |
| `POST` | `/api/metrics/batch` | Submit frame samples |
| `POST` | `/api/runs/<run_id>/finish` | Mark a run finished |
| `GET` | `/api/runs` | List runs |
| `GET` | `/api/runs/<run_id>` | Fetch run summary |
| `GET` | `/api/runs/<run_id>/samples.csv` | Export samples |
| `GET` | `/api/runs/<run_id>/report.md` | Generate Markdown report |

Minimal run payload:

```json
{"run_id":"demo-run","board_id":"board-1","target":"esp32c6"}
```

Minimal sample batch:

```json
{
  "run_id": "demo-run",
  "samples": [
    {"frame": 1, "frame_us": 16000}
  ]
}
```

## Multiplayer

The multiplayer relay is compatible with the standalone PRG32 MultiplayerServer.

```text
ws://host:5080/api/multiplayer
```

Client messages:

```json
{"type":"join","signature":"pong-v1","flags":1,"player_id":123}
{"type":"state","x":120,"y":80,"sprite":0,"flags":0,"input":2,"frame":42}
{"type":"leave"}
```

Server messages:

```json
{"type":"welcome","player_id":123}
{"type":"peer","player_id":456,"x":128,"y":80,"sprite":0,"flags":0,"input":0,"frame":42}
{"type":"leave","player_id":456}
{"type":"error","error":"join first"}
```

Signatures may contain letters, digits, `_`, `-`, `.`, and `:`, up to 47
characters.
