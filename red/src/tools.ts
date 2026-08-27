// Steps and template data, the port of io.github.getcolors.dbos.tools.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ansibleStep } from "red/ansible";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type RenderOpts, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { failed, type Opts } from "red/workflow";
import { tools as onceTools } from "package-once-red";
import { parLookup, registrableDomain } from "./utils.ts";

import computeMainTf from "../resources/tofu-compute/main.tf" with { type: "text" };

export const computeTool = "tofu-compute";
export const dnsTool = "tofu-dns";
const templateOpts: RenderOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return onceTools.toolDir(opts, tool);
}

export function backendCredentialEnv(opts: Opts): Record<string, string> | undefined {
  return onceTools.backendCredentialEnv(opts);
}

const str = (value: unknown) => (value == null ? "" : String(value));

export function appEnv(opts: Opts): string[] {
  return [
    `DBOS_POSTGRES_PASSWORD=${parLookup("dbos-postgres-password")}`,
    `DBOS_APPLICATION_NAME=${str(opts["dbos-application-name"])}`,
    `DBOS_APPLICATION_VERSION=${str(opts["dbos-version"])}`,
    `DBOS_SYSTEM_DATABASE_POOL_SIZE=${str(opts["dbos-system-database-pool-size"])}`,
    `DBOS_DURABLE_DELAY_SECONDS=${str(opts["dbos-durable-delay-seconds"])}`,
    `DBOS_STEP_MAX_ATTEMPTS=${str(opts["dbos-step-max-attempts"])}`,
    `DBOS_STEP_INITIAL_RETRY_SECONDS=${str(opts["dbos-step-initial-retry-seconds"])}`,
    `DBOS_WORKFLOW_RETENTION_DAYS=${str(opts["dbos-workflow-retention-days"])}`,
    `POSTGRES_DB=${str(opts["postgres-database"])}`,
    "POSTGRES_USER=dbos",
    `POSTGRES_PASSWORD=${parLookup("dbos-postgres-password")}`,
    `BACKUP_R2_BUCKET=${str(opts["postgres-backup-r2-bucket"])}`,
    `BACKUP_R2_ENDPOINT=${str(opts["postgres-backup-r2-endpoint"])}`,
    `BACKUP_R2_REGION=${str(opts["postgres-backup-r2-region"])}`,
    `BACKUP_R2_PREFIX=${str(opts["postgres-backup-r2-prefix"])}`,
    `BACKUP_RETENTION_DAYS=${str(opts["postgres-backup-retention-days"])}`,
    `BACKUP_ONCALENDAR=${str(opts["postgres-backup-oncalendar"])}`,
    `BACKUP_R2_ACCESS_KEY_ID=${parLookup("postgres-backup-r2-access-key-id")}`,
    `BACKUP_R2_SECRET_ACCESS_KEY=${parLookup("postgres-backup-r2-secret-access-key")}`,
  ];
}

export function withOnceShape(opts: Opts): Opts {
  return {
    ...opts,
    once: {
      applications: [{
        host: opts["dbos-host"],
        image: opts["dbos-image"],
        env: appEnv(opts),
      }],
    },
  };
}

function outputParams(result: Opts): Record<string, unknown> | undefined {
  const params = (result["tofu/outputs"] as Record<string, unknown> | undefined)?.params;
  return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
}

export async function tofuComputeStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, computeTool);
  const data: Opts = {
    ...opts,
    "digitalocean-ssh-sources-hcl": tofu.hclList((opts["digitalocean-ssh-sources"] as string[] | undefined) ?? []),
    "digitalocean-http-sources-hcl": tofu.hclList((opts["digitalocean-http-sources"] as string[] | undefined) ?? []),
    "digitalocean-https-sources-hcl": tofu.hclList((opts["digitalocean-https-sources"] as string[] | undefined) ?? []),
  };
  const specs: Spec[] = [{
    template: { name: "tofu-compute/main.tf", content: computeMainTf },
    target: `${dir}/main.tf`,
    data,
    opts: templateOpts,
  }];
  let env = backendCredentialEnv(opts);
  if (opts["do-token"]) env = { ...(env ?? {}), DIGITALOCEAN_TOKEN: String(opts["do-token"]) };
  const result = await tofu.tofuWithSpec(opts, specs, { dir, env });
  const fallback = { ip: "192.168.0.1", sudoer: "root", name: opts.profile, user: "root" };
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, "once/compute-params": fallback };
  if (opts["red/event"] === "delete") return result;
  return { ...result, "once/compute-params": { ...fallback, ...(outputParams(result) ?? {}) } };
}

