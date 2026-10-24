#!/usr/bin/env bash
# Offline syntax check for the three mutually exclusive F3B vhosts.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/wbs-f3b-nginx.XXXXXX")
cleanup() {
  rm -f -- "$test_dir/cert/fullchain.pem" "$test_dir/cert/privkey.pem"
  rmdir -- "$test_dir/cert" "$test_dir"
}
trap cleanup EXIT

mkdir -- "$test_dir/cert"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=messe.klare-ki.de' \
  -keyout "$test_dir/cert/privkey.pem" \
  -out "$test_dir/cert/fullchain.pem" >/dev/null 2>&1

for name in \
  messe.klare-ki.de.bootstrap.conf \
  messe.klare-ki.de.https-holding.conf \
  messe.klare-ki.de.conf
do
  docker run --rm --entrypoint nginx \
    --mount "type=bind,src=$script_dir/$name,dst=/etc/nginx/conf.d/messe.conf,readonly" \
    --mount "type=bind,src=$test_dir/cert,dst=/etc/letsencrypt/live/messe.klare-ki.de,readonly" \
    nginx:1.24 -t >/dev/null
  printf 'PASS %s\n' "$name"
done
