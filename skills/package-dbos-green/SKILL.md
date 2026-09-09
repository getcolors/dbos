---
name: package-dbos-green
description: Provisions a single-machine DBOS TypeScript durable-workflow service with colocated PostgreSQL using colors-compute. Use for build, dry-run, deployment, acceptance, recovery, upgrade, or authorized deletion.
license: MIT
---

# DBOS with Green

Operate one production-oriented DBOS deployment from non-secret `colors.yml`.
The package calls colors-compute directly for a host on Azure, AWS, Google,
DigitalOcean, Hetzner, Vultr, Yandex or OCI, with state in R2 or S3. The
library owns compute validation, resources and machine keys. The package
owns its SSH alias play and reuses ONCE for Cloudflare DNS and the application.
PostgreSQL remains private and backups remain independent of compute.

## Safety

- Read [references/configuration.md](references/configuration.md) first.
- Keep secrets in gitignored `.envrc.private` as `COLORS_PAR_*` variables.
- Never set `COLORS_PAR_PROFILE`, edit `.colors/`, or expose PostgreSQL.
- Keep `compute-prevent-destroy: true`; deletion requires separate authorization.
- Run `build`, dry-run, tests, golden, and launcher checks before real create.
- A real create refuses a hand-written `Host <profile>` stanza in
  `~/.ssh/config`, a key on disk with no state, or an account key of the
  profile's name it does not own; each message names the recovery. Do not
  work around them.
- `delete` reads the compute state first and fails closed when the backend
  cannot be read; a state recorded by another provider is refused.

```sh
./green build
./green create --dry-run
./green create
.agents/skills/package-dbos-green/scripts/acceptance.sh
```

The acceptance script intentionally reboots the configured host through its SSH alias and therefore
must run only under real-deployment authorization.

Provider additions require only a colors-compute version bump. A legacy
`tofu-compute.tfstate` requires explicit migration before the new lifecycle can
create resources. Compute no-infra and local state are unsupported. Build and
dry-run do not generate keys or inspect live compute state.
