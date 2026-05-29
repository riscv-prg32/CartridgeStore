# Docker Deployment

Docker deployment runs the web catalog, score API, metrics receiver, and
multiplayer WebSocket relay as one service.

## Quick Start

```bash
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

This keeps uploaded cartridges, the catalog index, scores, and metrics outside
the container image.

## Build Only

```bash
docker build -t prg32-cartrige-store:local .
```

Run the image manually:

```bash
docker run --rm \
  -p 5080:5080 \
  -v "$PWD/data:/data" \
  -e PRG32_STORE_DATA=/data \
  -e PRG32_STORE_DB=/data/cartrige_store.sqlite \
  prg32-cartrige-store:local
```

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
