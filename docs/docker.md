# Docker Deployment

Docker deployment runs the web catalog, score API, metrics receiver, and
multiplayer WebSocket relay as one service.

## Quick Start

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
docker compose up --build
```

Open:

```text
http://127.0.0.1:5080/
```

The WebSocket multiplayer URL is:

```text
ws://127.0.0.1:5080/api/multiplayer
```

## Persistent Data

`docker-compose.yml` mounts `./data` on the host to `/data` in the container.
The container uses:

```text
PRG32_STORE_DATA=/data
PRG32_STORE_DB=/data/cartrige_store.sqlite
```

This keeps uploaded cartridges, pending review packages, the catalog index,
scores, and metrics outside the container image.

## Build Only

```bash
docker build -t prg32-cartrige-store:local .
```

Run the image manually:

```bash
docker run --rm \
  -p 5080:5080 \
  -v "$PWD/data:/data" \
  -e SECRET_KEY="$SECRET_KEY" \
  -e PRG32_STORE_DATA=/data \
  -e PRG32_STORE_DB=/data/cartrige_store.sqlite \
  prg32-cartrige-store:local
```

Database users are the primary auth path. The image seeds `admin` / `password`
as an administrator and editor; change that password before real use. New users
register by email verification link. Configure `PRG32_SMTP_HOST` and related
SMTP variables to send those links. Legacy `PRG32_USERS` tokens are still
accepted for API clients, but database users in the `editors` group must verify
pending cartridge packages.

## Classroom LAN Deployment

Find the host computer IP address and point boards to:

```text
http://<host-ip>:5080
ws://<host-ip>:5080/api/multiplayer
```

The discovery document is available at:

```text
http://<host-ip>:5080/.well-known/prg32-store.json
```

The service advertises itself via mDNS as `_http._tcp.local.`. Set
`PRG32_MDNS_DISABLED=1` to turn that off, or `PRG32_MDNS_NAME` to change the
advertised name.

## Maintenance

View logs:

```bash
docker compose logs -f
```

Restart after configuration changes:

```bash
docker compose restart
```

Stop the service while keeping data:

```bash
docker compose down
```

Stop and remove local persistent data:

```bash
docker compose down
rm -rf data
```

Only remove `data` when you intentionally want to delete uploaded cartridges,
scores, and metrics.
