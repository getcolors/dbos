# CLAUDE.md

## Repository

`dbos` is a Green-only Package Skill for a production-oriented single-machine
DBOS deployment. It provisions a DigitalOcean Droplet in the configured region,
looks up that region's default VPC at runtime, manages Cloudflare DNS, installs
ONCE, and runs the pinned DBOS TypeScript reference API with colocated
PostgreSQL. The public image is `ghcr.io/getcolors/dbos:4.25.14`.

Desired state is `colors.yml`; secrets are `COLORS_PAR_*` environment values.
Never read `.envrc.private`, set `COLORS_PAR_PROFILE`, edit `.colors/`, weaken
`compute-prevent-destroy`, or expose PostgreSQL and internal DBOS interfaces.

## Commands

```sh
bb test
bb golden
./scripts/launcher.sh
npm --prefix application run typecheck
npm --prefix application run build
npm --prefix application test
./green build
./green create --dry-run
./green create                 # requires explicit authorization
./scripts/acceptance.sh        # reboots the benchmark Droplet
```

Inspect golden changes before `bb golden:accept`. The acceptance script incurs a
real reboot and requires the existing deployment authorization.

## Coupling

The package pins Green and ONCE in `deps.edn`. Develop with `GREEN_LIB_ROOT`,
`ONCE_LIB_ROOT`, and `DBOS_LIB_ROOT`; finalize launchers only with `bb pin` after
a pushed package commit. Deployment launchers are copies, not symlinks.

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
