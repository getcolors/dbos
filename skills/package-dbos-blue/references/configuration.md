# Configuration

`colors.yml` is the only editable desired-state file. Core keys select the
profile, workdir, DigitalOcean/Cloudflare/R2 providers and protected lifecycle.
The package supports one compute provider, DigitalOcean, selected by
`provider-compute: digitalocean`; any other value is refused with the
advertised list.

DBOS keys pin the public hostname, image and exact SDK version; configure the
durable delay, retry attempts/backoff, retention and system database pool.
PostgreSQL keys select its major version, private data path and database. Backup
keys select an existing R2 bucket/endpoint/prefix, daily schedule and retention.
Cloudflare manages the apex hostname.

## Credentials

Every real `create` requires these private environment variables:

```text
COLORS_PAR_DO_TOKEN
COLORS_PAR_CLOUDFLARE_API_TOKEN
COLORS_PAR_R2_ACCESS_KEY_ID
COLORS_PAR_R2_SECRET_ACCESS_KEY
COLORS_PAR_DBOS_POSTGRES_PASSWORD
COLORS_PAR_POSTGRES_BACKUP_R2_ACCESS_KEY_ID
COLORS_PAR_POSTGRES_BACKUP_R2_SECRET_ACCESS_KEY
```

A real `delete` requires the first four alone: the DigitalOcean token, the
Cloudflare token and the state backend's keys. The last three are looked up
by Ansible on the host, and a delete never runs that play.

Never set `COLORS_PAR_PROFILE`. Keep `compute-prevent-destroy: true` in committed
desired state and do not delete backup objects with compute.

## DigitalOcean (`provider-compute: digitalocean`)

| Key | Required | Meaning |
|---|---|---|
| `digitalocean-region` | yes | Droplet region, e.g. `ams3` |
| `digitalocean-size` | yes | Droplet size, e.g. `s-4vcpu-8gb` |
| `digitalocean-image` | yes | Image slug, `ubuntu-24-04-x64` |
| `digitalocean-ssh-sources` | yes | CIDRs admitted to TCP 22 |
| `digitalocean-http-sources` | yes | CIDRs admitted to TCP 80 and 443 |
| `digitalocean-name` | no | Droplet and firewall name; the profile by default |
| `digitalocean-ssh-keys` | no | An existing account key id; absent means keygen mode |

No VPC UUID or CIDR is accepted: the package looks up the configured region's
default VPC at runtime, verifies it is DigitalOcean's default, and never
creates a VPC.

### Firewall sources

`digitalocean-ssh-sources` must list at least one CIDR, and every entry of
both source keys must be a syntactically valid IPv4 or IPv6 CIDR; both are
checked before any provider call. An empty `digitalocean-http-sources` is
allowed and means no public HTTP. The provider firewall admits 22, 80 and 443
from those sources and nothing else; the plays manage no guest firewall for
them.

### The machine keypair

When `digitalocean-ssh-keys` is absent (keygen mode, the default), the first
real `create` generates an ed25519 keypair at `~/.ssh/<profile>` and registers
it as an account key named after the profile; `delete` removes the local
keypair after the machine is destroyed. The key is not generated output: it
survives regeneration of `.colors/`, and a fresh clone on another workstation
does not carry it. A key on disk with no matching state, or an account key of
that name this deployment does not own, refuses the create rather than being
overwritten or adopted. Set `digitalocean-ssh-keys` to an existing account key
id to opt out; the package then creates and deletes no key material, and the
Droplet's `remote-exec` wait for cloud-init relies on the operator's SSH agent
holding that key.

### The `~/.ssh/config` block

A real `create` writes one managed block into `~/.ssh/config`, after the
machine exists and before it is converged, so `ssh <profile>` needs no
address, no user and no `-i` flag:

```sshconfig
# BEGIN <profile> ANSIBLE MANAGED BLOCK
Host <profile>
    HostName <ip>
    User root
    Port 22
    IdentityFile ~/.ssh/<profile>      # keygen mode only
    IdentitiesOnly yes                 # keygen mode only
    StrictHostKeyChecking accept-new
    ForwardAgent no
# END <profile> ANSIBLE MANAGED BLOCK
```

The alias is the profile; there is no separate key for it. The `IdentityFile`
pair appears only in keygen mode, where the package knows the key because it
generated it; with `digitalocean-ssh-keys` set the operator's own arrangements
find the key. `delete` removes the block before the machine is destroyed (the
keypair, by contrast, goes after it). `build` and `--dry-run` never read the
file.

The block is inserted at the top of the file, because `ssh_config` takes the
first value it obtains and a `Host *` stanza above it would win on `User` and
`IdentityFile`. Two layouts make a real create refuse rather than rewrite the
file, each naming the file and the line: a `Host <profile>` stanza outside
the markers (remove or rename it if it is stale, or change `profile` if it
belongs to something else — the package never overwrites it), and an option
standing above the first `Host` or `Match` line, which is global today and
would be captured into this one stanza (move it below the managed block, or
into an explicit `Host *` stanza at the end of the file).

### Provider state

Every real `create` and `delete` reads the compute state before validating
the provider credentials. A state recorded by another provider is refused on
both events, because switching is a rebuild; a state recorded before this
package wrote `params.provider` is treated as DigitalOcean's, the only
provider it ever offered. An unreadable backend counts as no state on a
create (a fresh clone has none) and fails a delete closed.

### Retired keys

These keys were read by this package before it adopted the workspace
standards. They are accepted and ignored — never required, never refused —
so a `colors.yml` written before the adoption keeps validating unchanged:

| Key | Replaced by |
|---|---|
| `digitalocean-ssh-key-name` | `digitalocean-ssh-keys`, an account key id, or its absence (keygen mode). The old model looked up an account key belonging to another deployment by name. |
| `digitalocean-ssh-private-key` | keygen mode names the generated key itself; opt-out mode relies on the SSH agent |
| `digitalocean-ssh-authorized-keys` | nothing read it |
| `digitalocean-https-sources` | `digitalocean-http-sources`, which now admits 80 and 443 |
| `digitalocean-vpc-mode` | nothing; there was only ever one value. `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` are refused instead |

Remove them at leisure; nothing renders from them.
