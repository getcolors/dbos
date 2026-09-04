#!/usr/bin/env bash
set -euo pipefail

# One desired state, three colours, byte for byte. golden.sh is green's
# regression net against the committed goldens; this is the net across
# colours: each fixture is rendered by green, red, and blue into separate work
# directories and the trees must be identical — and the template trees each
# colour carries must be identical too, because the copies are the mechanism
# (red/resources and blue's embedded resources are copies of green's tree, not
# references to it).
#
# Two fixtures, one per keypair mode: the SSH Keypair Standard has two modes
# and parity means both keygen and opt-out hold in every colour. The golden
# axis is the stages the fixture renders: ONCE's tofu-compute, tofu-dns and
# ansible-remote, and this package's own dbos-ansible-local.
#
# Renders resolve each colour's package from this working tree (the
# DBOS_LIB_ROOT overrides), while green, once, red, and blue stay on their
# pins — a change that lands here passes parity before it is pushed or pinned
# anywhere.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

build_variant() {
  local variant=$1 state="$root/test/fixtures/$1.yml"
  (cd "$root/green" && env DBOS_LIB_ROOT="$root" \
    COLORS_PAR_WORKDIR="$tmp/$variant/green" ./green build -f "$state" >/dev/null)
  (cd "$root/red" && env DBOS_LIB_ROOT="$root" \
    COLORS_PAR_WORKDIR="$tmp/$variant/red" ./red build -f "$state" >/dev/null)
  (cd "$root/blue" && env COLORS_PAR_WORKDIR="$tmp/$variant/blue" \
    uv run python -m package_dbos_blue build -f "$state" >/dev/null)
  diff -r "$tmp/$variant/green" "$tmp/$variant/red"
  diff -r "$tmp/$variant/green" "$tmp/$variant/blue"
}

build_variant colors
build_variant keygen

diff -r "$root/green/src/resources/io/github/getcolors/dbos" "$root/red/resources"
diff -r "$root/green/src/resources/io/github/getcolors/dbos" "$root/blue/src/package_dbos_blue/resources"

echo "green, red, and blue DBOS artifacts are byte-identical"
