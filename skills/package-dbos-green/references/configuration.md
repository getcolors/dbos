# Configuration

`colors.yml` contains desired state. Select a library VM provider with
`provider-compute`, and R2 or S3 with `provider-backend`. Supported providers
are azure, aws, google, digitalocean, hcloud, vultr, yandex and oci.

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

Network selection belongs to the library. Public singleton mode uses no owned
private network when the provider supports it. Explicit library network
options are available when the deployment needs them.

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
application preparation stage uses that key through the SSH agent, or an
explicit `ssh-private-key-path`. It waits for SSH and cloud-init in Ansible.

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
belongs to something else. the package never overwrites it), and an option
standing above the first `Host` or `Match` line, which is global today and
would be captured into this one stanza (move it below the managed block, or
into an explicit `Host *` stanza at the end of the file).

### Provider state

The library coordinates shared and per-node remote state. The package loads
recorded node parameters for delete, and refuses missing or unreadable
inventory. The old `<profile>/tofu-compute.tfstate` needs explicit migration.
Changing provider or replacing owned resources requires the library's
explicit lifecycle rules. Build placeholders must never reach a real
application step.

### Retired keys

These keys were read by this package before it adopted the workspace
standards. They are accepted and ignored. never required, never refused —
so a `colors.yml` written before the adoption keeps validating unchanged:

| Key | Replaced by |
|---|---|
| `digitalocean-ssh-key-name` | `digitalocean-ssh-keys`, an account key id, or its absence (keygen mode). The old model looked up an account key belonging to another deployment by name. |
| `digitalocean-ssh-private-key` | keygen mode names the generated key itself; opt-out mode relies on the SSH agent |
| `digitalocean-ssh-authorized-keys` | nothing read it |
| `digitalocean-https-sources` | `digitalocean-http-sources`, which now admits 80 and 443 |
| `digitalocean-vpc-mode` | nothing; there was only ever one value. `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` are refused instead |

Remove them at leisure; nothing renders from them.

## Other providers and backends

Azure uses the ambient Azure CLI session. AWS and S3 use the ambient AWS
credential chain. Google uses Application Default Credentials. OCI uses
`oci-config-file-profile` from `~/.oci/config`. Token providers use
`COLORS_PAR_DO_TOKEN`, `COLORS_PAR_HCLOUD_TOKEN`, `COLORS_PAR_VULTR_API_KEY`
or `COLORS_PAR_YANDEX_TOKEN`. R2 uses the two state credentials listed above;
S3 requires `s3-bucket` and `s3-region` instead of the R2 endpoint and bucket.
Cloudflare credentials remain required for DNS. Application credentials are
required on create only. No GitHub token is needed for the public image.

`compute-ssh-sources` and `compute-http-sources` are provider-neutral source
lists. Existing provider-prefixed source lists remain supported. Explicit
SSH references select external key ownership; omitted references select
managed mode. The package strips its retired public-file option before
calling the library, so it does not change DBOS key ownership.
