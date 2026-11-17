# PRG32 Store API versioning contract

This document is the implementation contract for firmware clients of the PRG32
Cartridge Store. It is written for the ESP32-C6 DevKit-1 firmware and for the
QEMU target. It deliberately uses example domains only: a deployment provides
its own DNS name, TLS certificate, and public API origin.

## Contract boundary

The Store has one stable bootstrap document and one versioned public API:

```text
GET /.well-known/prg32-store.json
GET /api/v1/...
WS  /api/v1/multiplayer
```

The `.well-known` URL is intentionally not versioned. It is the discovery
document that tells a client which API generations and capabilities the Store
currently exposes.

The canonical API base path for the first generation is:

```text
/api/v1
```

The existing `/api/...` paths remain available as compatibility aliases for
older firmware and tools. New firmware must use the version and URLs returned
by the discovery document and must not hard-code an unversioned API path.

## Discovery flow

The board should follow this sequence:

1. Discover the Store through the configured transport, such as mDNS.
2. Fetch `/.well-known/prg32-store.json` over the discovered HTTP origin.
3. Verify the discovery ABI and read `api_versions`.
4. Select the highest supported stable major version, or use
   `default_api_version` when present.
5. Resolve all endpoint URLs from the selected `base_url` or `services_v1`.
6. Cache the manifest together with its expiry metadata and refresh it when
   the Store is reachable again.

The client must not infer the API origin from the browser Store origin. A
deployment may expose the Store UI and the API through different public
origins.

## Discovery document

The response is JSON and keeps the historical `api` and `services` fields for
compatibility. New firmware should use the versioned fields shown below:

```json
{
  "abi": "prg32-store-discovery-1.0",
  "name": "PRG32 Cartridge Store",
  "api": "https://api.example.test/api",
  "api_version": "v1",
  "api_base": "https://api.example.test/api/v1",
  "api_versions": [
    {
      "version": "v1",
      "status": "stable",
      "base_url": "https://api.example.test/api/v1"
    }
  ],
  "web": "https://store.example.test/",
  "version": "1.0.0",
  "auth_enabled": true,
  "services_v1": {
    "cartridges": "https://api.example.test/api/v1/games",
    "bundle_publish": "https://api.example.test/api/v1/publish/bundle",
    "submissions": "https://api.example.test/api/v1/submissions",
    "scores": "https://api.example.test/api/v1/scores",
    "metrics": "https://api.example.test/api/v1/runs",
    "multiplayer": "wss://api.example.test/api/v1/multiplayer",
    "multiplayer_status": "https://api.example.test/api/v1/multiplayer/status"
  }
}
```

Required discovery constants remain:

| Field | Required value |
| --- | --- |
| `abi` | `prg32-store-discovery-1.0` |
| mDNS service type | `_prg32store._tcp` |
| mDNS default port | `5080` |
| `api_versions[].version` | `v1` for the first stable generation |

An unknown API version must be ignored. If no stable version is supported, the
client should report an unsupported Store API instead of guessing a path.

## Version selection rules

The path contains the major API version only:

```text
/api/v1/games
/api/v2/games
```

Minor and patch-compatible changes do not create a new URL. They are described
by the server implementation and by optional response metadata. A new major
version is introduced as a new path and as a new entry in `api_versions`.

The firmware should treat these fields as compatibility rules:

- new response fields are allowed and must be ignored when unknown;
- existing fields must not change type or meaning within `v1`;
- fields documented as optional may be absent;
- an unknown enum value must be handled as an unsupported/unknown value;
- clients must not depend on JSON field ordering;
- clients must honor HTTP status codes before parsing a success payload.

## Versioned endpoint map

