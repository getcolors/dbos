#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
DBOS_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/work" \
  "$root/green" build -f "$root/test/fixtures/colors.yml" >/dev/null
actual="$tmp/work/dbos-fixture"
golden="$root/test/resources/golden/dbos-fixture"
if grep -rEq 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_|ghp_' "$actual"; then
  echo 'golden: credential-shaped value rendered' >&2; exit 1
fi
if [[ ${1:-} == --accept ]]; then
  rm -rf "$golden"; mkdir -p "$(dirname "$golden")"; cp -a "$actual" "$golden"
  echo 'golden: accepted inspected output'; exit 0
fi
[[ -d "$golden" ]] || { echo 'golden missing; inspect a build before accepting' >&2; exit 1; }
diff -ru "$golden" "$actual"
echo 'golden: rendered ONCE stages match'
