---
title: Setup
---

# Setup Guide

## Requirements

- Python 3.11 or newer.
- A modern browser.
- Optional: the PRG32 build tools and the RISC-V compiler when real `.prg32`
  files are required. See the [cartridge build guide](./cartridge-build).
- Optional: a PRG32 Cartridge Store instance when publishing from the app.

## Local Python setup

```bash
git clone https://github.com/riscv-prg32/PRG32-Construction-Kit.git
cd PRG32-Construction-Kit
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open:

```text
http://127.0.0.1:5090/
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRG32_KIT_DATA` | `data` | Persistent data directory. |
| `PRG32_KIT_DB` | `$PRG32_KIT_DATA/construction_kit.sqlite` | SQLite path. |
| `DATABASE_URL` | unset | SQLAlchemy URL; overrides the SQLite path. |
| `PRG32_KIT_PORT` | `5090` | HTTP port. |
| `PRG32_STORE_URL` | `https://api.prg32.test` | Default Cartridge Store API URL when using the generic local edge. |
| `PRG32_BUILD_COMMAND` | `<kit python> -m prg32 cartridge build` | Command used by Compile Cartridge and Download .prg32. The default uses the same Python that runs the kit. |
| `PRG32_MAX_PARALLEL_BUILDS` | CPU cores | Compilers running at the same time (`concurrent_builds.md`). |
| `PRG32_BUILD_QUEUE_TIMEOUT` | `180` | Seconds a build waits for a free compiler. |
| `PRG32_BUILD_TIMEOUT` | `120` | Seconds one compiler run may take. |
| `PRG32_CART_RAM_KIB` | `64` | Cartridge RAM profile passed to the current PRG32 builder. Match this to the target firmware profile. |
| `SECRET_KEY` | random, saved in `$PRG32_KIT_DATA/secret_key` | Signs the sign-in cookie. |
| `PRG32_ADMIN_PASSWORD` | `password` | Password of the first `admin` account. Change it after the first sign-in. |
| `PRG32_SSO_SECRET`, `PRG32_SSO_PEER_URL` | unset | Share accounts with a Cartridge Store. |

Accounts, registration email and single sign-on settings are listed in
`accounts_and_sso.md`.

## Initialize or reset data

The database is created automatically. To reset a development checkout:

```bash
rm -rf data
python app.py
```

A starter project, starter sprite, and local publish profile are seeded when the database is empty.

## Database choice

SQLAlchemy abstracts all application database access. SQLite remains the
default because it needs no database server and works well for local use and a
small classroom. Existing `construction_kit.sqlite` files retain the same table
and column layout and can be opened directly after this update.

For a shared production deployment, use PostgreSQL rather than a SQLite file.
It handles concurrent writers, backups, permissions, and multiple application
workers more reliably. Install the production dependencies and set a URL:

```bash
pip install -r requirements-production.txt
export DATABASE_URL="postgresql+psycopg://prg32:password@database/prg32_kit"
python app.py
```

Do not commit the production password. Inject `DATABASE_URL` through the
hosting platform's secret or environment configuration.

## Switching on cartridge builds

The app can generate C without a PRG32 toolchain. To also create real
`.prg32` cartridge files, follow the [cartridge build guide](./cartridge-build).
In short, from
a `PRG32` checkout next to this one:

```bash
.venv/bin/pip install --no-deps -e ../PRG32
export PATH="$HOME/.espressif/tools/riscv32-esp-elf/esp-14.2.0_20241119/riscv32-esp-elf/bin:$PATH"
.venv/bin/python tools/check_build.py
```

The check compiles real cartridges for several pretend students in several
browser windows at once, and says what is missing if anything is.

Then open a project and click **Download .prg32** to get a cartridge file
directly, or **Compile Cartridge** to build every target plus the Cartridge
Store bundle.
