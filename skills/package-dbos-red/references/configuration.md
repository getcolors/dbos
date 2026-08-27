# Configuration

`colors.yml` is the only editable desired-state file. Core keys select the
profile, workdir, DigitalOcean/Cloudflare/R2 providers and protected lifecycle.

DBOS keys pin the public hostname, image and exact SDK version; configure the
durable delay, retry attempts/backoff, retention and system database pool.
PostgreSQL keys select its major version, private data path and database. Backup
keys select an existing R2 bucket/endpoint/prefix, daily schedule and retention.
DigitalOcean keys select `ams3`, `s-4vcpu-8gb`, Ubuntu, operator key paths and
firewall CIDRs. `digitalocean-vpc-mode` must be `default`; VPC UUID/CIDR keys are
rejected. Cloudflare manages the apex hostname.

Required credentials:

- `COLORS_PAR_DO_TOKEN`
- `COLORS_PAR_CLOUDFLARE_API_TOKEN`
- `COLORS_PAR_R2_ACCESS_KEY_ID`
- `COLORS_PAR_R2_SECRET_ACCESS_KEY`
- `COLORS_PAR_DBOS_POSTGRES_PASSWORD`
- `COLORS_PAR_POSTGRES_BACKUP_R2_ACCESS_KEY_ID`
- `COLORS_PAR_POSTGRES_BACKUP_R2_SECRET_ACCESS_KEY`

Never set `COLORS_PAR_PROFILE`. Keep `compute-prevent-destroy: true` in committed
desired state and do not delete backup objects with compute.
