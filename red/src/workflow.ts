// The graph, the port of io.github.getcolors.dbos.workflow.
import { readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute, tools as onceTools } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-smtp": "no-infra",
  "provider-backend": "local",
  workdir: ".colors",
};

// Compute params recorded in the compute state; undefined when the state
// holds none. An unreadable backend throws the SDK's `StepError`, which
// `compute.readState` turns into `{ error }` — create and delete treat the two
// differently. Kept local, and injectable into `startStep`, so tests never
// shell out to tofu.
export async function stateOutput(opts: Opts): Promise<compute.Params | undefined> {
  const outputs = await tofu.outputs(
    tools.toolDir(opts, tools.computeTool),
    tools.backendCredentialEnv(opts),
  );
  const params = outputs.params;
  return params && typeof params === "object" ? params as compute.Params : undefined;
}

// A real delete renders ONCE's remote stage and runs the local one before the
// compute destroy, so the machine's address must come out of the existing
// state here. The adoption is ONCE's (`compute.adoptState`): a readable state
// without compute params leaves `ip` unset, an unreadable backend fails loudly
// — swallowing it is how a live teardown once ended up rendering its cleanup
// against a fallback address. No address override. What this package adds is
// the bridge: the adopted params become `once/compute-params`, which is how
// ONCE's composed stages read the host.
export function adoptState(opts: Opts, state: compute.StateRead): Opts {
  const adopted = compute.adoptState(opts, "delete", state);
  if (failed(adopted) || !state.params) return adopted;
  return tools.withComputeParams(adopted, state.params);
}

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

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  reader: compute.StateReader = stateOutput,
): Promise<Opts> {
  // The state is read once, up front, on the same defaulted and overlaid opts
  // the validators see — the overlay is what carries the backend credentials —
  // and only for the two events that touch a provider. The validator and the
  // after-validate share the one read; the reader is injectable so tests never
  // shell out to tofu.
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const context: PreflightContext = {
    event: typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined,
    real: !overlaid["red/dry-run"],
  };
  const state: compute.StateRead = compute.lifecycleEvent(context)
    ? await compute.readState(overlaid, reader) : {};
  const checked = await preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Standard §4 before the credentials: a recorded provider that differs
      // from the selected one reports the actionable error, not a missing
      // token for the provider that was just selected. The thunk carries the
      // event: a delete needs the infrastructure credentials, a create the
      // application's too.
      (current, _environment, ctx) => (compute.lifecycleEvent(ctx)
        ? compute.providerValidator(validate.spec, current, state.params,
                                    () => validate.secretErrors(current, String(ctx.event)))
        : []),
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? ["delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]
          : [],
    ],
    // The machine key's create matrix and the provider preflight run before
    // any template is rendered: an unowned key on disk or at the provider
    // stops the run while stopping is still free. Delete fills the same
    // template values — a destroy renders before it destroys — and adopts the
    // recorded address, but checks no key, because its key cleanup runs after
    // the compute destroy.
    afterValidate: async (current, _environment, { event, real }) => {
      if (real && event === "delete") return adoptState(current, state);
      if (real && event === "create") {
        let next = await ssh.ensureKey(current, async () => state.params);
        if (failed(next)) return next;
        next = await ssh.preflight(ssh.withMachineKey(next));
        if (!failed(next)) next = sshConfig.preflight(next);
        return failed(next) ? next : { ...next, "red/exit": 0 };
      }
      return { ...ssh.withMachineKey(current), "red/exit": 0 };
    },
  }, env);
  if (failed(checked)) return checked;
  return withApplicationShape(checked);
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
      "dbos/compute": [tools.tofuComputeStep, "dbos/ssh-cleanup"],
      "dbos/ssh-cleanup": [ssh.cleanupStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "dbos/start": [startStep, "dbos/compute"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine.
    "dbos/compute": [tools.tofuComputeStep, "dbos/ssh-config"],
    "dbos/ssh-config": [tools.ansibleLocalStep, "dbos/dns"],
    "dbos/dns": [onceTools.tofuDnsStep, "dbos/ansible-remote"],
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
  "dbos/ansible-remote", "dbos/ansible-cleanup", "dbos/ssh-cleanup",
];

function create() {
  let wf = workflow({ start: "dbos/start", wireFn });
  wf = adviceAdd(wf, "dbos/compute", "before", "dbos.workflow/backend", backendAdvice(tools.computeTool));
  wf = adviceAdd(wf, "dbos/dns", "before", "dbos.workflow/backend", backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffectingSteps);
}

export const dbosWorkflow = create();
