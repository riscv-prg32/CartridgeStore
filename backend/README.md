# PRG32 Fastify backend

The backend is the canonical PRG32 API runtime. It is pinned to Node 24 and
listens on `127.0.0.1:5090` during direct development.

## Local usage

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 24
pnpm install
PRG32_BACKEND_DB=/absolute/path/to/disposable/store.sqlite pnpm dev
```

`GET /health` is liveness. `GET /ready` checks the configured SQLite and
canonical filesystem root without exposing paths. The service never silently
creates an operational database or changes storage roots.

## Runtime responsibilities

Fastify serves authentication, federation, administration, setup, catalog,
publication, review, scores, metrics, statistics, multiplayer, discovery and
backup APIs from one process. Feature modules remain separated under
`backend/src` and are composed by `src/app.ts`.

## Checks

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```
