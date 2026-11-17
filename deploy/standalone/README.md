# PRG32 Cartridge Store standalone deployment

This directory is the infrastructure-independent deployment boundary. It
runs exactly two application services: Fastify and Next.js. SQLite and
immutable storage remain inside Fastify's operator-controlled bind mount.

The base file has no host ports, external networks, proxy labels, Dream
services, identity-provider services, SMTP fixture or database server. It can
therefore be used with any reverse proxy or with a private application network.

This production-oriented boundary intentionally contains only Fastify and
Next.js. The local Fumadocs service is deployed separately through the root
development Compose topology; add it to a production edge only after defining
its own image, content release process and public `/docs` route.

## Prerequisites

- Linux host with Docker Engine and a Compose implementation supporting
  Compose secrets and health-gated `depends_on`.
- A local filesystem suitable for SQLite locking.
- Node.js 24 and pnpm 12.5.1 only when building from source outside Docker;
  the operational images build with Node.js 24 themselves.
- An operator-controlled canonical directory, an external 0600 key registry,
  and four application secret files.

Create those paths with the operator's chosen ownership and permissions. Do not
use the Git checkout as the canonical data directory. The application expects
Fastify to be the sole writer.

Copy the safe template from `deploy/examples/standalone.env.example` into the
operator's secret/configuration system. Never commit a populated environment
file or place secret values in the image.

Create these files below `PRG32_SECRET_DIR`, outside the repository, with
operator-controlled ownership and permissions:

```text
canonical-read-authorization
canonical-write-authorization
session-secret
bootstrap-token
```

Each file must contain one value, may end with a newline, and must contain at
least 32 characters where the backend requires a strong secret. Compose mounts
them as read-only Docker secrets; the backend reads them through the matching
`*_FILE` configuration and never receives their contents through Compose
interpolation.

## Model A: external reverse proxy

The recommended model terminates HTTPS in a separately managed reverse proxy.
The proxy must forward to Fastify on port 5080 and Next.js on port 3000 over an
operator-created Docker network. Use `compose.proxy.yaml` only when that
network already exists:

```bash
docker network create prg32_proxy
PRG32_PROXY_NETWORK=prg32_proxy \
  docker compose -f deploy/standalone/compose.yaml \
  -f deploy/standalone/compose.proxy.yaml up -d
```

The proxy must preserve the original HTTPS host, set trusted forwarded headers
only from the proxy, enforce request/body limits, and support WebSocket
upgrades. It must route the store origin to Next.js and the API origin to
Fastify. The public origins in the environment must be HTTPS origins and must
match the OIDC redirect, SAML ACS, WebAuthn origin and cookie policy.

Set `PRG32_TRUST_PROXY=true` only when this boundary is enforced. The
canonical-operational backend deliberately refuses to start without the
trusted-proxy contract; do not expose Fastify directly on a non-loopback host.

Required callback shapes are:

```text
https://<api-host>/api/auth/oidc/<providerId>/callback
https://<api-host>/api/auth/saml/<providerId>/acs
```

## Model B: loopback-only diagnostics

The direct overlay publishes only loopback ports and is intended for local
health/setup diagnostics, not public production:

```bash
docker compose -f deploy/standalone/compose.yaml \
  -f deploy/standalone/compose.direct.yaml up -d
```

The default ports are Fastify `127.0.0.1:15080` and Next.js
`127.0.0.1:13000`. This does not provide public HTTPS. Because production
sessions remain Secure and provider/WebAuthn origins require HTTPS, use a local
TLS terminator before attempting the complete browser authentication/setup flow.
Do not weaken cookies, CSRF or origin validation to make plain HTTP appear to
work.

The repository's `compose.test.yaml` is a disposable-only acceptance overlay.
It uses `NODE_ENV=test` and disables Secure-cookie enforcement solely for the
synthetic loopback test; it must never be used as a production override.

## First installation and persistence

The bootstrap token authorizes the one-time first administrator flow. The
wizard stores application settings, setup state, authentication state, passkey
credentials, federation records, metrics, scores, publication state and audit
records in canonical SQLite. Bootstrap and infrastructure secret material stay
outside SQLite.

After first installation, rotate or remove the bootstrap token according to the
operator's recovery policy. Restarting Fastify must preserve the canonical
database and object tree because `/data/canonical` is a persistent bind mount.

## SMTP, identity, WebAuthn and mDNS

SMTP is disabled by default and can be configured in the setup/admin workflow
with host, port, `none`, `starttls` or `implicit_tls`, authentication and sender
policy. Private/internal SMTP destinations require explicit outbound-policy
authorization; no private-network wildcard is enabled.

OIDC and SAML are generic provider records. Supply issuer/discovery, client
secret references, scopes, entity IDs, ACS URL, certificates and identity
mapping through the existing administration flow. No Authentik or university
provider is required.

WebAuthn is disabled by default. Enabling it requires an explicit RP ID and
HTTPS origin list compatible with that RP ID, plus an approved account-recovery
policy. mDNS remains disabled by default and does not require UDP 5353.

## Backup and upgrades

Use the existing encrypted authenticated backup-v4 tooling with an external key
registry and an operator-controlled archive destination. The Docker scheduler
uses SQLite's online backup API and mounts the canonical root read-only; the
explicit `exclusive` CLI mode remains available when an operator has separately
quiesced the writer. Restore always targets a fresh root and must be verified
before use. Public backup HTTP routes are not enabled by Compose.

For upgrades, build the same operational images, keep the canonical root and
key registry outside the image, run the read-only readiness/integrity checks,
and retain a verified backup before replacing containers. Rollback is not a
blind restart if post-upgrade writes have occurred; reconcile those writes or
apply an explicitly approved data-loss policy.

## Optional Dream integration

Dream is an opt-in integration only. Combine the base file with
`deploy/integrations/dream/compose.override.yaml` only after the external
`dream_edge` and `dream_mail` networks, public origins, Traefik and Mailpit
policy have been separately approved. The overlay does not create or modify
Dream infrastructure.
