#!/bin/sh
set -eu

: "${PRG32_NODE_BIN:?PRG32_NODE_BIN must point to Node.js 24 or the approved Node runtime}"
: "${PRG32_BACKUP_WRAPPER:?PRG32_BACKUP_WRAPPER must point to prg32-backup.mjs}"

exec "$PRG32_NODE_BIN" "$PRG32_BACKUP_WRAPPER" create
