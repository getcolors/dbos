// The graph, the port of io.github.getcolors.dbos.workflow.
import { readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type NextFn, type Opts, type WireDecl } from "red/workflow";
import { compute, tools as onceTools } from "package-once-red";
import * as machine from "./machine.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-smtp": "no-infra",
  "provider-backend": "r2",
  workdir: ".colors",
};

// The ONCE application this package deploys, and the SMTP shim: the relay is
// the loopback placeholder and no password is set, so ONCE's `no-infra` SMTP
// provider has nothing to look up.
function withApplicationShape(opts: Opts): Opts {
  return {
    ...tools.withOnceShape(opts),
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

export async function startStep(opts:Opts,env:Record<string,string|undefined>=process.env):Promise<Opts> {
  const checked = await preflight(opts,{defaults,overlay:readPars,
    validators:[(_o,e)=>validate.envErrors(e),(o)=>validate.stateErrors(o),
      (o,_e,c)=>c.real && ['create','delete'].includes(String(c.event))?validate.secretErrors(o,String(c.event)):[],
      (o,_e,c)=>c.real && c.event==='delete' && o['compute-prevent-destroy']?['delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override']:[]],
    afterValidate:async(o,e,c)=>c.real && c.event==='delete'?machine.load(o,e):c.real && c.event==='create'?sshConfig.preflight(o):{...o,"red/exit":0},
  },env);
  return failed(checked)?checked:withApplicationShape(checked);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "dbos/start": [startStep, "dbos/ansible-cleanup"],
      // The remote stage only renders on delete; it reads the adopted address
      // through once/compute-params.
      "dbos/ansible-cleanup": [tools.ansibleRemoteStep, "dbos/dns"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "dbos/dns": [onceTools.tofuDnsStep, "dbos/ssh-config"],
      "dbos/ssh-config": [tools.ansibleLocalStep, "dbos/compute"],
      // The keypair goes strictly after the compute destroy: a key that
      // predeceases its host locks the operator out of a machine that still
      // exists (SSH Keypair Standard §3.3).
      "dbos/compute": [tools.tofuComputeStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "dbos/start": [startStep, "dbos/compute"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine.
    "dbos/compute": [tools.tofuComputeStep, "dbos/ssh-config"],
    "dbos/ssh-config": [tools.ansibleLocalStep, "dbos/dns"],
    "dbos/dns": [onceTools.tofuDnsStep, "dbos/bootstrap"],
    "dbos/bootstrap": [tools.bootstrapStep, "dbos/ansible-remote"],
    "dbos/ansible-remote": [tools.ansibleRemoteStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? "dbos"}/${tool}.tfstate`,
  });
}

export const sideEffectingSteps = [
  "dbos/compute", "dbos/ssh-config", "dbos/dns",
  "dbos/ansible-remote", "dbos/ansible-cleanup", "dbos/bootstrap",
];

export const nextFn: NextFn = (_step, successors, opts) =>
  failed(opts) || opts['colors-compute/already-destroyed'] === true
    ? [] : (successors ?? []).map(step => [step, opts] as const);

function create() {
  let wf = workflow({ start: "dbos/start", wireFn, nextFn });
  wf = adviceAdd(wf, "dbos/dns", "before", "dbos.workflow/backend", backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffectingSteps);
}

export const dbosWorkflow = create();
