#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-dbos-green/green"
grep -q 'io.github.getcolors.dbos.workflow/workflow' "$launcher"
grep -q 'def \^:private dbos-sha' "$launcher"
grep -q '"package-dbos-red"' "$root/skills/package-dbos-red/red"
grep -q 'package_dbos_blue' "$root/skills/package-dbos-blue/blue"
[[ -L "$root/green/green" ]] && [[ $(readlink "$root/green/green") == ../skills/package-dbos-green/green ]]
[[ -L "$root/red/red" ]] && [[ $(readlink "$root/red/red") == ../skills/package-dbos-red/red ]]
[[ -L "$root/blue/blue" ]] && [[ $(readlink "$root/blue/blue") == ../skills/package-dbos-blue/blue ]]
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp "$launcher" "$tmp/green"; chmod +x "$tmp/green"
cp "$root/test/fixtures/colors.yml" "$tmp/colors.yml"
(cd "$tmp" && DBOS_LIB_ROOT="$root" ./green build >/dev/null)
[[ -f "$tmp/.colors/dbos-fixture/tofu-compute/main.tf" ]]
[[ -f "$tmp/.colors/dbos-fixture/ansible-remote/once.yml" ]]
# The launcher walks up for colors.yml, so any subdirectory works.
mkdir -p "$tmp/a/b"
(cd "$tmp/a/b" && DBOS_LIB_ROOT="$root" ../../green build >/dev/null)
# The profile guard is the whole reason COLORS_PAR_PROFILE is refused: an
# overlay would point one deployment at another's state.
out=$(cd "$tmp" && DBOS_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong ./green build 2>&1 || true)
grep -q COLORS_PAR_PROFILE <<<"$out"
[[ ! -d "$tmp/.colors/wrong" ]]
echo 'launcher: all checks passed'
