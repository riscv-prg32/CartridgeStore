# Operations

## Health and logs

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml ps
docker compose -f docker-compose.yml -f docker-compose.traefik.yml logs --tail=200 backend next docs traefik
curl -fsS https://api.prg32.test/health
curl -fsS https://api.prg32.test/ready
```

The commands above target the repository-owned Traefik edge. If the optional
Dream integration is running, use the same commands with
`docker-compose.dream-platform.yml` and include `backend next docs` in the
service selection. Do not run two edge overlays at the same time.

## Backups

Use the Fastify backup service and its administrative API. Backups must include
the canonical SQLite database, filesystem objects, managed assets and the
manifest required by the restore verifier. Restore into a disposable root
first, verify integrity, then schedule the approved operational restore.

## Data safety

- Never edit operational SQLite files manually.
- Never upload cartridge binaries into SQLite.
- Keep `/data/canonical` and backup destinations on separate durable storage.
- Preserve the publication journal until recovery is complete.
- Rotate sessions, bearer tokens and secret registries through supported APIs.

## Troubleshooting

1. Check `/health` and `/ready`.
2. Inspect the backend logs for the request ID.
3. Verify the exact frontend/API origins and reverse-proxy WebSocket route.
4. Check filesystem ownership and the canonical storage readiness marker.
5. Do not expose cookies, tokens, provider assertions or secret material in
   issue reports.
