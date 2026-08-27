"""The graph, the port of io.github.getcolors.dbos.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow

from package_once_blue import tools as once_tools

from . import tools, validate

DEFAULTS = {
    "compute-prevent-destroy": True,
    "provider-compute": "digitalocean",
    "provider-dns": "cloudflare",
    "provider-smtp": "no-infra",
    "provider-backend": "local",
    "workdir": ".colors",
}


async def start_step(original: dict, env: dict[str, str] | None = None) -> dict:
    checked = await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o)
                              if c["real"] and c["event"] == "create" else []),
            lambda o, _e, c: (["delete is blocked by COMPUTE_PREVENT_DESTROY; use the "
                               "authorized one-run COLORS_PAR_COMPUTE_PREVENT_DESTROY=false override"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ])
    if failed(checked):
        return checked
    return {
        **tools.with_once_shape(checked),
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


async def ansible_cleanup_step(opts: dict) -> dict:
    return await tools.ansible_remote_step(await once_tools.ansible_local_step(opts))


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "dbos/start": (start_step, "dbos/ansible-cleanup"),
            "dbos/ansible-cleanup": (ansible_cleanup_step, "dbos/dns"),
            "dbos/dns": (once_tools.tofu_dns_step, "dbos/compute"),
            "dbos/compute": (tools.tofu_compute_step,),
        }.get(step)
    return {
        "dbos/start": (start_step, "dbos/compute"),
        "dbos/compute": (tools.tofu_compute_step, "dbos/dns"),
        "dbos/dns": (once_tools.tofu_dns_step, "dbos/ansible-local", "dbos/ansible-remote"),
        "dbos/ansible-local": (once_tools.ansible_local_step,),
        "dbos/ansible-remote": (tools.ansible_remote_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda opts, tool=tool: tools.tool_dir(opts, tool),
        key=lambda opts, tool=tool: f"{opts.get('profile') or 'dbos'}/{tool}.tfstate")


side_effecting_steps = ["dbos/compute", "dbos/dns", "dbos/ansible-local",
                        "dbos/ansible-remote", "dbos/ansible-cleanup"]


def create_workflow():
    wf = workflow(start="dbos/start", wire_fn=wire_fn)
    wf = advice_add(wf, "dbos/compute", "before", "dbos.workflow/backend",
                    backend_advice(tools.COMPUTE_TOOL))
    wf = advice_add(wf, "dbos/dns", "before", "dbos.workflow/backend",
                    backend_advice(tools.DNS_TOOL))
    return dry_run.advise(progress.advise(wf), side_effecting_steps)


dbos_workflow = create_workflow()
