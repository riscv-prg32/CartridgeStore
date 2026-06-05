# Operations

This page collects day-to-day operational notes for running PRG32 Cartridge
Store in a lab or classroom.

## Backups

Administrators can download a full backup from `/admin/backup`. The ZIP
contains a SQLite snapshot plus filesystem data for settings, users, roles,
groups, cartridges, pending submissions, scores, statistics, measurements, and
metrics.

You can also back up the configured data directory. With Docker Compose, that
is:

```text
./data
```

It contains verified cartridge files, pending review packages, `index.json`,
the SQLite database, scores, and metrics.

To create a simple archive:

```bash
tar -czf cartridge-store-data.tgz data
```

## Restore

Administrators can restore a ZIP created by `/admin/backup` from the same page.
The restore replaces the SQLite database and filesystem data in the configured
data directory.

Stop the service:

```bash
docker compose down
```

Restore the data directory, then start again:

```bash
tar -xzf cartridge-store-data.tgz
docker compose up -d
```

## Health Check

```bash
curl http://127.0.0.1:5080/.well-known/prg32-store.json
curl http://127.0.0.1:5080/api
curl http://127.0.0.1:5080/api/multiplayer/status
```

The container health check uses the discovery document.

## Publishing Workflow

Only authenticated users can upload cartridge packages. Uploads must be zip
bundles and enter the pending review queue. A user in the `editors` group must
verify the submission before it appears in the public catalog.

Editors can change descriptive metadata during review, but cartridge id,
version, and authorship are preserved from the uploaded package.

Use `/editor/submissions` for the browser workflow or `/api/submissions` for
API review.

## User Registration

The service seeds a default `admin` / `password` administrator. Change that
password before real use. New users enter only an email address at
`/auth/register`; the service sends a verification link that lets them set a
password. Their username is the verified email address.

Configure SMTP with `PRG32_SMTP_HOST`, `PRG32_SMTP_PORT`, `PRG32_SMTP_FROM`,
`PRG32_SMTP_USER`, `PRG32_SMTP_PASSWORD`, and `PRG32_SMTP_TLS`. Without SMTP,
registration links are logged for development.

## Administration Pages

- `/setup` controls identity, theme, publishing, mDNS, SMTP, OIDC, and SAML2.
- `/admin/users` manages local and federated user records, roles, passwords,
  and group membership.
- `/admin/groups` manages groups; users can belong to many groups.
- `/admin/roles` shows the fixed role ABI and user counts.
- `/admin/cartridges` lets admins and editors edit descriptive cartridge
  metadata or delete variants/versions.
- `/admin/backup` exports and restores full backups.

## Access Tokens

Database API tokens can upload packages and submit scores. Keep legacy
`PRG32_USERS` tokens with the deployment configuration if you still use them,
and rotate them when a shared classroom token is exposed. Editor verification
uses database users in the `editors` group.

## Logs

```bash
docker compose logs -f
```

For local Python runs, logs are printed to the terminal that started the server.

## Network Checklist

- The host firewall allows TCP port `5080`.
- Boards and laptops are on the same classroom network.
- Firmware score and metrics URLs use `http://<host-ip>:5080`.
- Firmware multiplayer URLs use `ws://<host-ip>:5080/api/multiplayer`.
- The discovery document returns reachable URLs for the client network.
- mDNS advertises `_prg32store._tcp.local.` when `zeroconf` is installed.
- Set `PRG32_MDNS_DISABLED=1` when the classroom network should not advertise.

## Data Reset

During class, prefer deleting only the records you intend to reset. For a full
reset of all service data:

```bash
docker compose down
rm -rf data
docker compose up -d
```

This removes verified cartridges, pending submissions, score records, and
metrics runs.
