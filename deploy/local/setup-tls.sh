#!/usr/bin/env sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tls_directory=${PRG32_TLS_DIR:-"$repository_root/.local/tls"}
store_domain=${PRG32_STORE_DOMAIN:-store.prg32.test}
api_domain=${PRG32_API_DOMAIN:-api.prg32.test}

if ! command -v mkcert >/dev/null 2>&1; then
  printf '%s\n' "mkcert is required to create trusted local certificates." >&2
  printf '%s\n' "Install it first, then run this script again." >&2
  exit 1
fi

mkdir -p "$tls_directory"
mkcert -install
mkcert \
  -cert-file "$tls_directory/prg32-local.pem" \
  -key-file "$tls_directory/prg32-local-key.pem" \
  "$store_domain" "$api_domain"
chmod 600 "$tls_directory/prg32-local-key.pem"
printf '%s\n' "Local TLS certificate created in $tls_directory"
