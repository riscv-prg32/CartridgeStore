# Getting Started

This guide creates a consistent PRG32 Cartridge Store environment for local
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
export PRG32_STORE_DB="$PWD/data/cartridge_store.sqlite"
```

The directory stores uploaded cartridges under `data/cartridges`, custom theme
assets under `data/static`, pending review packages under `data/pending`, the
catalog index in `data/index.json`, and service tables in
`data/cartridge_store.sqlite`.

## First-Run Setup

`SECRET_KEY` is required. Generate one for development:

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

Start the server:

```bash
python app.py
```

The server creates a default administrator account:

```text
username: admin
password: password
```

Log in at `http://127.0.0.1:5080/auth/login` and change the password before
using the service beyond a disposable local demo. The default admin is also in
the `editors` group. Visit `/setup` as that user to change the store name,
theme, auth defaults, logo, publish settings, mDNS advertisement, SMTP mail,
OpenID Connect, and SAML2.

New users register from `/auth/register` by entering only an email address. The
server sends a verification link; following it lets the user set a password.
The username is the verified email address. Without SMTP configured, the link
is logged for development.

## Run Checks

```bash
python -m py_compile app.py cartridge_store/*.py
python -m pytest -q
git diff --check
```

## Package Publish and Review

`POST /api/publish`, `POST /api/publish/bundle`, and `POST /api/scores` require
a logged-in browser session or Bearer token. Create a token at `/auth/tokens`
or with:

```bash
curl -X POST http://127.0.0.1:5080/auth/tokens \
  -b cookies.txt -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"label":"board"}'
```

Cartridges are published only as zip packages. Uploading a package creates a
pending submission:

```bash
curl -X POST http://127.0.0.1:5080/api/publish/bundle \
  -H "Authorization: Bearer prg32_..." \
  -F bundle=@game.zip
```

An editor must verify the submission before it appears in `/api/games`:

```bash
curl -X POST http://127.0.0.1:5080/api/submissions/1/verify \
  -b cookies.txt -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"metadata":{"title":"Reviewed Title"}}'
```

Editors may edit descriptive metadata, but the server preserves cartridge id,
version, and authorship from the uploaded package.

## Scores

Submit scores with a session or Bearer token:

```bash
curl -X POST http://127.0.0.1:5080/api/scores \
  -H "Authorization: Bearer prg32_..." \
  -H 'Content-Type: application/json' \
  -d '{"game":"pong","player":"Ada","score":42}'
```

Metrics ingestion remains open for firmware compatibility. Authenticated runs
are linked to the submitting user and appear under `/users/<username>/runs`.

## mDNS Discovery

The server advertises itself on the local network as `_prg32store._tcp.local.`
with TXT record `abi=prg32-store-discovery-1.0`. Disable this with:

```bash
export PRG32_MDNS_DISABLED=1
```

Use `PRG32_MDNS_NAME` to override the advertised instance name.

Administrators can also edit mDNS enabled/name/type/port values from `/setup`.
Environment variables still take precedence after restart.

## External Auth

Local username/password login always works. External adapters activate only
when enabled from `/setup` or environment variables and their optional
libraries are installed:

- LDAP / Active Directory: set `PRG32_LDAP_URL` and related LDAP variables;
  install `ldap3`.
- SAML 2.0: enable SAML2, set SP entity/ACS values plus IdP entity, SSO URL,
  and X.509 certificate; install `python3-saml`.
- OpenID Connect: enable OIDC, set issuer plus client id/secret; install
  `authlib`.

If an adapter is configured but its library is absent, startup logs a warning
and local login remains available.

## Registration Email

Set these variables to send registration links by SMTP:

```bash
export PRG32_SMTP_HOST=smtp.example.edu
export PRG32_SMTP_PORT=587
export PRG32_SMTP_FROM=noreply@example.edu
export PRG32_SMTP_USER=cartridge-store
export PRG32_SMTP_PASSWORD=secret
```

`PRG32_SMTP_TLS` defaults to `true`; set it to `false` only for trusted local
SMTP relays.

The same values can be edited at `/setup`. Environment variables override
database setup values when both are present.

## Administration

Admin-only pages:

- `/admin/users` creates, edits, deletes, and assigns roles/groups to users.
- `/admin/groups` creates, renames, and deletes groups. A user can belong to
  many groups.
- `/admin/roles` lists the fixed service roles and current user counts.
- `/admin/backup` downloads and restores full service backups.

Administrators and users in the `editors` group can use `/admin/cartridges` to
edit cartridge title, summary, and tags, or delete variants/versions.

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
