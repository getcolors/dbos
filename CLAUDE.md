# CLAUDE.md

## Repository

`dbos` is a tri-colour Package Skill (green, red, blue) for a
production-oriented single-machine DBOS deployment. It provisions a
DigitalOcean Droplet in the configured region, looks up that region's default
VPC at runtime, manages Cloudflare DNS, installs ONCE, and runs the pinned DBOS
TypeScript reference API with colocated PostgreSQL. The public image is
`ghcr.io/getcolors/dbos:4.25.14`.

Desired state is `colors.yml`; secrets are `COLORS_PAR_*` environment values.
Never read `.envrc.private`, set `COLORS_PAR_PROFILE`, edit `.colors/`, weaken
`compute-prevent-destroy`, or expose PostgreSQL and internal DBOS interfaces.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`, which renders
the fixture through every colour and diffs the trees — and the colour template
trees (`red/resources`, blue's embedded `resources/`) — byte for byte. The
fixture and the goldens are shared across colours at the repository root —
`test/fixtures/` and `test/resources/golden/` — with `green/test/fixtures` and
`green/test/resources` symlinks pointing at them. Each colour dir holds a
launcher symlink to its skill payload (`green/green`, `red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, one fixture, byte for byte
./scripts/launcher.sh          # from the repository root
npm --prefix application run typecheck
npm --prefix application run build
npm --prefix application test
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
./scripts/acceptance.sh        # reboots the benchmark Droplet
```

Inspect golden changes before `bb golden:accept`. The acceptance script incurs
a real reboot and requires the existing deployment authorization.

## Reuse surface, and the one deliberate divergence

Two OpenTofu stages and both Ansible stages reuse ONCE conventions in every
colour: green by requiring `io.github.getcolors.once.tools`, red through
`package-once-red`, blue through `package_once_blue`. The ansible-remote stage
is the exception. ONCE at the frozen pin builds its once.yml smtp map with all
four smtp keys materialised, so a desired state that sets no SMTP password —
this package's, whose relay is the loopback placeholder — would render
`smtp_password: null` in red and blue where green's `select-keys` omits the
key. Red and blue therefore assemble that stage from ONCE's exported pieces
(templates, inventory, deploy keys) with green's select-keys semantics;
`scripts/parity.sh` and the committed goldens are the proof.

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at the
**same rev** (`6952711`) — ONCE's own parity is what guarantees its colours
agree per commit. This package deliberately stays on that frozen ONCE pin: a
bump would adopt the SSH-keypair default and churn every golden, and is its own
change. `blue/pyproject.toml` carries a `[tool.uv] override-dependencies`
block because `package-once-blue@6952711` pins an older Blue rev (`369c5aa`);
the override makes this package's Blue pin win.

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
