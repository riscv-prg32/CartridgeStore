# Getting Started

This guide creates a consistent PRG32 Cartrige Store environment for local
development, classroom demos, and quick service validation.

## Requirements

- Python 3.13 is recommended. Python 3.11 or newer should also work.
- Git.
- Docker Engine and Docker Compose v2, if you want container deployment.
- A shell with `python3`, `pip`, and `pytest` available after setup.

## Clone

```bash
git clone https://github.com/riscv-prg32/CartridgeStore.git
cd CartridgeStore
```

## Python Virtual Environment

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Local Data Directory

```bash
mkdir -p data
export PRG32_STORE_DATA="$PWD/data"
export PRG32_STORE_DB="$PWD/data/cartrige_store.sqlite"
```

The directory stores uploaded cartridges under `data/cartridges`, custom theme
assets under `data/static`, the catalog index in `data/index.json`, and service
tables in `data/cartrige_store.sqlite`.

## First-Run Setup

`SECRET_KEY` is required. Generate one for development:

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

Start the server:

```bash
python app.py
```

Open `http://127.0.0.1:5080/auth/register` and create the first account. The
first registered user automatically receives the `admin` role. Visit `/setup`
as that user to change the store name, theme, auth defaults, logo, and publish
settings.

## Run Checks

```bash
python -m py_compile app.py cartridge_store/*.py
python -m pytest -q
git diff --check
```

## Publish and Scores

`POST /api/publish`, `POST /api/publish/bundle`, and `POST /api/scores` require
a logged-in browser session or Bearer token. Create a token at `/auth/tokens`
or with:

```bash
curl -X POST http://127.0.0.1:5080/auth/tokens \
  -b cookies.txt -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"label":"board"}'
```

Then submit scores:

```bash
curl -X POST http://127.0.0.1:5080/api/scores \
  -H "Authorization: Bearer prg32_..." \
  -H 'Content-Type: application/json' \
  -d '{"game":"pong","player":"Ada","score":42}'
```

Metrics ingestion remains open for firmware compatibility. Authenticated runs
are linked to the submitting user and appear under `/users/<username>/runs`.

## External Auth

Local username/password login always works. External adapters activate only
when their environment variables are set and their optional libraries are
installed:

- LDAP / Active Directory: set `PRG32_LDAP_URL` and related LDAP variables;
  install `ldap3`.
- SAML 2.0: set `PRG32_SAML_IDP_METADATA_URL`, SP entity/ACS values, and
  install `python3-saml`.
- OpenID Connect: set `PRG32_OIDC_ISSUER`, client id/secret, and install
  `authlib`.

If an adapter is configured but its library is absent, startup logs a warning
and local login remains available.

## Theme Customisation

Visit `/setup` as an admin to change colors, font family, store name, tagline,
logo URL, favicon URL, and custom CSS. Upload PNG, JPEG, or SVG logos with the
logo and favicon forms; files are stored under `data/static` and served from
`/static/custom/<filename>`.

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

## Docker Environment

For reproducible local deployment:

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
docker compose up --build
```

Open `http://127.0.0.1:5080/`. Persistent data remains in `./data`.
