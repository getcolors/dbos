# CLAUDE.md

## Repository

`dbos` is a tri-colour Package Skill (green, red, blue) for a
production-oriented single-machine DBOS deployment. It provisions a
DigitalOcean Droplet in the configured region, looks up that region's default
VPC at runtime, generates and owns the machine keypair unless desired state
opts out, writes a managed `~/.ssh/config` block, manages Cloudflare DNS,
installs ONCE, and runs the pinned DBOS TypeScript reference API with
colocated PostgreSQL. The public image is `ghcr.io/getcolors/dbos:4.25.14`.

Desired state is `colors.yml`; secrets are `COLORS_PAR_*` environment values.
Never read `.envrc.private`, set `COLORS_PAR_PROFILE`, edit `.colors/`, weaken
`compute-prevent-destroy`, or expose PostgreSQL and internal DBOS interfaces.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Each colour has five namespaces: `validate` (the
registry, the spec, the retired keys and the package's own checks), `ssh`
(the keypair, wrapping ONCE's), `ssh-config` (the `~/.ssh/config` block's
alias, markers and the two local refusals — this package's own, not ONCE's),
`tools` (the stages and the bridge to ONCE's) and `workflow` (the graph and
`start-step`); red also carries `once.ts`, the path-resolution shim for ONCE's
unexported `ssh.ts`. The templates live under
`tools/infrastructure/digitalocean/main.tf` (the compute stage) and
`tools/ansible-local/` (the three-file local stage that writes the
`~/.ssh/config` block). Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`, which renders
both fixtures through every colour and diffs the trees — and the colour
template trees (`red/resources`, blue's embedded `resources/`) — byte for
byte. The fixtures and the goldens are shared across colours at the repository
root — `test/fixtures/` and `test/resources/golden/` — with
`green/test/fixtures` and `green/test/resources` symlinks pointing at them.
Each colour dir holds a launcher symlink to its skill payload (`green/green`,
`red/red`, `blue/blue`).

```sh
cd green && bb test                # 88 tests
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck   # 77 tests
cd blue && uv run pytest                  # 88 tests
./scripts/parity.sh            # three colours, two keypair modes, byte for byte
./scripts/launcher.sh          # from the repository root
npm --prefix application run typecheck
npm --prefix application run build
npm --prefix application test
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
./scripts/acceptance.sh        # reboots the benchmark Droplet; needs the live host
```

Inspect golden changes before `bb golden:accept`. The acceptance script incurs
a real reboot and requires the existing deployment authorization; it is not
offline-runnable.

## The ONCE-composed shape, and the `:once/compute-params` bridge

Unlike every other delegating package, dbos does not own its DNS and remote
stages: it composes them from ONCE's `tools` namespace (`tofu-dns-step`,
`ansible-remote-step` in green; red and blue assemble the remote stage from
ONCE's exported pieces, see below). Those ONCE steps read the machine's
address, user and name from `:once/compute-params`, the key ONCE's own compute
step sets. This package's compute step therefore sets that key from the same
params it merges at top level — the real output on a converge, ONCE's
`fallback-params` (the documentation address `192.0.2.10`) on a build, and, on
a real delete, the params `adopt-state` read from the compute state — so the
ONCE stages keep working unchanged. `tools/with-compute-params` is the one
place that bridge is made. Before the standard the delete path read no state
at all, so ONCE's remote stage rendered its cleanup against a fallback
address; now a delete adopts the recorded address into both places and fails
closed when the backend cannot be read.

**The stage directories keep ONCE's names.** `tofu-compute` keys the remote
state (`<profile>/tofu-compute.tfstate` through `backend-advice`) and
`tofu-dns` is what the live deployment knows; renaming either would orphan a
tfstate. The Compute Provider Standard constrains the template's *source*
path, so the template moved to `tools/infrastructure/digitalocean/main.tf`
while `(def compute-tool "tofu-compute")` keeps the rendered target where it
was. The local stage is this package's own and is named after it,
`dbos-ansible-local`; ONCE's shared `ansible-local` stage is no longer
rendered.

## The Compute Provider Standard, and what is delegated

The package conforms to the workspace Compute Provider Standard
(`workspace/standards/compute-provider.md`) by **delegation**: the operations
— the `:provider-compute must be one of digitalocean` refusal, the required
keys, secrets and OpenTofu environment of the selected entry, the CIDR
grammar and the source rules, the per-provider checks (the DigitalOcean name
rule and the two VPC refusals, which replaced this package's own combined
message), the provider-switch and legacy-state refusals, the one up-front
state read, `fallback-params`, `resolved-compute` and `adopt-state` — live in
ONCE's `compute` namespace, called with `validate/spec`. What stays here is
the data and the wiring: the one-entry registry, the default provider, the
`:sources` map, the template, `state-output`, `start-step`, the bridge and
the graph. The three-colour matrix of those operations is tested in ONCE;
this package's tests keep one wiring test per safety boundary and one
spec-content test per colour.

**The spec default is `digitalocean`**, the only provider the package ever
offered: the `dbos-digitalocean` state in R2 may hold a `params` written
before this package recorded `provider`, and the default is what such a
legacy state is taken to be. No live droplet exists, so the golden was free
to change by more than the provider line (below).

The credential check runs on delete too, per §4, but the thunk handed to
ONCE's `provider-validator` carries the event: a delete demands the
infrastructure credentials (DigitalOcean, Cloudflare, the backend), a create
the application secrets as well. ONCE's remote stage only renders on delete,
so the secrets Ansible would look up at play time are never needed there.

## The two sibling standards

**Keygen.** `ssh` wraps ONCE's `ssh` (the SSH Keypair Standard's reference
implementation) with a build-time placeholder home, as `rybbit` does:
`digitalocean-ssh-keys` absent means the deployment generates and owns
`~/.ssh/<profile>`, registers it as `digitalocean_ssh_key.machine` named after
the profile, names it in the Droplet's `remote-exec` connection and in ONCE's
remote inventory, and removes it strictly **after** the compute destroy
(`:dbos/ssh-cleanup`); present means opt-out, the literal id passes through,
and the `remote-exec` connection relies on the operator's agent. The old key
model — an account key belonging to a *different* deployment looked up by
name — is gone, its three keys retired (below).

**The `~/.ssh/config` block.** The package conforms to the SSH Config
Standard by copying its reference implementation, `rybbit`'s copy of
`clickstack`'s, and it was born conforming: the marker is
`# BEGIN <profile> ANSIBLE MANAGED BLOCK` with no package prefix, so
`owned-markers` is a one-element set and no migration window exists. The play
is **this package's own copy**, deliberately not ONCE's, which is the opposite
choice from `ssh` above and the reason the old `ansible-local` stage went:
that stage rendered ONCE's shared play through `once-tools/ansible-local-step`,
which §7 forbids, and the ONCE pin bump this change rode on proved why — the
shared play gained an `identity_block` line and would have rewritten the
operator's `~/.ssh/config` at pin-bump time. Address, user, alias and
`block_state` arrive as **Ansible extra-vars, never through Selmer**, so the
rendered play carries no address; the one Selmer conditional is the
`IdentityFile`/`IdentitiesOnly` pair, keygen mode only. Create writes the
block after compute and before DNS (`:dbos/compute → :dbos/ssh-config →
:dbos/dns`); delete removes it *before* the destroy, the reverse of the
keypair, and the two orders must not be tidied into agreement. Two local
checks run on a real create only — never on `build` or `--dry-run` — and
refuse by design: a `Host <profile>` stanza outside the markers, and an option
above the first `Host` line. Both messages name the recovery; neither is a
bug to work around. `workspace/scripts/package-copies.py` keeps this copy in
step with every sibling's.

## The two-fixture golden and parity axis, and the six hunks

`test/fixtures/colors.yml` (profile `dbos-fixture`) is opt-out mode and the
shape of the live `dbos-digitalocean` desired state: an explicit
`digitalocean-ssh-keys`, a `digitalocean-name` equal to the profile, and the
retired keys the deployment still carries. `test/fixtures/keygen.yml`
(`dbos-keygen-fixture`) carries none of those. One golden per profile lives
under `test/resources/golden/`. Adopting the standards changed the opt-out
golden by exactly six hunks, and a seventh change would be a plan against the
deployment's state:

- **(a) the key model** — `data "digitalocean_ssh_key" "operator"` looked up
  by `digitalocean-ssh-key-name` became `ssh_keys = ["<literal id>"]` in
  opt-out and `digitalocean_ssh_key.machine` in keygen; the `remote-exec`
  connection's `private_key = file(pathexpand(...))` became keygen-only, in
  `clickstack`'s unpadded block shape.
- **(b) the fallback address** — `192.168.0.1` became the documentation
  address `192.0.2.10`, visible in `ansible-remote/inventory.json` and
  `tofu-dns/apps.tf.json`; `scripts/golden.sh` fails on the old one anywhere.
- **(c)** `provider = "digitalocean"` in `params`.
- **(d) the HTTP rules** — 443 is sourced from `digitalocean-http-sources`
  (the fixture and the deployment set both lists equal, so no rendered byte
  moved for that), and the 80/443 rules became one `dynamic "inbound_rule"`
  block guarded on a non-empty list, TCP only, in `rybbit`'s shape.
- **(e) the local stage** — ONCE's `ansible-local/` tree disappeared and
  `dbos-ansible-local/` appeared.
- **(f)** validator-only: `digitalocean-vpc-mode` retired and the VPC
  refusals are ONCE's; no rendered byte.

`digitalocean_droplet.node1`, `digitalocean_firewall.node1`, the un-suffixed
firewall name, the `lifecycle.postcondition` on the default VPC, the
`region =` VPC lookup and the extra `params.vpc_uuid` output are all
untouched. **The firewall carries no `prevent_destroy`**: adding one would be
a lifecycle change on a resource the deployment's state may hold, so it is a
documented gap rather than a seventh hunk. `scripts/golden.sh` renders both
fixtures and asserts, on each, the keypair standard (a keygen tree declares
the profile-named key resource and references it by attribute; an opt-out
tree creates none and keeps the literal id), no `$HOME/.ssh`, no dotted quad
under `dbos-ansible-local`, no `192.168.0.1` anywhere, the documentation
address in the remote inventory, and no `ansible-local/` directory.

## Retired keys

`digitalocean-ssh-key-name`, `digitalocean-ssh-private-key`,
`digitalocean-ssh-authorized-keys`, `digitalocean-https-sources` and
`digitalocean-vpc-mode` are accepted and ignored — never required, never
refused — so `dbos-digitalocean/colors.yml` keeps validating unchanged.
`validate/retired-keys` names them; `references/configuration.md` says what
replaced each.

## The ansible-remote divergence

The DNS stage and, in green, the remote stage reuse ONCE conventions directly
(`io.github.getcolors.once.tools`). Red and blue assemble the remote stage
from ONCE's exported pieces (templates, inventory, deploy keys) with green's
`select-keys` semantics for the smtp map: ONCE at the pin still materialises
all four smtp keys in its once.yml, so a desired state that sets no SMTP
password — this package's, whose relay is the loopback placeholder — would
render `smtp_password: null` there. `scripts/parity.sh` and the committed
goldens are the proof.

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at the
**same rev** (`38e3cd6`) — ONCE's own parity is what guarantees its colours
agree per commit. The green pin (`3f33f5d`) is a floor coupled to that ONCE
rev: ONCE 38e3cd6 trusts the SDK's step error alone when it reads state, and
green 3f33f5d is where the SDK reports a tofu launch failure (a missing stage
directory or binary) as that step error, the way red and blue always did; an
older green under this ONCE would crash a fresh-clone create instead of
reporting its credentials, so the two pins move together. ONCE supplies the
backend provider registry, the `compute` namespace, the `ssh` namespace and
the composed DNS and remote stages. `blue/pyproject.toml` keeps its
`[tool.uv] override-dependencies` block, now redundant because
`package-once-blue` at `38e3cd6` pins the same Blue rev, because it is
harmless and would make this package's Blue pin win again were ONCE ever to
pin an older one.

Use `DBOS_LIB_ROOT` (the repository root, for every colour; red also accepts
the `red/` dir directly), `GREEN_LIB_ROOT`, and `ONCE_LIB_ROOT` for
working-tree development. Final launchers use a pushed SHA managed by `bb pin`
(in `green/`), which stamps all three payloads from their unpinned birth forms;
deployment launchers are copies, not symlinks.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
