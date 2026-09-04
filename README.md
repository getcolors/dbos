# dbos

A tri-colour Package Skill (green, red, blue) for DBOS durable workflows on one
DigitalOcean Droplet.
The deployment embeds `@dbos-inc/dbos-sdk` **4.25.14** in a TypeScript HTTP API,
runs PostgreSQL 17 on the same machine, publishes only HTTPS through ONCE and
Cloudflare, and writes daily PostgreSQL backups to Cloudflare R2.

Version discovery was performed on **2026-08-15**. The npm stable tag resolved
to `4.25.14`; the corresponding stable release line is
[`v4.25`](https://github.com/dbos-inc/dbos-transact-ts/releases/tag/v4.25).
The package is pinned exactly and does not use the `4.26.x-preview` line.

## Architecture and sizing

The compute provider is DigitalOcean, the one entry in the package's provider
registry (`provider-compute: digitalocean`, per the workspace Compute Provider
Standard). OpenTofu retrieves the configured region's default VPC with the
official `digitalocean_vpc` data source, then creates one Droplet and its
firewall; in keygen mode it also registers the deployment's own machine key
as an account key named after the profile. It never creates a VPC and desired
state contains no VPC UUID. ONCE installs Docker and Caddy and runs one
application container. Inside that container PostgreSQL binds only to loopback
and DBOS runs as a library in the Node API. Cloudflare receives one apex A
record. Ports 80/443 and restricted SSH are the only firewall ingress.

The benchmark chooses `s-4vcpu-8gb` (4 shared vCPUs, 8 GiB RAM). This leaves
headroom for PostgreSQL, Node, Docker/Caddy, image replacement, and concurrent
acceptance checks. DBOS recommends at least five system-database connections;
the deployment configures ten. It is intentionally single-node: a Droplet or
region outage causes downtime and there is no automatic failover.

## API

```text
GET  /health
POST /workflows  {"workflowID":"caller-id","input":"value","delaySeconds":60}
GET  /workflows/:workflowID
```

A workflow durably sleeps, then runs a retryable step. The step intentionally
fails its first attempt after durably recording it in PostgreSQL and succeeds on
the second. Its final SHA-256 result is deterministic over
`workflowID + ":" + input`. Reusing an ID safely returns the existing DBOS
execution and is reported as a duplicate.

## Lifecycle and acceptance

```sh
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create
./scripts/acceptance.sh
```

The same verbs run through the other two colours (`red/red`, `blue/blue`);
`scripts/parity.sh` proves the three render byte-identical artifacts for both
keypair modes. Build and dry-run require no credentials and never read
`~/.ssh`. The acceptance script checks HTTPS, completion, exactly two activity
attempts, duplicate-ID behavior and the result hash. It then starts a workflow
in its durable delay, reboots the entire Droplet with `doctl`, waits for HTTPS
recovery, and verifies status and result.

Services are reconciled by ONCE. A real `create` writes a managed
`Host <profile>` block into `~/.ssh/config` (the SSH Config Standard), so the
profile is the alias and no address, user or identity file has to be
remembered:

```sh
ssh dbos-digitalocean 'docker ps'
ssh dbos-digitalocean 'docker logs --tail 200 $(docker ps -q --filter label=host=bigconfig.space)'
ssh dbos-digitalocean 'journalctl -u docker -u caddy --since=-1h'
```

The machine keypair follows the SSH Keypair Standard: with no
`digitalocean-ssh-keys` in `colors.yml` the first real `create` generates
`~/.ssh/<profile>` and registers it at DigitalOcean under the profile's name;
an explicit key id opts out. See the configuration reference for the two
layouts of `~/.ssh/config` that make a create refuse by design.

## Backups and restoration

The container runs `pg_dump --format=custom` daily and uploads over HTTPS to the
configured R2 bucket/prefix, deleting objects older than the desired retention.
The local timestamp `/storage/.last-backup` is an operational indicator, not a
substitute for checking R2. Backups do not include OpenTofu state, which remains
separately isolated by `<profile>/<stage>.tfstate` keys.

Test restoration on an isolated replacement deployment, never over the live
database: download a selected dump, stop application traffic, create an empty
PostgreSQL database, and run `pg_restore --clean --if-exists --no-owner`. Verify
`dbos.workflow_status`, `activity_attempts`, `/health`, and a retrieved completed
workflow before changing DNS. R2 availability, credential loss, a corrupted
backup, and backups taken during undiscovered logical corruption remain disaster
recovery limitations; periodically perform a real isolated restore.

## Upgrades

Update the exact DBOS version, source URL and discovery date together. Read DBOS
release notes and the workflow-upgrade manual. Minor versions follow semantic
versioning, but changes to workflow step order require DBOS patching or versioned
blue/green draining. Build and test the image, inspect golden output, deploy,
and verify old pending workflows before retiring old code. PostgreSQL major
upgrades require a tested dump/restore or `pg_upgrade` procedure and a rollback
backup.

## Credentials and safety

Credentials are supplied only as `COLORS_PAR_*` variables from a gitignored
`.envrc.private`; never place them in desired state or logs. Never export
`COLORS_PAR_PROFILE`. `.colors/` is generated. Keep
`compute-prevent-destroy: true`; deletion needs separate authorization and the
one-run `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` override. Deleting compute
does not authorize deleting R2 backups, the default VPC, or unrelated DNS.
