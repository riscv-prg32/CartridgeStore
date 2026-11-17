# Security model

## Trust boundaries

1. Browsers and firmware clients are untrusted inputs.
2. Fastify is the only application API authority.
3. Next.js is presentation code and must not duplicate API business rules.
4. The operator-controlled edge terminates external TLS and routes exact hosts. The backend still
   validates configured origins and forwarded headers.

## Authentication and federation

- Session cookies are HttpOnly and follow the configured Secure/SameSite policy.
- Browser mutations require a session-bound CSRF token.
- Password, role, group and token changes revoke durable access as required.
- Authentication rate limits and recent re-authentication protect sensitive
  administration operations.
- OIDC and SAML are provider-neutral protocols with bounded metadata and
  encrypted secrets.
- Anonymous data must not expose identifying run or export information.

## Input and resource containment

Cartridge and backup archives are rejected before extraction when possible.
Limits cover archive bytes, entry count, entry and total expanded bytes,
compression ratio, manifest size, duplicate names, traversal, absolute paths,
symlinks, unsupported file types and derived-file policy.

Metrics ingestion bounds payload size, sample count, database work, nesting and
invalid structures. Errors are stable JSON envelopes and never expose secrets.

Uploads never execute cartridge code. Cartridge binaries remain on the
filesystem; SQLite stores metadata and service records.

## Write isolation

- Production writes use the canonical SQLite/filesystem root only through the
  Fastify process.
- Disposable test modes require explicit roots and authorizations.
- Publication and backup workflows validate references before mutation.
- Cross-store journal and recovery states compensate for the lack of one
  atomic transaction across SQLite and the filesystem.
- Secret encryption requires an explicit key registry and migration state.
- CORS uses exact configured origins; wildcard production CORS is forbidden.

## Production checklist

- Set high-entropy session and bootstrap secrets outside Git.
- Use HTTPS and Secure cookies.
- Configure exact frontend/API origins and reverse-proxy WebSocket support.
- Configure SMTP without putting credentials in Compose or documentation.
- Protect backup and key-registry paths and test restore procedures.
- Keep `/data` on durable storage with restricted ownership.
- Review mDNS exposure and disable it when classroom discovery is not needed.
- Run backend/frontend checks and `docker compose config` before release.
