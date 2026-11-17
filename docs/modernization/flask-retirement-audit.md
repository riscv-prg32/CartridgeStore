# Fastify runtime cutover audit

Date: 2026-10-19 (historical cutover snapshot)
Branch: `development`
Baseline: `085bb7e`

## Decision

The repository is being cut over to one Fastify/TypeScript backend and one
Next.js frontend. The Flask runtime is retired from the application topology;
the remaining `storage-v2/legacy` modules are offline migration and inventory
utilities only. They do not start a server, own a route, or participate in the
development Compose profile.

No operational or demonstration data was migrated, deleted, or rewritten.

## Final topology

```text
local store.prg32.test  -> Next.js
local api.prg32.test    -> Fastify
production configured store host -> Next.js
production configured api host   -> Fastify
```

The first two hosts are local-only names resolved by the operator's dnsmasq
and selected local edge. They are not production domains. A production server
must provide its own registered DNS names, TLS certificates, public origins,
cookie domain, and WebSocket URL. The external edge owns TLS and host routing;
the browser calls the API origin directly. The current development topology
contains `backend`, `next`, `docs` and one selected edge, with the canonical
local data root mounted at `.local/candidate/canonical` by default.

## Route and contract audit

Fastify is the sole owner of:

- catalog listing, detail, media, colophon and binary download routes;
- `/api/publish`, `/api/publish/bundle`, submissions, review and publication;
- scores, runs, metrics batch ingestion and statistics;
- authentication, sessions, CSRF, passkeys, OIDC, SAML and federation;
- administration, setup, backup and discovery;
- `/api/multiplayer` and `/api/multiplayer/status`.

The following compatibility boundaries were preserved:

- firmware route names and response fields;
- `esp32c6` and `qemu` architecture identifiers;
- `prg32-store-discovery-1.0`, `prg32-metadata-1.0` and
  `prg32-colophon-1.0` ABIs;
- `.prg32` binary storage and download behavior;
- SQLite schema and idempotent migrations;
- WebSocket message and authentication behavior;
- public origins and the discovery document.

The frontend no longer has API rewrite routes or a second backend target.
Admin, workflow and auth clients use the explicit Fastify API origin while
their public barrels remain available for compatibility.

## Removed transitional surface

- root Python application, templates, PWA static assets and Python dependency
  manifests;
- root Python tests and compatibility generators that required the retired
  process;
- Compose services and edge bridge configuration for the retired topology;
- frontend proxy route, proxy helper and transitional origin variables;
- readiness differential runner that invoked a Python process;
- obsolete milestone E2E files and proxy-only path assertions.

Storage inventory, migration, backup and verification utilities remain because
they are still useful for a future controlled data import and do not run as
application services.

## Validation record

Final checks completed during the cutover:

- Node `24.20.0` selected through nvm;
- frontend typecheck, lint, build and Vitest: `49` files, `110` tests passed;
- backend typecheck, lint, build and Vitest: `56` files, `291` tests passed;
- Python smoke test: `1` test passed using the repository `.venv313` runner;
- Docker Compose configuration validation passed;
- Docker Compose dev stack rebuilt with healthy Fastify and Next services;
- Dream checks returned HTTP 200 for storefront, health, readiness, catalog,
  discovery, providers and multiplayer status;
- unauthenticated `/api/auth/me` returned the expected HTTP 401;
- `git diff --check` passed;
- the forbidden-reference search found only this historical audit report and
  its README link.

## Data and environment notes

The current canonical local database has no imported public catalog and no
configured federation providers. This is an observed state, not a migration
result. It must not be changed as part of this refactor.

The requested follow-up is recorded in the roadmap: manually download the
catalog data from `store.prg32.uniparthenope.it`, then upload it through the
new site to demonstrate the workflow. That is a separate, user-controlled data
operation and is not performed by this cutover.

## Risks and follow-up

- Deployment templates need their operator-provided Docker secret files and
  exact public origins before production use.
- Browser E2E suites use disposable data and should be run in the platform
  environment when Playwright browsers and SMTP capture are available.
- The dashboard presentation can continue to be decomposed after the
  storefront/runtime cutover; it is outside this runtime boundary.
- Fumadocs now consumes the maintained documentation snapshots through the
  standalone `docs-site` service; keep those snapshots reviewed when source
  repositories change.

## Commits created

The cutover was committed without pushing:

1. `refactor(backend): make fastify the canonical runtime`
2. `refactor(frontend): remove legacy flask proxies`
3. `refactor(infrastructure): simplify development compose`
4. `refactor(legacy): remove flask application`

Each commit will contain a Conventional Commit body describing the preserved
contracts and the validation performed.
