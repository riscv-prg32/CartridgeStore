# Unified Service API

PRG32 Cartridge Store combines cartridge catalog, score, metrics, multiplayer,
authentication, and statistics contracts on one host.

## Discovery

```http
GET /.well-known/prg32-store.json
```

The `services` object includes `cartridges`, `bundle_publish`, `submissions`,
`scores`, `metrics`, `multiplayer`, and `multiplayer_status` URLs. When mDNS
advertisement is enabled, the service is announced as `_prg32store._tcp.local.`
with TXT record `abi=prg32-store-discovery-1.0`.

## Authentication

The server requires `SECRET_KEY` and uses Flask signed-cookie sessions for
browser login. A default administrator account is created with username
`admin` and password `password`; change that password before using the service
outside a throwaway classroom demo. New users start at `/auth/register` by
entering only an email address. The server sends a verification link; following
that link lets the user set a password. The account username is the verified
email address.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/auth/register` | Request an email verification link |
| `GET/POST` | `/auth/register/complete` | Complete registration from the emailed link |
| `GET/POST` | `/auth/login` | Authenticate and set the session cookie |
| `POST` | `/auth/logout` | Clear the session |
| `GET` | `/auth/me` | Current user JSON |
| `POST` | `/auth/tokens` | Create a Bearer token |
| `DELETE` | `/auth/tokens/<id>` | Revoke one of your tokens |
| `GET` | `/auth/oidc/login` | Start OIDC login when configured |
| `GET` | `/auth/oidc/callback` | OIDC callback when configured |
| `GET` | `/auth/saml/login` | Start SAML2 login when configured |
| `POST` | `/auth/saml/acs` | SAML2 assertion consumer when configured |
| `GET` | `/auth/saml/metadata` | SAML2 service-provider metadata |

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
| `GET /api/submissions*` | `editors` group |
| `POST /api/submissions/<id>/verify` | `editors` group |
| `POST /api/submissions/<id>/reject` | `editors` group |
| `POST /api/scores` | logged in or Bearer token |
| `/setup`, `/setup/logo`, `/setup/favicon` | admin |
| `/admin/users*`, `/admin/groups*`, `/admin/roles`, `/admin/backup*` | admin |
| `/admin/cartridges*` | admin or `editors` group |
| `/users/<username>/runs*` | owner or admin |

Metrics ingestion remains compatible with existing clients. If a run is posted
with a session or Bearer token, the run is linked to that user.

Legacy `PRG32_USERS` tokens are still accepted for API and multiplayer clients,
but database users must belong to the `editors` group to verify submissions.

Registration email delivery uses SMTP when `PRG32_SMTP_HOST` is configured. In
development without SMTP, the verification link is logged.

OIDC and SAML2 can be enabled from `/setup` or environment variables. On a
successful federated login, the service creates or updates a local user with
the external provider id and email address.

## Administration

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/setup` | Edit store, auth, publish, mDNS, SMTP, OIDC, and SAML2 settings |
| `GET/POST` | `/admin/users` | List and create users |
| `POST` | `/admin/users/<id>` | Update username, email, role, password, and groups |
| `DELETE` | `/admin/users/<id>` | Delete a user |
| `POST` | `/admin/users/<id>/delete` | Browser delete fallback |
| `GET/POST` | `/admin/groups` | List and create groups |
| `POST` | `/admin/groups/<id>` | Rename a group |
| `DELETE/POST` | `/admin/groups/<id>/delete` | Delete a group |
| `GET` | `/admin/roles` | List fixed roles and user counts |
| `GET` | `/admin/cartridges` | List cartridges for administration |
| `POST` | `/admin/cartridges/<id>/<version>` | Edit title, summary, and tags |
| `DELETE/POST` | `/admin/cartridges/<id>/<version>/delete` | Delete a variant or version |
| `GET` | `/admin/backup` | Backup/restore page |
| `GET` | `/admin/backup/download` | Download a full backup ZIP |
| `POST` | `/admin/backup/restore` | Restore a full backup ZIP |

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
| `POST` | `/api/publish` | Upload a zip bundle package for review |
| `POST` | `/api/publish/bundle` | Upload a zip bundle package for review |
| `GET` | `/api/submissions` | List pending submissions for editors |
| `POST` | `/api/submissions/<id>/verify` | Verify and publish a pending submission |
| `POST` | `/api/submissions/<id>/reject` | Reject a pending submission |

Download requests accept `version` and `architecture` query parameters.

`GET /api/games` accepts optional browsing parameters:

| Parameter | Purpose |
| --- | --- |
| `q` or `search` | Filter by title, summary, author, or tag |
| `page` | Page number, starting at `1` |
| `per_page` or `limit` | Maximum games returned per page, capped at `100` |

The response keeps the legacy top-level `games` list and adds a `pagination`
object with `page`, `per_page`, `total`, `pages`, `has_next`, `has_prev`,
`next_page`, and `prev_page`.

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

Both `/api/publish/bundle` and the compatibility alias `/api/publish` accept
only zip packages. The old per-field `.prg32` upload shape is rejected.

Upload success creates a pending submission. It does not add the cartridge to
the public catalog until an editor verifies it:

```json
{
  "status": "pending",
  "review_required": true,
  "submission_id": 7,
  "id": "org.example.game",
  "version": "1.0.0",
  "submitted": [
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

## Editor Verification

Editors review pending uploads in `/editor/submissions` or through the
submissions API. Editors may change descriptive metadata fields only:

- `title`
- `summary`
- `description`
- `tags`
- `license`
- `homepage`
- `repository`

The server preserves `id`, `version`, and `authors` from the submitted package.
Attempts to change those fields through the API are rejected.

Verify with metadata edits:

```bash
curl -X POST http://host:5080/api/submissions/7/verify \
  -H "Authorization: Bearer prg32_..." \
  -H 'Content-Type: application/json' \
  -d '{"metadata":{"title":"Reviewed Title","tags":["class","demo"]}}'
```

Reject:

```bash
curl -X POST http://host:5080/api/submissions/7/reject \
  -H "Authorization: Bearer prg32_..."
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