// ---------------------------------------------------------------------------
// The ansible-remote stage.
//
// Green delegates this stage to io.github.getcolors.once.tools entirely. Red
// cannot: ONCE at the pinned rev builds its once.yml smtp map with a literal
// {smtp_server, smtp_port, smtp_username, smtp_password} object, so a desired
// state that sets no SMTP password — this package's, whose relay is the
// loopback placeholder — renders `smtp_password: null` where green's
// select-keys omits the key. The stage is therefore assembled here from ONCE's
// own exported pieces (templates, inventory, deploy keys) with green's
// select-keys semantics for the smtp map; byte parity with the committed
// goldens is the proof.

const onceEntry = Bun.resolveSync("package-once-red", import.meta.dir);
const onceResources = join(dirname(onceEntry), "..", "resources");

function onceTemplate(name: string): Template {
  return { name: `once/tools/${name}`, content: readFileSync(join(onceResources, "tools", name), "utf8") };
}

function dataFn(data: Opts): Opts {
  return { ...data, sudoer: data.sudoer ?? "root", hosts: [data.ip ?? "64.227.72.100"], users: [] };
}

// The yaml writer ONCE's colours share, copied because ONCE does not export it.
function yamlScalar(value: any): string | undefined {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (typeof value === "object" && Object.keys(value).length === 0) return "{}";
  return undefined;
}

function yamlLines(value: any, indent = 0): string[] {
  const scalar = yamlScalar(value);
  if (scalar !== undefined) return [`${" ".repeat(indent)}${scalar}`];
  if (Array.isArray(value)) return value.flatMap((item) => {
    const child = yamlLines(item, indent + 2);
    const prefix = " ".repeat(indent + 2);
    return [`${" ".repeat(indent)}- ${child[0]!.slice(prefix.length)}`, ...child.slice(1)];
  });
  return Object.entries(value).flatMap(([key, nested]) => {
    const nestedScalar = yamlScalar(nested);
    return nestedScalar !== undefined
      ? [`${" ".repeat(indent)}${key}: ${nestedScalar}`]
      : [`${" ".repeat(indent)}${key}:`, ...yamlLines(nested, indent + 2)];
  });
}

function yaml(value: any): string { return `${yamlLines(value).join("\n")}\n`; }

function resolveEnv(env: any): any {
  return env && !Array.isArray(env) && typeof env === "object"
    ? Object.entries(env).map(([name, key]) => `${name}=${parLookup(String(key))}`)
    : env;
}

function applicationData(smtp: any, app: any): any {
  const zone = registrableDomain(app.host);
  // github never reaches the host. It says where the deploy credentials are
  // published, which is no business of the module reconciling containers.
  const { github: _github, ...rest } = app;
  return { ...rest, ...smtp, smtp_from: `Info <info@notifications.${zone}>`, ...(app.env && !Array.isArray(app.env) && typeof app.env === "object" ? { env: resolveEnv(app.env) } : {}) };
}

export function ansibleOnce(opts: Opts): string {
  // Green's select-keys: a key absent from opts stays absent from the map, so
  // an unset smtp_password renders no line at all.
  const smtp: any = {};
  for (const key of ["smtp_server", "smtp_port", "smtp_username", "smtp_password"]) {
    if (key in opts) smtp[key] = opts[key];
  }
  const passwordKey: Record<string, string> = { resend: "resend-password", "no-infra": "no-infra-smtp-password" };
  const key = passwordKey[String(opts["provider-smtp"] ?? "resend")];
  if (key && smtp.smtp_password) smtp.smtp_password = parLookup(key);
  const once: any = opts.once ?? {};
  const configured = { ...once, applications: (once.applications ?? []).map((app: any) => applicationData(smtp, app)) };
  return yaml([{ name: "Reconcile ONCE applications", become: true, once: configured }]);
}

function ansibleRemoteSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, "ansible-remote");
  const data = dataFn(opts);
  const spec = (template: Template, target: string): Spec => ({ template, target, data, opts: templateOpts });
  return [
    spec(onceTemplate("ansible/ansible.cfg"), `${dir}/ansible.cfg`),
    spec(onceTemplate("ansible/main.yml"), `${dir}/main.yml`),
    spec(onceTemplate("ansible/files/authorized-keys"), `${dir}/files/authorized-keys`),
    contentSpec(`${dir}/deploy_keys`, onceTools.deployKeysContent(opts)),
    spec(onceTemplate("ansible/files/deploy"), `${dir}/files/deploy`),
    spec(onceTemplate("ansible/library/once"), `${dir}/library/once`),
    contentSpec(`${dir}/inventory.json`, onceTools.inventory(data)),
    contentSpec(`${dir}/once.yml`, ansibleOnce(data)),
  ];
}

export async function ansibleRemoteStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, "ansible-remote");
  const rendered = scaffold(opts, ansibleRemoteSpecs(opts));
  if (["build", "delete"].includes(String(opts["red/event"]))) return rendered;
  return ansibleStep(rendered, { dir, inventory: "inventory.json", playbooks: { create: "main.yml" }, hostKeyChecking: false });
}
