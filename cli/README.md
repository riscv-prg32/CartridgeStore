# PRG32 Store CLI

`prg32-store` is the non-interactive administrative client for the Fastify
backend. It is a client, not a second backend or database writer.

Use Node.js 24 and pnpm from the repository root:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
pnpm --dir cli install --frozen-lockfile
pnpm --dir cli dev -- --help
```

Remote examples:

```bash
PRG32_STORE_URL=https://store.example.test \
PRG32_STORE_TOKEN_FILE=/path/to/token \
pnpm --dir cli dev -- --json games list

pnpm --dir cli dev -- --server https://store.example.test \
  --token-env CI_PRG32_TOKEN submissions list --status pending
pnpm --dir cli dev -- cartridges validate ./release.zip
pnpm --dir cli dev -- cartridges upload ./release.zip
```

The token file must be a regular file with mode `0600` or stricter. Tokens are
only sent as `Authorization: Bearer`; they are never printed or forwarded to
redirect targets. Remote authenticated operations require HTTPS. HTTP is
accepted only for loopback development servers.

Supported remote groups are `status`, `version`, `doctor`, `games`,
`cartridges`, `submissions`, and read-only `users`. Cartridge validation is
bounded locally, while the Fastify upload endpoint remains authoritative for
ZIP validation, staging, ownership, review and audit.

Local backup-v4 maintenance delegates to the existing backend backup-v4 CLI:

```bash
pnpm --dir cli dev -- backup create --source /absolute/canonical \
  --output /absolute/backup.backup4 --key-registry /absolute/key-registry.json
pnpm --dir cli dev -- backup verify --archive /absolute/backup.backup4 \
  --key-registry /absolute/key-registry.json
pnpm --dir cli dev -- backup restore --yes --archive /absolute/backup.backup4 \
  --target /absolute/new-root --key-registry /absolute/key-registry.json
```

Backup source, output, key registry and restore target are always explicit;
there are no operational defaults. Restore requires `--yes`/`--confirm` and
the backend storage lock and fresh-target checks remain authoritative.

For an isolated one-shot Docker client, build `cli/Dockerfile` from the
repository root and pass the same remote arguments to the image. The image is
Node 24 slim, contains no Python, SQLite or extra runtime service, and is not a
Compose runtime service. Local backup-v4 maintenance intentionally remains
host-side so the existing backend implementation and storage lock are reused:

```bash
docker build -f cli/Dockerfile -t prg32-store-cli:local .
docker run --rm prg32-store-cli:local --server https://store.example.test doctor
```
