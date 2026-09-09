"""The graph, the port of io.github.getcolors.dbos.workflow."""

from __future__ import annotations

import os

from blue import dry_run, progress, tofu
from blue.cli import read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from package_once_blue import compute as once_compute
from package_once_blue import tools as once_tools

from . import ssh_config, tools, validate, machine

DEFAULTS = {
    "compute-prevent-destroy": True,
    "provider-compute": validate.default_compute_provider,
    "provider-dns": "cloudflare",
    "provider-smtp": "no-infra",
    "provider-backend": "r2",
    "workdir": ".colors",
}


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
    async def after(opts, environment, ctx):
        if ctx['real'] and ctx['event'] == 'delete':
            return await machine.load(opts, environment)
        if ctx['real'] and ctx['event'] == 'create':
            return ssh_config.preflight(opts)
        return {**opts, "blue/exit": 0}
    checked = await preflight(original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[lambda _o,e,_c: validate.env_errors(e),
                    lambda o,_e,_c: validate.state_errors(o),
                    lambda o,_e,c: validate.secret_errors(o,c['event']) if c['real'] and c['event'] in ('create','delete') else [],
                    lambda o,_e,c: ['delete is blocked by COMPUTE_PREVENT_DESTROY; use the authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override'] if c['real'] and c['event']=='delete' and o.get('compute-prevent-destroy') else []],
        after_validate=after)
    return checked if failed(checked) else _with_application_shape(checked)


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
            "dbos/compute": (tools.tofu_compute_step,),
        }.get(step)
    return {
        "dbos/start": (start_step, "dbos/compute"),
        # After compute, which is where the address first exists, and before
        # the stage that converges the machine.
        "dbos/compute": (tools.tofu_compute_step, "dbos/ssh-config"),
        "dbos/ssh-config": (tools.ansible_local_step, "dbos/dns"),
        "dbos/dns": (once_tools.tofu_dns_step, "dbos/bootstrap"),
        "dbos/bootstrap": (tools.bootstrap_step, "dbos/ansible-remote"),
        "dbos/ansible-remote": (tools.ansible_remote_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda opts, tool=tool: tools.tool_dir(opts, tool),
        key=lambda opts, tool=tool: f"{opts.get('profile') or 'dbos'}/{tool}.tfstate")


side_effecting_steps = ["dbos/compute", "dbos/ssh-config", "dbos/dns",
                        "dbos/ansible-remote", "dbos/ansible-cleanup", "dbos/bootstrap"]


def create_workflow():
    wf = workflow(start="dbos/start", wire_fn=wire_fn)
    wf = advice_add(wf, "dbos/dns", "before", "dbos.workflow/backend",
                    backend_advice(tools.DNS_TOOL))
    return dry_run.advise(progress.advise(wf), side_effecting_steps)


dbos_workflow = create_workflow()
