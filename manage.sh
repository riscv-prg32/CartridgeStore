#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -s "${HOME}/.nvm/nvm.sh" ]; then
  # Keep local invocations on the repository's supported Node.js LTS without
  # changing the caller's parent shell.
  . "${HOME}/.nvm/nvm.sh"
  nvm use 24 >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Error [3]: Node.js 24 is required. Run: source "$HOME/.nvm/nvm.sh" && nvm use 24' >&2
  exit 3
fi

exec node "$script_dir/scripts/manage.mjs" -- "$@"
