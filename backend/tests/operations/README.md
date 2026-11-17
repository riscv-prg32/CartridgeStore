# M6.3b SQLite capacity experiments

The M6.3b harness creates all databases below the operating system temporary
directory and deletes them after each run. It never reads the configured
database, the Docker volumes, or production data.

Run it with Node 24 and pnpm:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
pnpm capacity:check --workloads=small,medium,large > /tmp/prg32-m63b-result.json
```

The workload tiers are deterministic:

| Tier | Scores | Runs | Samples | Downloads |
| --- | ---: | ---: | ---: | ---: |
| small | 1,000 | 100 | 10,000 | 1,000 |
| medium | 10,000 | 1,000 | 100,000 | 10,000 |
| large | 100,000 | 10,000 | 1,000,000 | 100,000 |

The command reports SQLite-only, Fastify injection, and service-layer timings,
query plans, main/WAL/SHM sizes, checkpoint behavior, concurrent reader/writer
behavior, a supported SQLite backup, and process-local score-rate-limiter
behavior. It is an experiment tool, not an operational monitoring command.