### Catalog and downloads

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/games` | List published cartridges |
| `GET` | `/api/v1/games/{game_id}` | Read cartridge metadata |
| `GET` | `/api/v1/games/{game_id}/icon` | Download icon bytes |
| `GET` | `/api/v1/games/{game_id}/screenshot` | Download screenshot bytes |
| `GET` | `/api/v1/games/{game_id}/colophon` | Read colophon JSON |
| `GET` | `/api/v1/games/{game_id}/download` | Download the `.prg32` artifact |

Catalog query parameters remain compatible with the existing contract:

- `version` selects a published version;
- `architecture` selects `esp32c6` or `qemu`;
- `q` or `search` filters catalog results;
- `page` and `per_page`/`limit` control pagination.

The list response retains the `games` array and includes pagination metadata:

```json
{
  "ok": true,
  "games": [],
  "pagination": {
    "page": 1,
    "per_page": 100,
    "total": 0,
    "pages": 0,
    "has_next": false,
    "has_prev": false
  }
}
```

Download responses are binary `application/vnd.prg32.cartridge` files. The
server supports `Range`, `ETag`, `Last-Modified`, and `If-None-Match` so a
firmware client can resume or validate a download without downloading it
again.

### Scores

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/scores` | Read scores |
| `POST` | `/api/v1/scores` | Submit a score |

Bearer/API-token clients may submit without a browser CSRF token. Browser
cookie sessions still require the normal CSRF header. Score validation and
rate-limit errors are returned as JSON.

### Metrics and runs

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/metrics` | Read metrics service metadata |
| `POST` | `/api/v1/runs` | Start a run |
| `POST` | `/api/v1/metrics/batch` | Submit metric samples |
| `POST` | `/api/v1/runs/{run_id}/finish` | Finish a run |
| `GET` | `/api/v1/runs` | List runs visible to the client |
| `GET` | `/api/v1/runs/{run_id}` | Read one run |
| `GET` | `/api/v1/runs/{run_id}/samples.csv` | Export samples as CSV |
| `GET` | `/api/v1/runs/{run_id}/report.md` | Export the run report |

Metric payloads must stay within the server-advertised request limits. A
firmware client should batch samples, retry only transient failures, and avoid
duplicating a batch when a request result is unknown.

### Multiplayer

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/multiplayer` | Read relay metadata |
| `GET` | `/api/v1/multiplayer/status` | Read relay status |
| `WS` | `/api/v1/multiplayer` | Open the multiplayer relay |

The WebSocket URL must be taken from `services_v1.multiplayer` when available.
The relay protocol remains the existing `game-v1` protocol; HTTP API
versioning does not change the message types:

```json
{"type":"join","signature":"game-v1","player_id":1}
{"type":"state","x":0,"y":0,"frame":0}
{"type":"leave"}
```

## Authentication

Public catalog reads are available without credentials. Score submission,
metrics and multiplayer may use a Bearer token when the deployment requires
authentication. The accepted form is:

```http
Authorization: Bearer <token>
```

The legacy `X-PRG32-Token` header remains accepted for compatibility. Firmware
must never send browser session cookies or administrator credentials.

## Errors and retry behavior

Successful JSON responses use the endpoint-specific payload documented above.
Errors are JSON and include a stable machine-readable `code` when available:

```json
{
  "ok": false,
  "error": "requested game was not found",
  "code": "game_not_found",
  "request_id": "req_123"
}
```

Recommended client behavior:

| Status | Firmware behavior |
| --- | --- |
| `400` | Fix or discard the request; do not retry unchanged |
| `401`/`403` | Refresh credentials or report authorization failure |
| `404` | Treat the resource/version as unavailable |
| `409` | Re-read state before retrying |
| `413` | Reduce payload size |
| `429` | Honor `Retry-After` when present |
| `5xx`/network timeout | Retry with bounded exponential backoff |

Every request should have a finite timeout. A retry must be idempotent or use
an application-level identifier that lets the server recognize a duplicate.

## Conformance checklist

A firmware implementation is ready when it can:

- discover the Store and fetch the unversioned `.well-known` document;
- validate `prg32-store-discovery-1.0`;
- select `v1` from `api_versions` without hard-coded host names;
- list games and parse pagination safely;
- select `esp32c6` and download a `.prg32` artifact;
- use conditional/range download headers when supported;
- read and submit scores;
- start, update, and finish a metrics run;
- connect to the versioned multiplayer WebSocket;
- ignore unknown JSON fields and enum values safely;
- distinguish permanent errors from retryable transport/server errors;
- operate correctly when the manifest advertises no supported API version.

## Compatibility policy

The backend currently serves the historical `/api/...` paths and the canonical
`/api/v1/...` paths through the same handlers. This keeps already deployed
firmware working while new firmware adopts the explicit versioned contract.
The old paths are compatibility aliases, not a second implementation. Future
major versions will be added beside `v1` and announced through the discovery
manifest before they become selectable.
