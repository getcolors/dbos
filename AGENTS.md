# CLAUDE.md

## Repository

DBOS is a package in Green, Red and Blue for one DBOS TypeScript reference
API with colocated PostgreSQL. Each color calls colors-compute directly for
the host, provider validation, remote state and SSH key ownership. The package
supplies one singleton topology and TCP 22 plus optional TCP 80/443 ingress.
An empty HTTP source list closes public HTTP. PostgreSQL and DBOS internal
interfaces stay private. A provider addition changes the library version only.

Desired state is `colors.yml`. Credentials use `COLORS_PAR_*`. Never read
`.envrc.private`, set `COLORS_PAR_PROFILE`, edit `.colors/`, weaken
`compute-prevent-destroy`, or expose PostgreSQL and internal DBOS interfaces.
User authorization for live operations and publication applies as given.

## Application and lifecycle

The application image is `ghcr.io/getcolors/dbos:4.25.14`, with PostgreSQL 17
and DBOS 4.25.14. ONCE manages DNS and the application host. Red and Blue
retain their application rendering adapter so the absent SMTP password stays
absent, matching Green. All application containers and backup resources are
unchanged by the compute migration.

The compute adapter merges the returned node at top level and stores it in
`once/compute-params`. Real deletes read recorded inventory before any
application or DNS cleanup. Missing or unreadable inventory refuses deletion.
Legacy `<profile>/tofu-compute.tfstate` requires explicit migration. New
compute stages use library shared and node state keys in R2 or S3.

Create runs compute, local SSH configuration, DNS, application preparation,
then remote application configuration. The `dbos-bootstrap` Ansible stage
waits for SSH and cloud-init. It replaces the old compute remote-exec wait.
Delete renders remote cleanup, removes DNS and the SSH alias, then delegates
compute destruction and managed key cleanup to the library.

The package owns its canonical locked SSH configuration play. The alias is
exactly the profile, with the returned address and login. Only managed mode
writes IdentityFile and IdentitiesOnly. Explicit external private key paths
reach Ansible. The library refuses unowned key replacement. Do not recreate
package-owned key generation or provider API routines.

## Compatibility

The default provider is DigitalOcean. These historical DBOS keys remain
ignored and are removed before every library call:
`digitalocean-ssh-key-name`, `digitalocean-ssh-private-key`,
`digitalocean-ssh-authorized-keys`, `digitalocean-https-sources`,
`digitalocean-vpc-mode`. This is deliberate even when the library supports a
similarly named option for another package.

ONCE is an application dependency that accepts the caller's compute version.
Do not call its compute validation or key lifecycle from this package.
Green uses `green/deps.edn`; Red declares dependencies in both package
manifests; Blue uses direct Git dependencies. Standalone launchers resolve
the package's published dependency graph. `bb pin` in `green/` stamps a clean,
pushed source revision. Deployment launchers are copies, not symlinks.

## Validation

Run `bb test` in `green/`, `bun test && bun run typecheck` in `red/`, and
`uv run pytest` in `blue/`. Run `scripts/parity.sh`, `scripts/golden.sh` and
`scripts/launcher.sh` at the root. Inspect golden changes before accepting.
The two fixtures exercise external and managed keys. Recorded node adapters
and the bootstrap inventory also need coverage; byte parity alone cannot
prove a usable runtime address. The SSH probe uses a temporary HOME and real
Ansible, with no operator or cloud state.

The application checks are `npm run typecheck`, `npm run build` and `npm test`
in `application/`. `scripts/acceptance.sh` proves durable execution across a
host reboot through the profile SSH alias. It requires live-deployment
authorization and must not run as an offline test. Set
`DBOS_ACCEPTANCE_SSH_HOST` if the profile differs from `dbos-digitalocean`.

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

A repeated delete whose validated library inspection reports destroyed stops
after start, without key files or repeated cleanup. Credential validation still
runs first. The same inspection status is refused outside delete, and workflow
failure routing remains unchanged.
