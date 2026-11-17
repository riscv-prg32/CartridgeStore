# Unified Service API

This is the public compatibility contract served by the Fastify API. See
[Architecture](architecture.md) for route ownership and the compatibility
evidence in the repository test suites.

PRG32 Cartridge Store combines cartridge catalog, score, metrics, multiplayer,
authentication, and statistics contracts on one host.

## Firmware flashing over USB

The public Store page `/firmware` exposes the official PRG32 ESP32-C6 release
flow. It uses Chrome or Edge Web Serial and never writes a board until the
browser has checked the release format, selected pin profile, file size, and
SHA-256 for every flash part. The normal profile writes only bootloader,
partition table, and application data; the optional full erase is explicitly
confirmed because it removes Wi-Fi settings, cartridges, and scores.

The Fastify backend proxies and caches release assets from
`riscv-prg32/PRG32`, which avoids browser CORS problems and gives the page a
same-origin integrity boundary:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/firmware/releases` | List valid ESP32-C6 releases and pin profiles |
| `GET` | `/api/firmware/releases/<tag>/prg32-firmware.json` | Return the validated release manifest |
| `GET` | `/api/firmware/releases/<tag>/<part>.bin` | Serve a manifest-listed, SHA-256-verified flash part |

The firmware flashing page is intentionally separate from the cartridge
download flow. Multiplayer remains integrated in this same Store service and
continues to use `/api/multiplayer` and `/api/multiplayer/status`.

## Discovery

```http
GET /.well-known/prg32-store.json
```

The `services` object includes `cartridges`, `bundle_publish`, `submissions`,
`scores`, `metrics`, `multiplayer`, and `multiplayer_status` URLs. When mDNS
advertisement is enabled, the service is announced as `_prg32store._tcp.local.`
with TXT record `abi=prg32-store-discovery-1.0`.

The discovery response also exposes `api_version`, `api_base`, `api_versions`,
and `services_v1`. Firmware clients must use the stable version advertised in
those fields. The complete firmware contract is documented in
[PRG32 Store API versioning](firmware-api-versioning.md).

The canonical first-generation API prefix is `/api/v1`. Existing `/api/...`
paths remain compatibility aliases and execute the same handlers.

## Authentication

The server uses signed-cookie sessions for browser login. Fresh installations
require an operator-supplied,
one-time `PRG32_BOOTSTRAP_TOKEN`; no known administrator password is created.
Existing administrator credentials, IDs, groups, and roles are preserved.
New users start at `/auth/register` by entering only an email address. The
server sends a verification link; following that link lets the user set a
password. The account username is the verified email address.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/auth/register` | Request an email verification link |
| `GET/POST` | `/auth/register/complete` | Complete registration from the emailed link |
| `GET` | `/auth/csrf` | Get a session-bound CSRF token for browser/Next mutations |
| `POST` | `/auth/bootstrap` | One-time first administrator setup using the operator header secret |
| `GET/POST` | `/auth/login` | Authenticate and set the session cookie |
| `POST` | `/auth/logout` | Clear the session |
| `GET` | `/auth/me` | Current user JSON |
| `GET` | `/auth/tokens` | List your Bearer tokens or open the token manager |
| `POST` | `/auth/tokens` | Create a Bearer token |
| `PATCH` | `/auth/tokens/<id>` | Rename one of your tokens |
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

First-run bootstrap (send the secret only in the header; it is never returned
or logged):

```bash
export PRG32_BOOTSTRAP_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
curl -X POST http://host:5080/auth/bootstrap \
  -H "X-PRG32-Bootstrap-Token: $PRG32_BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","email":"admin@example.test","password":"replace-with-a-unique-password","password_confirm":"replace-with-a-unique-password"}'
```

The endpoint returns `409` after the first successful setup or when an
administrator already exists. Keep the operator secret out of shell history,
CI logs, Compose files, and source control; unset it after setup if the
deployment does not need to recover a fresh database.

Cookie-authenticated state-changing requests require the session CSRF token.
HTML forms receive a hidden `csrf_token` field. JSON clients should call
`GET /auth/csrf` and send `X-CSRFToken`; a valid Bearer/API-token-only request
does not require a browser CSRF token. Missing or invalid tokens return HTTP
403 with `code: "csrf_failed"`. Firmware ingestion endpoints remain compatible
for their existing anonymous and Bearer clients.

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
| `/api/setup/*`, `/api/admin/settings*`, `/api/admin/settings/assets/*` | admin |
| `/api/admin/users*`, `/api/admin/groups*`, `/api/admin/roles`, `/admin/backup*` | admin |
| `/api/admin/cartridges*` | admin or `editors` group |
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
| `GET/POST` | `/api/setup/*` | Read setup state and complete first-run setup |
| `GET/POST` | `/api/admin/users` | List and create users |
| `GET/PATCH` | `/api/admin/users/<id>` | Read or update username, email and password |
| `DELETE` | `/api/admin/users/<id>` | Delete a user |
| `GET/POST` | `/api/admin/groups` | List and create groups |
| `POST/DELETE` | `/api/admin/groups/<id>` | Rename or delete a group |
| `GET` | `/api/admin/roles` | List fixed roles and user counts |
| `GET` | `/api/admin/cartridges` | List cartridges for administration |
| `PATCH/POST` | `/api/admin/cartridges/<id>` | Edit title, summary and tags |
| `DELETE` | `/api/admin/cartridges/<id>` | Delete a variant or version |
| `GET` | `/admin/backup` | Backup/restore page |
| `GET` | `/admin/backup/download` | Download a full backup ZIP |
| `POST` | `/admin/backup/restore` | Restore a full backup ZIP |

### Settings, managed assets and audit

The dashboard settings and governance screens use the following admin-only
routes. They require the corresponding RBAC permission, a browser session and
the CSRF token for mutations:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/settings` | Read typed settings and runtime metadata |
| `PATCH` | `/api/admin/settings` | Update writable settings with optimistic versions |
| `POST` | `/api/admin/settings/smtp/test-connection` | Verify the configured SMTP connection |
| `POST` | `/api/admin/settings/smtp/test-message` | Send a controlled SMTP test message |
| `POST` | `/api/admin/settings/assets/logo` | Replace the Store logo asset |
| `DELETE` | `/api/admin/settings/assets/logo` | Remove the managed Store logo |
| `POST` | `/api/admin/settings/assets/favicon` | Replace the browser favicon asset |
| `DELETE` | `/api/admin/settings/assets/favicon` | Remove the managed favicon |
| `GET` | `/api/assets/logo` | Serve the active logo |
| `GET` | `/api/assets/favicon` | Serve the active favicon |
| `GET` | `/api/admin/audit` | List bounded administrative audit events |
| `GET` | `/api/admin/audit/<event_id>` | Read one audit event and its change details |

Settings asset uploads accept supported image formats and are optimized on the
server. The public logo and favicon URLs are resolved by the Store runtime;
clients should not hard-code generated asset filenames.

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
GET /scores?game=pong&player=Ada&limit=20
GET /api/scores?game=pong&limit=20
GET /api/scores?game=pong&player=Ada&limit=20
POST /api/scores
```

Submit JSON with a session or Bearer token:

```json
{"game":"pong","player":"Ada","score":42}
```

Scores are ordered by highest score first, then oldest timestamp first.
The browser scoreboard is available at `/scores` and accepts the same `game`,
`player`, and `limit` filters.

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
