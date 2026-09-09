// Steps and template data, the port of io.github.getcolors.dbos.tools.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ansible from "red/ansible";
import { ansibleStep } from "red/ansible";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type RenderOpts, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { failed, type Opts } from "red/workflow";
import { compute, tools as onceTools } from "package-once-red";
import * as sshConfig from "./ssh-config.ts";
import { parLookup, registrableDomain } from "./utils.ts";
import * as validate from "./validate.ts";
import * as machine from "./machine.ts";

import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import bootstrapMain from "../resources/tools/bootstrap/main.yml" with {type:"text"};

// The compute and DNS stages keep ONCE's stage names, deliberately. The
// compute stage's name keys the remote state (`<profile>/tofu-compute.tfstate`
// through backendAdvice) and the DNS stage is what the deployment knows; the
// Compute Provider Standard constrains the template's source path, not the
// rendered target. The local stage is this package's own and named after it.
export const computeTool = "tofu-compute";
export const dnsTool = "tofu-dns";
export const ansibleLocalTool = "dbos-ansible-local";
export const templateOpts: RenderOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return onceTools.toolDir(opts, tool);
}

export function backendCredentialEnv(opts: Opts): Record<string, string> | undefined {
  return onceTools.backendCredentialEnv(opts);
}

// The backend's credentials plus the selected compute provider's, from ONCE's
// registry over this package's spec. Unset credentials are omitted, so build
// and dry-run stay credential-free.
export function computeCredentialEnv(opts: Opts): Record<string, string> | undefined {
  const env: Record<string, string> = { ...(backendCredentialEnv(opts) ?? {}) };
  for (const [key, envVar] of Object.entries(validate.tofuEnv(opts, "provider-compute"))) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible-local/ansible.cfg": ansibleLocalCfg,
  "ansible-local/inventory.ini": ansibleLocalInventory,
  "ansible-local/main.yml": ansibleLocalMain,
  "bootstrap/main.yml": bootstrapMain,
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new Error(`template not found: ${name}`);
  return { name, content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
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

// ---------------------------------------------------------------- compute

export const fallbackParams = machine.fallbackParams;
export function withComputeParams(opts:Opts,params:Opts):Opts { return {...opts,...params,'once/compute-params':params}; }
export const tofuComputeStep = machine.step;

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const del = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir, inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ssh_hosts:[{name:opts.profile,ip:opts.ip,user:opts.user,identity_file:opts['ssh-private-key-path']}],
      block_state: del ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
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
  return { ...data, sudoer: data.sudoer ?? "root", hosts: [data.ip], users: [] };
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
  const remoteSpec = (source: Template, target: string): Spec => ({ template: source, target, data, opts: templateOpts });
  return [
    remoteSpec(onceTemplate("ansible/ansible.cfg"), `${dir}/ansible.cfg`),
    remoteSpec(onceTemplate("ansible/main.yml"), `${dir}/main.yml`),
    remoteSpec(onceTemplate("ansible/files/authorized-keys"), `${dir}/files/authorized-keys`),
    contentSpec(`${dir}/deploy_keys`, onceTools.deployKeysContent(opts)),
    remoteSpec(onceTemplate("ansible/files/deploy"), `${dir}/files/deploy`),
    remoteSpec(onceTemplate("ansible/library/once"), `${dir}/library/once`),
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


export function bootstrapStep(opts:Opts):Promise<Opts> {
  const dir=toolDir(opts,'dbos-bootstrap');
  return ansible.ansibleWithSpec(opts,{dir,inventory:'inventory.json',playbooks:{create:'main.yml'},hostKeyChecking:false},[
    spec(template('bootstrap','main.yml'),dir+'/main.yml',opts),
    contentSpec(dir+'/inventory.json',onceTools.inventory(dataFn(opts))),
  ]);
}
