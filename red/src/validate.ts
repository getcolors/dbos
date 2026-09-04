// Desired-state and credential validation, the port of
// io.github.getcolors.dbos.validate.
//
// Green renders its keys as Clojure keywords, so every message here carries the
// same leading colon — the three colours must report identical errors for one
// colors.yml.
import { parName } from "red/cli";
import { placeholder } from "red/providers";
import type { Opts } from "red/workflow";
import { compute, providers as onceProviders } from "package-once-red";
import { onceSsh } from "./once.ts";

// provider-compute -> what that choice implies.
//
// `required` are the non-secret keys that provider's template interpolates,
// `secrets` the credentials it needs through COLORS_PAR_*, and `tofuEnv` the
// subset OpenTofu reads from the process environment itself. Keeping the three
// together is what stops a provider being validated against one set of keys and
// run with another. The keys of this map are the advertised providers; a
// provider without a template directory and a golden is not advertised, and
// this package advertises one.
//
// Two keys the template reads are deliberately not required. `digitalocean-name`
// is an optional override of the profile (Compute Name Standard), and
// `digitalocean-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
export const computeProviders: compute.Registry = {
  digitalocean: {
    required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
               "digitalocean-ssh-sources", "digitalocean-http-sources"],
    secrets: ["do-token"],
    tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
  },
};

// The provider a deployment created before this package recorded one in its
// compute output must be running: the only one it ever offered. The
// dbos-digitalocean state in R2 may hold such a legacy `params`, so this is
// what the Compute Provider Standard's legacy rule accepts it as.
export const defaultComputeProvider = "digitalocean";

// How this package describes itself to ONCE's `compute`, the Compute Provider
// Standard's operations over a package-owned registry. The registry and the
// default are the data above; `sources` names the firewall lists the template
// reads — SSH must list at least one CIDR, an empty HTTP list means no public
// HTTP. The name rules are ONCE's.
export const spec: compute.ComputeSpec = {
  registry: computeProviders,
  default: defaultComputeProvider,
  sources: { nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources"] },
};

// Keys this package read before it adopted the workspace standards. They are
// accepted and ignored — never refused — so the desired state of a deployment
// created before the adoption keeps validating unchanged.
//
// - `digitalocean-ssh-key-name`, `digitalocean-ssh-private-key` and
//   `digitalocean-ssh-authorized-keys`: the old key model, an account key
//   belonging to another deployment looked up by name. Replaced by the SSH
//   Keypair Standard: `digitalocean-ssh-keys` (an account key id) opts out,
//   its absence means the package generates and owns `~/.ssh/<profile>`.
// - `digitalocean-https-sources`: 443 is now sourced from
//   `digitalocean-http-sources`, with 80, as the Compute Provider Standard §5
//   has it.
// - `digitalocean-vpc-mode`: there was only ever one value. The regional
//   default VPC is discovered at runtime; ONCE's provider checks refuse
//   `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` instead.
export const retiredKeys = [
  "digitalocean-ssh-key-name", "digitalocean-ssh-private-key",
  "digitalocean-ssh-authorized-keys", "digitalocean-https-sources",
  "digitalocean-vpc-mode",
];

// Every key desired state must carry. The provider-scoped keys come from
// `computeProviders`.
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
  "postgres-backup-oncalendar",
  "cloudflare-zone", "cloudflare-proxied",
];

// Credentials Ansible looks up at play time on the host. A delete never runs
// that play — ONCE's remote stage only renders on delete — so these are
// demanded on a real create alone.
export const applicationSecrets = [
  "dbos-postgres-password",
  "postgres-backup-r2-access-key-id", "postgres-backup-r2-secret-access-key",
];

export const profilePar = parName("profile");
const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const versionRe = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const imageRe = /^ghcr\.io\/getcolors\/dbos(?::[^@\s]+|@sha256:[0-9a-f]{64})$/;

export { placeholder };

// `<provider>-<suffix>`: desired state names compute keys after the provider,
// so the shared steps reach them through the selected provider rather than a
// fixed prefix. ONCE's; named here so `tools` reads the same.
export const computeKey = compute.computeKey;

// What this deployment's machine is called: `digitalocean-name` when present,
// else the profile (Compute Name Standard). ONCE's; the droplet, the firewall
// and the `params.name` output derive every label from this one answer.
export const computeName = compute.computeName;

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// A source list as desired state or an overlay string carries it. ONCE's, so
// the validator and the template can never disagree about what an entry is.
export const cidrs = compute.cidrs;

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set. This package takes profile from colors.yml only.`]
    : [];
}

// Clojure's integer? — a whole number that is not a boolean.
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

// Every problem with desired state at once: the missing keys (this package's
// and the selected provider's), the package's own checks, then the Compute
// Provider Standard's — selection, the network contract and the provider
// rules, DigitalOcean's VPC refusals among them — which are ONCE's over
// `spec`. The retired keys are not looked at.
export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of [...required, ...compute.requiredKeys(spec, opts)]) {
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
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
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
  errors.push(...compute.stateErrors(spec, opts));
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return onceProviders["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// Credentials every real create and delete needs: the selected compute
// provider's, Cloudflare's, and the backend's.
export function infrastructureSecrets(opts: Opts): string[] {
  return [...compute.secrets(spec, opts), "cloudflare-api-token", ...backendSecrets(opts)];
}

// The credentials a real `event` needs. A create needs the application secrets
// Ansible resolves on the host as well; a delete does not, because the remote
// stage only renders on delete.
export function secretErrors(opts: Opts, event: string = "create"): string[] {
  const keys = [
    ...infrastructureSecrets(opts),
    ...(event === "create" ? applicationSecrets : []),
  ];
  return [...new Set(keys)].filter((key) => placeholder(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return compute.tofuEnv(spec, opts);
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return onceProviders["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
