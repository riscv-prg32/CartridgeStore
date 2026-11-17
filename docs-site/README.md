# PRG32 Fumadocs service

This package is the documentation application for PRG32. It is a standalone
Next.js/Fumadocs service, separate from the Store frontend, and is published
under the Store host at `/docs` by the selected reverse-proxy edge.

## Content source

The canonical documentation source is
[`frontend/content/docs`](../frontend/content/docs). The development Compose
topology mounts that directory into this service; the production image copies
the same content during its build. Edit the Markdown/MDX files in the
frontend content directory, not generated files under `.source` or `.next`.

The sidebar is grouped into documentation areas with Fumadocs folders:

- Store
- PRG32 Platform
- Construction Kit
- Computer Architecture
- Textbook

Icons are declared in each section's front matter and resolved in
`src/lib/source.ts`.

## Run directly

Use Node.js 24 and pnpm:

```bash
pnpm install --frozen-lockfile
NEXT_PUBLIC_PRG32_STORE_ORIGIN=http://127.0.0.1:3000 pnpm dev
```

The direct server listens on port 3000 and serves the application with its
`/docs` base path, so open `http://127.0.0.1:3000/docs`.

## Run with the local edge

From the repository root:

```bash
cp .env.example .env
./deploy/local/setup-tls.sh
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build docs traefik
```

The generic edge routes `https://store.prg32.test/docs` to this service and
keeps the Store application and API as separate upstreams. The hostname is a
configurable local default; change the root Compose variables, dnsmasq entry
and mkcert certificate together when using another local suffix.

## Checks

```bash
pnpm run typecheck
pnpm run build
```

The content build runs through `fumadocs-mdx` during `pnpm install`. A failed
MDX build is a documentation error and should be fixed before deploying the
image.
