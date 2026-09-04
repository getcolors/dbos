---
name: package-dbos-red
description: Provisions a single-machine DBOS TypeScript durable-workflow service with colocated PostgreSQL on DigitalOcean. Use for build, dry-run, deployment, acceptance, recovery, upgrade, or authorized deletion.
license: MIT
---

# DBOS with Red

Operate one production-oriented DBOS deployment from non-secret `colors.yml`.
The package supports one compute provider, DigitalOcean
(`provider-compute: digitalocean`, credential `COLORS_PAR_DO_TOKEN`). It
discovers the configured region's default DigitalOcean VPC, creates one
protected Droplet and its firewall, generates and owns the machine keypair
`~/.ssh/<profile>` unless `digitalocean-ssh-keys` names an existing account
key, writes a managed `Host <profile>` block into `~/.ssh/config`, manages
Cloudflare DNS and ONCE HTTPS, and deploys the pinned DBOS reference API with
private PostgreSQL and R2 backups.

## Safety

- Read [references/configuration.md](references/configuration.md) first.
- Keep secrets in gitignored `.envrc.private` as `COLORS_PAR_*` variables.
- Never set `COLORS_PAR_PROFILE`, edit `.colors/`, or expose PostgreSQL.
- Keep `compute-prevent-destroy: true`; deletion requires separate authorization.
- Run `build`, dry-run, tests, golden, and launcher checks before real create.
- Never create/delete a VPC or copy a discovered VPC UUID into desired state.
- A real create refuses a hand-written `Host <profile>` stanza in
  `~/.ssh/config`, a key on disk with no state, or an account key of the
  profile's name it does not own; each message names the recovery. Do not
  work around them.
- `delete` reads the compute state first and fails closed when the backend
  cannot be read; a state recorded by another provider is refused.

```sh
./red build
./red create --dry-run
./red create
.agents/skills/package-dbos-red/scripts/acceptance.sh
```

The acceptance script intentionally reboots the benchmark Droplet and therefore
must run only under real-deployment authorization.
