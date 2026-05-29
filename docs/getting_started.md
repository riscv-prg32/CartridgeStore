# Getting Started

This guide creates a consistent PRG32 Cartrige Store environment for local
development, classroom demos, and quick service validation.

## Requirements

- Python 3.13 is recommended. Python 3.11 or newer should also work.
- Git.
- Docker Engine and Docker Compose v2, if you want container deployment.
- A shell with `python3`, `pip`, and `pytest` available after setup.

The service uses Flask for HTTP/PWA routes, SQLite for score and metrics data,
and a WebSocket endpoint for multiplayer relay traffic.

## Clone

```bash
git clone https://github.com/riscv-prg32/CartridgeStore.git
cd CartridgeStore
```

## Python Virtual Environment

Create the virtual environment inside the repository:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Confirm the environment:

```bash
python --version
python -m pytest -q
```

Expected result:

```text
14 passed
```

The exact count can grow as tests are added, but the suite should pass.

## Local Data Directory

Use a repository-local data directory for development:

```bash
mkdir -p data
export PRG32_STORE_DATA="$PWD/data"
export PRG32_STORE_DB="$PWD/data/cartrige_store.sqlite"
```

The directory stores:

- uploaded cartridge artifacts under `data/cartridges`;
- the extracted catalog index in `data/index.json`;
- score and metrics tables in `data/cartrige_store.sqlite`.

## Run Locally

```bash
python app.py
```

Open:

```text
http://127.0.0.1:5080/
```

The development entrypoint binds to localhost. For LAN classroom access without
Docker, run a WSGI server explicitly:

```bash
gunicorn --bind 0.0.0.0:5080 --threads 8 --timeout 120 app:app
```

## Verify Service Discovery

```bash
curl http://127.0.0.1:5080/.well-known/prg32-store.json
```

The response should include `services.cartridges`, `services.scores`,
`services.metrics`, and `services.multiplayer`.

## Smoke Test Scores

```bash
curl -X POST http://127.0.0.1:5080/api/scores \
  -H 'Content-Type: application/json' \
  -d '{"game":"pong","player":"Ada","score":42}'

curl http://127.0.0.1:5080/api/scores?game=pong
```

## Smoke Test Metrics

```bash
curl -X POST http://127.0.0.1:5080/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"demo-run","board_id":"board-1","target":"esp32c6"}'

curl -X POST http://127.0.0.1:5080/api/metrics/batch \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"demo-run","samples":[{"frame":1,"frame_us":16000}]}'

curl http://127.0.0.1:5080/api/runs/demo-run/report.md
```

Missing sample fields default to zero so short smoke-test payloads are accepted.

## Smoke Test Multiplayer

The multiplayer endpoint is:

```text
ws://127.0.0.1:5080/api/multiplayer
```

Clients send JSON messages:

```json
{"type":"join","signature":"pong-v1","player_id":1}
{"type":"state","x":120,"y":80,"sprite":0,"flags":0,"input":2,"frame":42}
{"type":"leave"}
```

Clients with the same signature share state. Different signatures are isolated.

## Docker Environment

For the most reproducible local deployment, use Docker Compose:

```bash
docker compose up --build
```

Open:

```text
http://127.0.0.1:5080/
```

Stop the service:

```bash
docker compose down
```

Persistent data remains in `./data`.

## Common Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRG32_STORE_DATA` | `data` or `/data` in Docker | Cartridge files and default database location |
| `PRG32_STORE_DB` | `<data>/cartrige_store.sqlite` | Unified SQLite database |
| `PRG32_SCORE_DB` | unset | Legacy score database fallback |
| `PRG32_METRICS_DB` | unset | Legacy metrics database fallback |
| `PRG32_MP_MAX_PEERS` | `8` | Maximum WebSocket peers per cartridge signature |

## Development Checks

Run these before committing:

```bash
python -m py_compile app.py cartridge_store/*.py
python -m pytest -q
git diff --check
```

For Docker changes:

```bash
docker compose config
docker build -t prg32-cartrige-store:local .
```
