# Unified Service API

PRG32 Cartrige Store combines cartridge catalog, score, metrics, multiplayer,
authentication, and statistics contracts on one host.

## Discovery

```http
GET /.well-known/prg32-store.json
```

The `services` object includes `cartridges`, `bundle_publish`, `scores`,
`metrics`, `multiplayer`, and `multiplayer_status` URLs.

## Authentication

The server requires `SECRET_KEY` and uses Flask signed-cookie sessions for
browser login. Register the first local account at `/auth/register`; that user
becomes `admin`. Later users default to `user` unless changed by an admin.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/auth/register` | Create a local account |
| `GET/POST` | `/auth/login` | Authenticate and set the session cookie |
| `POST` | `/auth/logout` | Clear the session |
| `GET` | `/auth/me` | Current user JSON |
| `POST` | `/auth/tokens` | Create a Bearer token |
| `DELETE` | `/auth/tokens/<id>` | Revoke one of your tokens |

Create a token:

```bash
curl -X POST http://host:5080/auth/tokens \
  -b cookies.txt -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"label":"board"}'
```

Use it:

```bash
curl -H "Authorization: Bearer prg32_..." http://host:5080/auth/me
```

Routes requiring auth:

| Route | Requirement |
| --- | --- |
| `POST /api/publish` | logged in or Bearer token |
| `POST /api/publish/bundle` | logged in or Bearer token |
| `POST /api/scores` | logged in or Bearer token |
| `/setup`, `/setup/logo`, `/setup/favicon` | admin |
| `/admin/*` | admin |
| `/users/<username>/runs*` | owner or admin |

Metrics ingestion remains compatible with existing clients. If a run is posted
with a session or Bearer token, the run is linked to that user.

Legacy `PRG32_USERS` tokens are still accepted for API and multiplayer clients.

## Cartridge Catalog

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api` | List unified service metadata |
| `GET` | `/api/me` | Show the current principal |
| `GET` | `/api/games` | List games |
| `GET` | `/api/games/<id>` | Fetch one game record |
| `GET` | `/api/games/<id>/icon` | Fetch icon bytes |
| `GET` | `/api/games/<id>/screenshot` | Fetch screenshot bytes |
| `GET` | `/api/games/<id>/colophon` | Fetch colophon JSON |
| `GET` | `/api/games/<id>/download` | Download `.prg32` artifact |
| `POST` | `/api/publish` | Publish one cartridge variant |
| `POST` | `/api/publish/bundle` | Publish a zip bundle |

Download requests accept `version` and `architecture` query parameters.

## Bundle Publish

```http
POST /api/publish/bundle
Content-Type: multipart/form-data
```

Form field:

```text
bundle=@game.zip
```

Zip layout:

```text
manifest.json
icon.png
splash.png          optional
*.prg32             one or more
```

`manifest.json` must be a `prg32-metadata-1.0` object with an `assets.icon`
filename and a non-empty `architectures` list:

```json
{
  "abi": "prg32-metadata-1.0",
  "id": "org.example.game",
  "title": "My Game",
  "version": "1.0.0",
  "summary": "One-line description",
  "assets": {"icon": "icon.png", "splash": "splash.png"},
  "architectures": [
    {"id": "qemu", "file": "game-qemu.prg32"},
    {"id": "esp32c6", "file": "game-esp32c6.prg32"}
  ]
}
```

Success:

```json
{
  "status": "ok",
  "id": "org.example.game",
  "version": "1.0.0",
  "published": [
    {"architecture": "qemu", "file": "game-qemu.prg32"}
  ]
}
```

Errors return status `400` with an `error` string.

Minimal curl:

```bash
curl -X POST http://host:5080/api/publish/bundle \
  -H "Authorization: Bearer prg32_..." \
  -F bundle=@game.zip
```

## Scores

The score API is compatible with the standalone PRG32 ScoreServer.

```http
GET /api/scores?game=pong&limit=20
POST /api/scores
```

Submit JSON with a session or Bearer token:

```json
{"game":"pong","player":"Ada","score":42}
```

Scores are ordered by highest score first, then oldest timestamp first.

## Metrics

The metrics API is compatible with the standalone PRG32 MetricsServer.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/metrics` | List metrics endpoints |
| `POST` | `/api/runs` | Register or update a run |
| `POST` | `/api/metrics/batch` | Submit frame samples |
| `POST` | `/api/runs/<run_id>/finish` | Mark a run finished |
| `GET` | `/api/runs` | List runs |
| `GET` | `/api/runs/<run_id>` | Fetch run summary |
| `GET` | `/api/runs/<run_id>?format=json` | Download full run JSON |
| `GET` | `/api/runs/<run_id>/samples.csv` | Export samples |
| `GET` | `/api/runs/<run_id>/report.md` | Generate Markdown report |

## Statistics API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/stats/downloads` | Download time series and top games |
| `GET` | `/api/stats/downloads/<game_id>` | Per-game download breakdown |
| `GET` | `/api/stats/scores` | Top scores across games |
| `GET` | `/api/stats/runs` | Metrics run counts |

`/api/stats/downloads` accepts `since`, `until`, `granularity=day|week|month`,
and `limit`.

```bash
curl 'http://host:5080/api/stats/downloads?since=2026-05-01&granularity=day'
```

Response:

```json
{
  "series": [{"date": "2026-05-01", "downloads": 42}],
  "total": 1234,
  "top_games": [
    {"id": "org.example.game", "title": "My Game", "downloads": 300}
  ]
}
```

## Multiplayer

The multiplayer relay is compatible with the standalone PRG32 MultiplayerServer.

```text
ws://host:5080/api/multiplayer
```

Clients send JSON messages:

```json
{"type":"join","signature":"pong-v1","flags":1,"player_id":123}
{"type":"state","x":120,"y":80,"sprite":0,"flags":0,"input":2,"frame":42}
{"type":"leave"}
```

Signatures may contain letters, digits, `_`, `-`, `.`, and `:`, up to 47
characters.
