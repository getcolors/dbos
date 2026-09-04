"""Desired-state and credential validation, the port of
io.github.getcolors.dbos.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from blue.providers import placeholder
from package_once_blue import compute as once_compute
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

# provider-compute -> what that choice implies.
#
# `required` are the non-secret keys that provider's template interpolates,
# `secrets` the credentials it needs through COLORS_PAR_*, and `tofu-env` the
# subset OpenTofu reads from the process environment itself. Keeping the three
# together is what stops a provider being validated against one set of keys and
# run with another. The keys of this map are the advertised providers; a
# provider without a template directory and a golden is not advertised, and
# this package advertises one.
#
# Two keys the template reads are deliberately not required. `digitalocean-name`
# is an optional override of the profile (Compute Name Standard), and
# `digitalocean-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
compute_providers = {
    "digitalocean": {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-ssh-sources", "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running: the only one it ever offered. The
# dbos-digitalocean state in R2 may hold such a legacy `params`, so this is
# what the Compute Provider Standard's legacy rule accepts it as.
default_compute_provider = "digitalocean"

# How this package describes itself to ONCE's `compute`, the Compute Provider
# Standard's operations over a package-owned registry. The registry and the
# default are the data above; `sources` names the firewall lists the template
# reads — SSH must list at least one CIDR, an empty HTTP list means no public
# HTTP. The name rules are ONCE's.
spec: once_compute.ComputeSpec = {
    "registry": compute_providers,
    "default": default_compute_provider,
    "sources": {"non_empty": ["ssh-sources"], "may_be_empty": ["http-sources"]},
}

# Keys this package read before it adopted the workspace standards. They are
# accepted and ignored — never refused — so the desired state of a deployment
# created before the adoption keeps validating unchanged.
#
# - `digitalocean-ssh-key-name`, `digitalocean-ssh-private-key` and
#   `digitalocean-ssh-authorized-keys`: the old key model, an account key
#   belonging to another deployment looked up by name. Replaced by the SSH
#   Keypair Standard: `digitalocean-ssh-keys` (an account key id) opts out,
#   its absence means the package generates and owns `~/.ssh/<profile>`.
# - `digitalocean-https-sources`: 443 is now sourced from
#   `digitalocean-http-sources`, with 80, as the Compute Provider Standard §5
#   has it.
# - `digitalocean-vpc-mode`: there was only ever one value. The regional
#   default VPC is discovered at runtime; ONCE's provider checks refuse
#   `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` instead.
retired_keys = [
    "digitalocean-ssh-key-name", "digitalocean-ssh-private-key",
    "digitalocean-ssh-authorized-keys", "digitalocean-https-sources",
    "digitalocean-vpc-mode",
]

# Every key desired state must carry. The provider-scoped keys come from
# `compute_providers`.
required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "dbos-host", "dbos-image", "dbos-version", "dbos-version-source-url",
    "dbos-version-discovered", "dbos-node-version", "dbos-application-name",
    "dbos-data-dir", "dbos-durable-delay-seconds", "dbos-step-max-attempts",
    "dbos-step-initial-retry-seconds", "dbos-workflow-retention-days",
    "postgres-version", "postgres-data-dir", "postgres-database",
    "dbos-system-database-pool-size", "postgres-backup-r2-bucket",
    "postgres-backup-r2-endpoint", "postgres-backup-r2-region",
    "postgres-backup-r2-prefix", "postgres-backup-retention-days",
    "postgres-backup-oncalendar",
    "cloudflare-zone", "cloudflare-proxied",
]

# Credentials Ansible looks up at play time on the host. A delete never runs
# that play — ONCE's remote stage only renders on delete — so these are
# demanded on a real create alone.
application_secrets = [
    "dbos-postgres-password",
    "postgres-backup-r2-access-key-id", "postgres-backup-r2-secret-access-key",
]

# Kept under their historical names for the callers that still read them.
REQUIRED = required
PROFILE_PAR = par_name("profile")
profile_par = PROFILE_PAR
HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
IMAGE_RE = re.compile(r"^ghcr\.io/getcolors/dbos(?::[^@\s]+|@sha256:[0-9a-f]{64})$")

# `<provider>-<suffix>`: desired state names compute keys after the provider,
# so the shared steps reach them through the selected provider rather than a
# fixed prefix. ONCE's; named here so `tools` reads the same.
compute_key = once_compute.compute_key

# What this deployment's machine is called: `digitalocean-name` when present,
# else the profile (Compute Name Standard). ONCE's; the droplet, the firewall
# and the `params.name` output derive every label from this one answer.
compute_name = once_compute.compute_name


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


# A source list as desired state or an overlay string carries it. ONCE's, so
# the validator and the template can never disagree about what an entry is.
cidrs = once_compute.cidrs


def env_errors(env: dict) -> list[str]:
    if str(env.get(PROFILE_PAR) or ""):
        return [f"{PROFILE_PAR} is set. This package takes profile from colors.yml only."]
    return []


def _positive_int(value) -> bool:
    """Clojure's integer? — a whole number that is not a boolean."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def state_errors(opts: dict) -> list[str]:
    """Every problem with desired state at once: the missing keys (this
    package's and the selected provider's), the package's own checks, then the
    Compute Provider Standard's — selection, the network contract and the
    provider rules, DigitalOcean's VPC refusals among them — which are ONCE's
    over `spec`. The retired keys are not looked at."""
    errors: list[str] = []
    for key in [*required, *once_compute.required_keys(spec, opts)]:
        if placeholder(opts.get(key)):
            errors.append(f":{key} is required")
    if not placeholder(opts.get("dbos-host")) and not HOST_RE.match(str(opts.get("dbos-host"))):
        errors.append(":dbos-host must be a fully qualified hostname")
    if not placeholder(opts.get("dbos-image")) and not IMAGE_RE.match(str(opts.get("dbos-image"))):
        errors.append(":dbos-image must be ghcr.io/getcolors/dbos with an explicit tag or digest")
    if not placeholder(opts.get("dbos-version")) and not VERSION_RE.match(str(opts.get("dbos-version"))):
        errors.append(":dbos-version must be an exact semantic version")
    if (not placeholder(opts.get("dbos-version"))
            and "@sha256:" not in str(opts.get("dbos-image"))
            and str(opts.get("dbos-version")) not in str(opts.get("dbos-image"))):
        errors.append(":dbos-image tag must match :dbos-version or use an immutable sha256 digest")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("cloudflare-zone") != opts.get("dbos-host"):
        errors.append(":dbos-host must be the apex of :cloudflare-zone")
    for key in ["dbos-durable-delay-seconds", "dbos-step-max-attempts",
                "dbos-step-initial-retry-seconds", "dbos-workflow-retention-days",
                "dbos-system-database-pool-size", "postgres-backup-retention-days"]:
        value = opts.get(key)
        if not placeholder(value) and not _positive_int(value):
            errors.append(f":{key} must be a positive integer")
    pool = opts.get("dbos-system-database-pool-size")
    if isinstance(pool, int) and not isinstance(pool, bool) and pool < 5:
        errors.append(":dbos-system-database-pool-size must be at least 5 for production")
    errors += once_compute.state_errors(spec, opts)
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers.get("provider-backend", {}).get(opts.get("provider-backend"))
    return (entry or {}).get("secrets", [])


def infrastructure_secrets(opts: dict) -> list[str]:
    """Credentials every real create and delete needs: the selected compute
    provider's, Cloudflare's, and the backend's."""
    return [*once_compute.secrets(spec, opts), "cloudflare-api-token", *backend_secrets(opts)]


def secret_errors(opts: dict, event: str = "create") -> list[str]:
    """The credentials a real `event` needs. A create needs the application
    secrets Ansible resolves on the host as well; a delete does not, because
    the remote stage only renders on delete."""
    keys = [*infrastructure_secrets(opts),
            *(application_secrets if event == "create" else [])]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(keys) if placeholder(opts.get(key))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return once_compute.tofu_env(spec, opts)
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers.get("provider-backend", {}).get(opts.get("provider-backend"))
        return (entry or {}).get("tofu-env", {})
    return {}
