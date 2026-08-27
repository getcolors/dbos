// Desired-state validation, the port of io.github.getcolors.dbos.validate.
import { parName } from "red/cli";
import { placeholder } from "red/providers";
import type { Opts } from "red/workflow";

export const required = [
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
];

export const runtimeSecrets = [
  "do-token", "cloudflare-api-token", "dbos-postgres-password",
  "postgres-backup-r2-access-key-id", "postgres-backup-r2-secret-access-key",
];

export const profilePar = parName("profile");
const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const versionRe = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const imageRe = /^ghcr\.io\/getcolors\/dbos(?::[^@\s]+|@sha256:[0-9a-f]{64})$/;
const cidrRe = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$|^[0-9a-fA-F:]+\/[0-9]{1,3}$/;

export { placeholder };

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set. This package takes profile from colors.yml only.`]
    : [];
}

// Clojure's integer? — a whole number that is not a boolean.
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (placeholder(opts[key])) errors.push(`:${key} is required`);
  }
  if (!placeholder(opts["dbos-host"]) && !hostRe.test(String(opts["dbos-host"]))) {
    errors.push(":dbos-host must be a fully qualified hostname");
  }
  if (!placeholder(opts["dbos-image"]) && !imageRe.test(String(opts["dbos-image"]))) {
    errors.push(":dbos-image must be ghcr.io/getcolors/dbos with an explicit tag or digest");
  }
  if (!placeholder(opts["dbos-version"]) && !versionRe.test(String(opts["dbos-version"]))) {
    errors.push(":dbos-version must be an exact semantic version");
  }
  if (!placeholder(opts["dbos-version"]) &&
      !String(opts["dbos-image"]).includes("@sha256:") &&
      !String(opts["dbos-image"]).includes(String(opts["dbos-version"]))) {
    errors.push(":dbos-image tag must match :dbos-version or use an immutable sha256 digest");
  }
  if (opts["provider-compute"] !== "digitalocean") {
    errors.push(":provider-compute must be digitalocean");
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (opts["digitalocean-vpc-mode"] !== "default") {
    errors.push(":digitalocean-vpc-mode must be default");
  }
  if ("digitalocean-vpc-uuid" in opts || "digitalocean-vpc-cidr" in opts) {
    errors.push("a VPC UUID or CIDR must not be configured; the regional default VPC is discovered at runtime");
  }
  if (opts["cloudflare-zone"] !== opts["dbos-host"]) {
    errors.push(":dbos-host must be the apex of :cloudflare-zone");
  }
  for (const key of ["dbos-durable-delay-seconds", "dbos-step-max-attempts",
                     "dbos-step-initial-retry-seconds", "dbos-workflow-retention-days",
                     "dbos-system-database-pool-size", "postgres-backup-retention-days"]) {
    const value = opts[key];
    if (!placeholder(value) && !(isInteger(value) && value > 0)) {
      errors.push(`:${key} must be a positive integer`);
    }
  }
  const pool = opts["dbos-system-database-pool-size"];
  if (isInteger(pool) && pool < 5) {
    errors.push(":dbos-system-database-pool-size must be at least 5 for production");
  }
  for (const key of ["digitalocean-ssh-sources", "digitalocean-http-sources", "digitalocean-https-sources"]) {
    for (const cidr of (opts[key] as unknown[] | undefined) ?? []) {
      if (!cidrRe.test(String(cidr))) errors.push(`:${key} contains invalid CIDR ${cidr}`);
    }
  }
  return errors;
}

export function secretErrors(opts: Opts): string[] {
  const keys = [
    ...runtimeSecrets,
    ...(opts["provider-backend"] === "r2" ? ["r2-access-key-id", "r2-secret-access-key"] : []),
  ];
  return keys.filter((key) => placeholder(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}
