---
name: package-dbos-green
description: Provisions a single-machine DBOS TypeScript durable-workflow service with colocated PostgreSQL on DigitalOcean. Use for build, dry-run, deployment, acceptance, recovery, upgrade, or authorized deletion.
license: MIT
---

# DBOS with Green

Operate one production-oriented DBOS deployment from non-secret `colors.yml`.
The package discovers the configured region's default DigitalOcean VPC, creates
one protected Droplet, manages Cloudflare DNS and ONCE HTTPS, and deploys the
pinned DBOS reference API with private PostgreSQL and R2 backups.

## Safety

- Read [references/configuration.md](references/configuration.md) first.
- Keep secrets in gitignored `.envrc.private` as `COLORS_PAR_*` variables.
- Never set `COLORS_PAR_PROFILE`, edit `.colors/`, or expose PostgreSQL.
- Keep `compute-prevent-destroy: true`; deletion requires separate authorization.
- Run `build`, dry-run, tests, golden, and launcher checks before real create.
- Never create/delete a VPC or copy a discovered VPC UUID into desired state.

```sh
./green build
./green create --dry-run
./green create
./scripts/acceptance.sh
```

The acceptance script intentionally reboots the benchmark Droplet and therefore
must run only under real-deployment authorization.
