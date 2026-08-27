// The graph, the port of io.github.getcolors.dbos.workflow.
import { readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts } from "red/workflow";
import { tools as onceTools } from "package-once-red";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": "digitalocean",
  "provider-dns": "cloudflare",
  "provider-smtp": "no-infra",
  "provider-backend": "local",
  workdir: ".colors",
};

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  const checked = await preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && event === "create" ? validate.secretErrors(current) : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? ["delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]
          : [],
    ],
  }, env);
  if (failed(checked)) return checked;
  return {
    ...tools.withOnceShape(checked),
    smtp_server: "127.0.0.1",
    smtp_port: 25,
    smtp_username: "unused",
    "once/smtp-params": {
      smtp_server: "127.0.0.1",
      smtp_port: 25,
      smtp_username: "unused",
      domains: [],
    },
  };
}

export async function ansibleCleanupStep(opts: Opts): Promise<Opts> {
  return tools.ansibleRemoteStep(await onceTools.ansibleLocalStep(opts));
}

export function wireFn(step: string, runOpts: Opts) {
  if (runOpts["red/event"] === "delete") {
    switch (step) {
      case "dbos/start": return [startStep, "dbos/ansible-cleanup"] as const;
      case "dbos/ansible-cleanup": return [ansibleCleanupStep, "dbos/dns"] as const;
      case "dbos/dns": return [onceTools.tofuDnsStep, "dbos/compute"] as const;
      case "dbos/compute": return [tools.tofuComputeStep] as const;
    }
  } else {
    switch (step) {
      case "dbos/start": return [startStep, "dbos/compute"] as const;
      case "dbos/compute": return [tools.tofuComputeStep, "dbos/dns"] as const;
      case "dbos/dns": return [onceTools.tofuDnsStep, "dbos/ansible-local", "dbos/ansible-remote"] as const;
      case "dbos/ansible-local": return [onceTools.ansibleLocalStep] as const;
      case "dbos/ansible-remote": return [tools.ansibleRemoteStep] as const;
    }
  }
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? "dbos"}/${tool}.tfstate`,
  });
}

export const sideEffectingSteps = [
  "dbos/compute", "dbos/dns", "dbos/ansible-local",
  "dbos/ansible-remote", "dbos/ansible-cleanup",
];

function create() {
  let wf = workflow({ start: "dbos/start", wireFn });
  wf = adviceAdd(wf, "dbos/compute", "before", "dbos.workflow/backend", backendAdvice(tools.computeTool));
  wf = adviceAdd(wf, "dbos/dns", "before", "dbos.workflow/backend", backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffectingSteps);
}

export const dbosWorkflow = create();
