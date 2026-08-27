"""Desired-state validation, the port of io.github.getcolors.dbos.validate."""

from __future__ import annotations

import re

from blue.cli import par_name
from blue.providers import placeholder

REQUIRED = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "dbos-host", "dbos-image", "dbos-version", "dbos-version-source-url",
    "dbos-version-discovered", "dbos-node-version", "dbos-application-name",
    "dbos-data-dir", "dbos-durable-delay-seconds", "dbos-step-max-attempts",
    "dbos-step-initial-retry-seconds", "dbos-workflow-retention-days",
    "postgres-version", "postgres-data-dir", "postgres-database",
    "dbos-system-database-pool-size", "postgres-backup-r2-bucket",
    "postgres-backup-r2-endpoint", "postgres-backup-r2-region",
    "postgres-backup-r2-prefix", "postgres-backup-retention-days",
    "postgres-backup-oncalendar", "digitalocean-name", "digitalocean-region",
    "digitalocean-size", "digitalocean-image", "digitalocean-ssh-authorized-keys",
    "digitalocean-ssh-key-name", "digitalocean-ssh-private-key", "digitalocean-ssh-sources", "digitalocean-http-sources",
    "digitalocean-https-sources", "digitalocean-vpc-mode",
    "cloudflare-zone", "cloudflare-proxied",
]

RUNTIME_SECRETS = [
    "do-token", "cloudflare-api-token", "dbos-postgres-password",
    "postgres-backup-r2-access-key-id", "postgres-backup-r2-secret-access-key",
]

PROFILE_PAR = par_name("profile")
HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
IMAGE_RE = re.compile(r"^ghcr\.io/getcolors/dbos(?::[^@\s]+|@sha256:[0-9a-f]{64})$")
CIDR_RE = re.compile(r"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$|^[0-9a-fA-F:]+/[0-9]{1,3}$")


def env_errors(env: dict) -> list[str]:
    if str(env.get(PROFILE_PAR) or ""):
        return [f"{PROFILE_PAR} is set. This package takes profile from colors.yml only."]
    return []


def _positive_int(value) -> bool:
    """Clojure's integer? — a whole number that is not a boolean."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []
    for key in REQUIRED:
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
    if opts.get("provider-compute") != "digitalocean":
        errors.append(":provider-compute must be digitalocean")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("digitalocean-vpc-mode") != "default":
        errors.append(":digitalocean-vpc-mode must be default")
    if "digitalocean-vpc-uuid" in opts or "digitalocean-vpc-cidr" in opts:
        errors.append("a VPC UUID or CIDR must not be configured; the regional default VPC is discovered at runtime")
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
    for key in ["digitalocean-ssh-sources", "digitalocean-http-sources", "digitalocean-https-sources"]:
        for cidr in opts.get(key) or []:
            if not CIDR_RE.match(str(cidr)):
                errors.append(f":{key} contains invalid CIDR {cidr}")
    return errors


def secret_errors(opts: dict) -> list[str]:
    keys = list(RUNTIME_SECRETS)
    if opts.get("provider-backend") == "r2":
        keys += ["r2-access-key-id", "r2-secret-access-key"]
    return [f"required credential is not set: {par_name(key)}"
            for key in keys if placeholder(opts.get(key))]
