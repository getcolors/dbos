#!/usr/bin/env bash
set -euo pipefail

# One desired state, three colours, byte for byte. golden.sh is green's
# regression net against the committed golden; this is the net across colours:
# the fixture is rendered by green, red, and blue into separate work
# directories and the trees must be identical — and the template trees each
# colour carries must be identical too, because the copies are the mechanism
# (red/resources and blue's embedded resources are copies of green's tree, not
# references to it).
#
# One fixture, one variant: the golden axis is the four ONCE stages the single
# dbos-fixture renders (tofu-compute, tofu-dns, ansible-local, ansible-remote).
#
# Renders resolve each colour's package from this working tree (the
# DBOS_LIB_ROOT overrides), while green, once, red, and blue stay on their
# pins — a change that lands here passes parity before it is pushed or pinned
# anywhere.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
state="$root/test/fixtures/colors.yml"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

(cd "$root/green" && env DBOS_LIB_ROOT="$root" \
  COLORS_PAR_WORKDIR="$tmp/green" ./green build -f "$state" >/dev/null)
(cd "$root/red" && env DBOS_LIB_ROOT="$root" \
  COLORS_PAR_WORKDIR="$tmp/red" ./red build -f "$state" >/dev/null)
(cd "$root/blue" && env COLORS_PAR_WORKDIR="$tmp/blue" \
  uv run python -m package_dbos_blue build -f "$state" >/dev/null)
diff -r "$tmp/green" "$tmp/red"
diff -r "$tmp/green" "$tmp/blue"

diff -r "$root/green/src/resources/io/github/getcolors/dbos" "$root/red/resources"
diff -r "$root/green/src/resources/io/github/getcolors/dbos" "$root/blue/src/package_dbos_blue/resources"

echo "green, red, and blue DBOS artifacts are byte-identical"
