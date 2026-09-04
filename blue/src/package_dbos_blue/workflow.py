"""The graph, the port of io.github.getcolors.dbos.workflow."""

from __future__ import annotations

import os

from blue import dry_run, progress, tofu
from blue.cli import read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from package_once_blue import compute as once_compute
from package_once_blue import tools as once_tools

from . import ssh, ssh_config, tools, validate

DEFAULTS = {
    "compute-prevent-destroy": True,
    "provider-compute": validate.default_compute_provider,
    "provider-dns": "cloudflare",
    "provider-smtp": "no-infra",
    "provider-backend": "local",
    "workdir": ".colors",
}


async def state_output(opts: dict) -> dict | None:
    """Compute params recorded in the compute state; None when the state holds
    none. An unreadable backend raises the SDK's `StepError`, which
    `once_compute.read_state` turns into `{"error": message}` — create and
    delete treat the two differently. Kept local, and looked up on this module
    at call time, so tests can replace it."""
    outputs = await tofu.outputs(tools.tool_dir(opts, tools.COMPUTE_TOOL),
                                 tools.backend_credential_env(opts))
    return (outputs or {}).get("params")


def adopt_state(opts: dict, state: dict) -> dict:
    """A real delete renders ONCE's remote stage and runs the local one before
    the compute destroy, so the machine's address must come out of the
    existing state here. The adoption is ONCE's (`once_compute.adopt_state`):
    a readable state without compute params leaves `ip` unset, an unreadable
    backend fails loudly — swallowing it is how a live teardown once ended up
    rendering its cleanup against a fallback address. No address override.
    What this package adds is the bridge: the adopted params become
    `once/compute-params`, which is how ONCE's composed stages read the
    host."""
    adopted = once_compute.adopt_state(opts, "delete", state)
    if failed(adopted) or not state.get("params"):
        return adopted
    return tools.with_compute_params(adopted, state["params"])


def _with_application_shape(opts: dict) -> dict:
    """The ONCE application this package deploys, and the SMTP shim: the relay
    is the loopback placeholder and no password is set, so ONCE's `no-infra`
    SMTP provider has nothing to look up."""
    return {
        **tools.with_once_shape(opts),
        "smtp_server": "127.0.0.1",
        "smtp_port": 25,
        "smtp_username": "unused",
        "once/smtp-params": {
            "smtp_server": "127.0.0.1",
            "smtp_port": 25,
            "smtp_username": "unused",
            "domains": [],
        },
    }


async def start_step(original: dict, env: dict[str, str] | None = None) -> dict:
    # The state is read once, up front, on the same defaulted and overlaid
    # opts the validators see — the overlay is what carries the backend
    # credentials — and only for the two events that touch a provider. The
    # validator and the after-validate share the one read.
    environment = dict(os.environ if env is None else env)
    overlaid = read_pars({**DEFAULTS, **original}, environment)
    context = {"event": overlaid.get("blue/event"), "real": not overlaid.get("blue/dry-run")}
    state = (await once_compute.read_state(overlaid, state_output)
             if once_compute.lifecycle_event(context) else {})

    # The machine key's create matrix and the provider preflight run before
    # any template is rendered: an unowned key on disk or at the provider
    # stops the run while stopping is still free. Delete fills the same
    # template values — a destroy renders before it destroys — and adopts the
    # recorded address, but checks no key, because its key cleanup runs after
    # the compute destroy.
    async def after(opts, _env, ctx):
        real, event = ctx["real"], ctx["event"]
        if real and event == "delete":
            return adopt_state(opts, state)
        if real and event == "create":
            async def recorded(_opts):
                return state.get("params")
            opts = await ssh.ensure_key(opts, recorded)
            if failed(opts):
                return opts
            opts = ssh.preflight(ssh.with_machine_key(opts))
            if failed(opts):
                return opts
            opts = ssh_config.preflight(opts)
            if failed(opts):
                return opts
            return {**opts, "blue/exit": 0}
        return {**ssh.with_machine_key(opts), "blue/exit": 0}

    checked = await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=environment,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            # Standard §4 before the credentials: a recorded provider that
            # differs from the selected one reports the actionable error, not
            # a missing token for the provider that was just selected. The
            # thunk carries the event: a delete needs the infrastructure
            # credentials, a create the application's too.
            lambda o, _e, c: (once_compute.provider_validator(
                validate.spec, o, state.get("params"),
                lambda: validate.secret_errors(o, str(c["event"])))
                if once_compute.lifecycle_event(c) else []),
            lambda o, _e, c: (["delete is blocked by COMPUTE_PREVENT_DESTROY; use the "
                               "authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)
    if failed(checked):
        return checked
    return _with_application_shape(checked)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "dbos/start": (start_step, "dbos/ansible-cleanup"),
            # The remote stage only renders on delete; it reads the adopted
            # address through once/compute-params.
            "dbos/ansible-cleanup": (tools.ansible_remote_step, "dbos/dns"),
            # The `~/.ssh/config` block goes before the destroy, the opposite
            # of the keypair below. A block that outlives its host is stale but
            # harmless; a key that predeceases its host locks the operator out
            # of a machine that still exists. Both orders are deliberate; see
            # standards/ssh-config.md.
            "dbos/dns": (once_tools.tofu_dns_step, "dbos/ssh-config"),
            "dbos/ssh-config": (tools.ansible_local_step, "dbos/compute"),
            # The keypair goes strictly after the compute destroy: a key that
            # predeceases its host locks the operator out of a machine that
            # still exists (SSH Keypair Standard §3.3).
            "dbos/compute": (tools.tofu_compute_step, "dbos/ssh-cleanup"),
            "dbos/ssh-cleanup": (ssh.cleanup_step,),
        }.get(step)
    return {
        "dbos/start": (start_step, "dbos/compute"),
        # After compute, which is where the address first exists, and before
        # the stage that converges the machine.
        "dbos/compute": (tools.tofu_compute_step, "dbos/ssh-config"),
        "dbos/ssh-config": (tools.ansible_local_step, "dbos/dns"),
        "dbos/dns": (once_tools.tofu_dns_step, "dbos/ansible-remote"),
        "dbos/ansible-remote": (tools.ansible_remote_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda opts, tool=tool: tools.tool_dir(opts, tool),
        key=lambda opts, tool=tool: f"{opts.get('profile') or 'dbos'}/{tool}.tfstate")


side_effecting_steps = ["dbos/compute", "dbos/ssh-config", "dbos/dns",
                        "dbos/ansible-remote", "dbos/ansible-cleanup", "dbos/ssh-cleanup"]


def create_workflow():
    wf = workflow(start="dbos/start", wire_fn=wire_fn)
    wf = advice_add(wf, "dbos/compute", "before", "dbos.workflow/backend",
                    backend_advice(tools.COMPUTE_TOOL))
    wf = advice_add(wf, "dbos/dns", "before", "dbos.workflow/backend",
                    backend_advice(tools.DNS_TOOL))
    return dry_run.advise(progress.advise(wf), side_effecting_steps)


dbos_workflow = create_workflow()
