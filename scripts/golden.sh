#!/usr/bin/env bash
set -euo pipefail

# Green's regression net against the committed goldens: render every fixture
# and diff against committed output. scripts/parity.sh is the net across
# colours.
#
# Two fixtures, one per keypair mode of the SSH Keypair Standard, because a
# package conforms only if both hold. `colors.yml` (profile `dbos-fixture`) is
# opt-out mode: it supplies an explicit account key id and a name equal to the
# profile, and it is the shape of the live dbos-digitalocean deployment, so a
# change there is a plan against its state. `keygen.yml`
# (`dbos-keygen-fixture`) carries no `digitalocean-ssh-keys` and no
# `digitalocean-name`: the compute template must declare the profile-named key
# resource and reference it by attribute.
#
# Keygen paths are rendered from a fixed placeholder home on :build, never from
# $HOME, so these goldens mean the same thing on every workstation.
#
#   ./scripts/golden.sh            check
#   ./scripts/golden.sh --accept   regenerate after an intended change

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

accept=0
[[ ${1:-} == --accept ]] && accept=1

status=0
for variant in colors keygen; do
  fixture="$root/test/fixtures/$variant.yml"
  (cd "$root/green" && DBOS_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/work" \
    ./green build -f "$fixture" >/dev/null)

  profile=$(sed -n 's/^profile: //p' "$fixture")
  actual="$tmp/work/$profile"
  golden="$root/test/resources/golden/$profile"
  main="$actual/tofu-compute/main.tf"

  # No rendered artefact may carry a real secret into a committed golden.
  # Checked before --accept copies anything.
  if grep -rEq 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_|ghp_' "$actual"; then
    echo "golden: a credential-shaped value was rendered for $profile" >&2; exit 1
  fi
  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$actual"; then
    echo "golden: $profile rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # Compute Provider Standard §4: build renders the documentation address,
  # never the pre-standard fallback, and ONCE's remote stage sees it through
  # the :once/compute-params bridge.
  if grep -rq '192\.168\.0\.1' "$actual"; then
    echo "golden: $profile rendered the pre-standard fallback address" >&2; exit 1
  fi
  grep -q '"ansible_host" : "192.0.2.10"' "$actual/ansible-remote/inventory.json" ||
    { echo "golden: $profile remote inventory does not carry the documentation address" >&2; exit 1; }
  # SSH Config Standard §7: the local play is this package's own, rendered
  # into its own stage; ONCE's shared `ansible-local` stage is no longer
  # rendered at all.
  if [[ -d "$actual/ansible-local" ]]; then
    echo "golden: $profile rendered ONCE's shared ansible-local stage" >&2; exit 1
  fi
  [[ -f "$actual/dbos-ansible-local/main.yml" ]] ||
    { echo "golden: $profile rendered no dbos-ansible-local stage" >&2; exit 1; }
  # SSH Config Standard §6: the local stage takes the address, the user and the
  # alias as Ansible extra-vars, never through Selmer, so its rendered playbook
  # carries no address at all.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$actual/dbos-ansible-local"; then
    echo "golden: $profile rendered an address into the local ssh_config stage" >&2; exit 1
  fi
  # SSH Keypair Standard §4.3: in keygen mode the template declares the
  # profile-named account key and references it by attribute, never by a
  # literal id; in opt-out mode it creates nothing and keeps the literal.
  if [[ $variant == keygen ]]; then
    grep -q 'resource "digitalocean_ssh_key" "machine"' "$main" ||
      { echo "golden: $profile (keygen) declares no DigitalOcean key resource" >&2; exit 1; }
    grep -q "name *= \"$profile\"" "$main" ||
      { echo "golden: $profile (keygen) key resource is not named after the profile" >&2; exit 1; }
    grep -q 'ssh_keys = \[digitalocean_ssh_key\.machine\.id\]' "$main" ||
      { echo "golden: $profile (keygen) machine does not reference the key by attribute" >&2; exit 1; }
    grep -q 'ssh_key_id = digitalocean_ssh_key.machine.id' "$main" ||
      { echo "golden: $profile (keygen) params carry no ssh_key_id" >&2; exit 1; }
  else
    if grep -q '_ssh_key" "machine"' "$main"; then
      echo "golden: $profile (opt-out) must not declare a key resource" >&2; exit 1
    fi
    grep -Eq 'ssh_keys = \["[^"]+"\]' "$main" ||
      { echo "golden: $profile (opt-out) must keep the literal key id" >&2; exit 1; }
    if grep -q 'ssh_key_id = ' "$main"; then
      echo "golden: $profile (opt-out) params must carry no ssh_key_id" >&2; exit 1
    fi
  fi

  if [[ $accept == 1 ]]; then
    rm -rf "$golden"; mkdir -p "$(dirname "$golden")"; cp -a "$actual" "$golden"; continue
  fi
  [[ -d "$golden" ]] || { echo "golden missing for $profile; inspect a build before accepting" >&2; exit 1; }
  diff -ru "$golden" "$actual" || status=1
done

if [[ $accept == 1 ]]; then echo 'golden: accepted inspected output'; exit 0; fi
[[ $status == 0 ]] && echo 'golden: rendered stages match'
exit "$status"
