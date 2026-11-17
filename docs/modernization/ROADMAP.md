# Modernization roadmap

The runtime cutover is complete when the Fastify API, Next.js frontend,
standalone Fumadocs service and one operator-selected edge are the only
application paths. Keep this file short; detailed audit evidence belongs in the
tranche report referenced below.

## Completed

- Split frontend API modules by domain while preserving public barrels.
- Established canonical Fastify catalog, workflow, auth, federation and
  telemetry boundaries.
- Removed the old application runtime, templates, static assets and Python
  dependency surface.
- Simplified development Compose to `backend`, `next`, `docs` and a selectable
  edge, with generic Traefik as the documented default and no required mail
  service.
- Switched browser API calls to the explicit API origin.
- Parameterized Store/API origins, local DNS, mkcert and edge networks.
- Added the standalone Fumadocs service and grouped PRG32 documentation areas.
- Added the PRG32 brand asset and dashboard UI refinements.

## Active next steps

- Download the current data from `store.prg32.uniparthenope.it` and upload it
  manually into the new site to demonstrate the catalog workflow.
- Replace placeholder deployment secrets with Docker secrets in the approved
  deployment environment.
- Keep the Fumadocs content synchronized with the maintained repository and
  companion-repository documentation snapshots.
- Revisit dashboard workspace decomposition after the public storefront is
  stable.
- Define API version discovery for firmware clients, including a stable
  bootstrap/discovery document and a compatibility strategy for legacy routes;
  validate the design against the working PRG32 firmware prototype before
  implementing it.

## Guardrails

- Preserve firmware routes, response fields, ABI names, architecture strings,
  binary format, WebSocket messages and SQLite schema.
- Do not migrate or mutate operational data as part of UI or runtime cleanup.
- Do not add a second API proxy or a second application runtime.
- Keep audit reports tranche-sized and delete obsolete working notes before a
  pull request.
