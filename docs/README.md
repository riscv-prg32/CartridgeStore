# PRG32 Cartridge Store documentation

The repository has one application runtime: a Fastify API and a Next.js
frontend. Local development uses configurable dnsmasq hostnames, defaulting to
`api.prg32.test` and `store.prg32.test`, with local HTTPS provided by mkcert
and the generic Traefik overlay. Production uses separately configured
registered domains; see [Deployment](deployment.md).

The local Store origin serves the storefront and dashboard, while the dedicated
Fumadocs service owns `/docs`. The documentation hub groups the Store API,
PRG32 Platform, Construction Kit, Computer Architecture and Textbook material
under one sidebar.

## Start here

| Need | Document |
| --- | --- |
| Understand the running system | [Architecture](architecture.md) |
| Start the generic local edge | [Development](development.md) |
| Understand the optional Dream integration | [Dream Platform](dream-platform.md) |
| Start local development | [Development](development.md) |
| Configure services | [Configuration](configuration.md) |
| Review security rules | [Security](security.md) |
| Understand canonical persistence | [Storage schema](storage-schema.md) |
| Integrate firmware and tools | [API](api.md) and [Firmware API versioning](firmware-api-versioning.md) |
| Run Docker deployments | [Docker](docker.md) and [Deployment](deployment.md) |
| Operate the service | [Operations](operations.md) |
| Work on the Fumadocs service | [docs-site README](../docs-site/README.md) |
| Review the active roadmap | [Modernization roadmap](modernization/ROADMAP.md) |

For the browser entrypoints, use `https://store.prg32.test` for the Store,
`https://store.prg32.test/docs` for Fumadocs and
`https://api.prg32.test/health` for API liveness when using the default local
`.env` values. Change the hostnames together in `.env`, dnsmasq and the mkcert
certificate when using a different local suffix.

Code and tests are authoritative for current behavior. Public route names,
response fields, identifiers, architecture strings and ABI names remain stable
for PRG32 firmware and tools.
