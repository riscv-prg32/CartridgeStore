# Operations

This page collects day-to-day operational notes for running PRG32 Cartrige
Store in a lab or classroom.

## Backups

Back up the configured data directory. With Docker Compose, that is:

```text
./data
```

It contains cartridge files, `index.json`, scores, and metrics.

To create a simple archive:

```bash
tar -czf cartrige-store-data.tgz data
```

## Restore

Stop the service:

```bash
docker compose down
```

Restore the data directory, then start again:

```bash
tar -xzf cartrige-store-data.tgz
docker compose up -d
```

## Health Check

```bash
curl http://127.0.0.1:5080/.well-known/prg32-store.json
curl http://127.0.0.1:5080/api/multiplayer/status
```

The container health check uses the discovery document.

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

## Data Reset

During class, prefer deleting only the records you intend to reset. For a full
reset of all service data:

```bash
docker compose down
rm -rf data
docker compose up -d
```

This removes uploaded cartridges, score records, and metrics runs.
