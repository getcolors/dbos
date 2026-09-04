"""Steps and template data, the port of io.github.getcolors.dbos.tools."""

from __future__ import annotations

from importlib.resources import files
from pathlib import Path
from typing import Any

from blue import tofu
from blue.ansible import ansible_step, ansible_with_spec
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from package_once_blue import compute as once_compute
from package_once_blue import tools as once_tools

from . import ssh_config, validate
from .utils import par_lookup, registrable_domain

_RESOURCE_ROOT = Path(__file__).parent / "resources"
_TEMPLATE_OPTS = PRESERVE_JINJA_DELIMITERS
template_opts = _TEMPLATE_OPTS

# The compute and DNS stages keep ONCE's stage names, deliberately. The
# compute stage's name keys the remote state (`<profile>/tofu-compute.tfstate`
# through backend_advice) and the DNS stage is what the deployment knows; the
# Compute Provider Standard constrains the template's source path, not the
# rendered target. The local stage is this package's own and named after it.
COMPUTE_TOOL = "tofu-compute"
DNS_TOOL = "tofu-dns"
ANSIBLE_LOCAL_TOOL = "dbos-ansible-local"


def template(path: str, file: str) -> dict:
    """The template tree this colour carries, keyed the way green names its
    classpath resources: "<path>/<file>" with dots as directories."""
    name = f"tools/{path.replace('.', '/')}/{file}"
    return {"name": name, "content": (_RESOURCE_ROOT / name).read_text()}


def _spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": _TEMPLATE_OPTS}


def tool_dir(opts: dict, tool: str) -> str:
    return once_tools.tool_dir(opts, tool)


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return once_tools.backend_credential_env(opts)


def compute_credential_env(opts: dict) -> dict[str, str] | None:
    """The backend's credentials plus the selected compute provider's, from
    ONCE's registry over this package's spec. Unset credentials are omitted,
    so build and dry-run stay credential-free."""
    env = dict(backend_credential_env(opts) or {})
    for key, env_var in validate.tofu_env(opts, "provider-compute").items():
        value = "" if opts.get(key) is None else str(opts.get(key))
        if value:
            env[env_var] = value
    return env or None


def _str(value) -> str:
    return "" if value is None else str(value)


def app_env(opts: dict) -> list[str]:
    return [
        "DBOS_POSTGRES_PASSWORD=" + par_lookup("dbos-postgres-password"),
        "DBOS_APPLICATION_NAME=" + _str(opts.get("dbos-application-name")),
        "DBOS_APPLICATION_VERSION=" + _str(opts.get("dbos-version")),
        "DBOS_SYSTEM_DATABASE_POOL_SIZE=" + _str(opts.get("dbos-system-database-pool-size")),
        "DBOS_DURABLE_DELAY_SECONDS=" + _str(opts.get("dbos-durable-delay-seconds")),
        "DBOS_STEP_MAX_ATTEMPTS=" + _str(opts.get("dbos-step-max-attempts")),
        "DBOS_STEP_INITIAL_RETRY_SECONDS=" + _str(opts.get("dbos-step-initial-retry-seconds")),
        "DBOS_WORKFLOW_RETENTION_DAYS=" + _str(opts.get("dbos-workflow-retention-days")),
        "POSTGRES_DB=" + _str(opts.get("postgres-database")),
        "POSTGRES_USER=dbos",
        "POSTGRES_PASSWORD=" + par_lookup("dbos-postgres-password"),
        "BACKUP_R2_BUCKET=" + _str(opts.get("postgres-backup-r2-bucket")),
        "BACKUP_R2_ENDPOINT=" + _str(opts.get("postgres-backup-r2-endpoint")),
        "BACKUP_R2_REGION=" + _str(opts.get("postgres-backup-r2-region")),
        "BACKUP_R2_PREFIX=" + _str(opts.get("postgres-backup-r2-prefix")),
        "BACKUP_RETENTION_DAYS=" + _str(opts.get("postgres-backup-retention-days")),
        "BACKUP_ONCALENDAR=" + _str(opts.get("postgres-backup-oncalendar")),
        "BACKUP_R2_ACCESS_KEY_ID=" + par_lookup("postgres-backup-r2-access-key-id"),
        "BACKUP_R2_SECRET_ACCESS_KEY=" + par_lookup("postgres-backup-r2-secret-access-key"),
    ]


def with_once_shape(opts: dict) -> dict:
    return {**opts, "once": {"applications": [{
        "host": opts.get("dbos-host"),
        "image": opts.get("dbos-image"),
        "env": app_env(opts),
    }]}}


# ---------------------------------------------------------------- compute

# What `build` and `--dry-run` render in place of a compute output: the
# documentation address, shaped like the real `params` so every later stage
# sees the same keys either way. ONCE's.
fallback_params = once_compute.fallback_params

# Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute output
# carries no `ip`. ONCE's; `tofu_compute_step` is what wires it.
resolved_compute = once_compute.resolved_compute


def with_compute_params(opts: dict, params: dict) -> dict:
    """The bridge to ONCE's composed stages. `once_tools.tofu_dns_step` and the
    remote stage read the machine's address, user and name as
    `once/compute-params`, the key ONCE's own compute step sets; this
    package's compute step sets it from the same params it merges at top level
    — real, fallback, or, on delete, the ones adopted from state — so the
    ONCE stages keep working unchanged."""
    return {**opts, "once/compute-params": params}


def compute_data(opts: dict) -> dict:
    """Template values for the compute stage. The name, the keypair mode and
    the source lists are resolved here once, so the template interpolates
    values and never branches on which provider it belongs to."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "compute-name": validate.compute_name(opts),
            "ssh-sources-hcl": tofu.hcl_list(
                validate.cidrs(opts, validate.compute_key(opts, "ssh-sources"))),
            "http-sources-hcl": tofu.hcl_list(
                validate.cidrs(opts, validate.compute_key(opts, "http-sources")))}


def compute_template(opts: dict) -> dict:
    """Providers are selected by template directory, `infrastructure/<provider>/`,
    not by conditionals inside one file; the rendered target is the same
    `tofu-compute/main.tf` whichever directory it came from."""
    return template(f"infrastructure.{opts.get('provider-compute')}", "main.tf")


async def tofu_compute_step(opts: dict) -> dict:
    dir = tool_dir(opts, COMPUTE_TOOL)
    specs = [_spec(compute_template(opts), f"{dir}/main.tf", compute_data(opts))]
    result = await tofu.tofu_with_spec(opts, specs, dir=dir, env=compute_credential_env(opts))
    fallback = fallback_params(opts)
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return with_compute_params({**result, **fallback}, fallback)
    if opts.get("blue/event") == "delete":
        return result
    outputs = once_compute.output_params(result)
    resolved = resolved_compute(result, fallback, outputs)
    if (resolved.get("blue/exit") or 0) > 0:
        return resolved
    return with_compute_params(resolved, {**fallback, **(outputs or {})})


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ANSIBLE_LOCAL_TOOL)
    data = ansible_local_data(opts)
    return [_spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ANSIBLE_LOCAL_TOOL)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------------------
# The ansible-remote stage.
#
# Green delegates this stage to io.github.getcolors.once.tools entirely. Blue
# cannot: ONCE at the pinned rev builds its once.yml smtp map with a dict
# comprehension over {smtp_server, smtp_port, smtp_username, smtp_password},
# so a desired state that sets no SMTP password — this package's, whose relay
# is the loopback placeholder — renders `smtp_password: null` where green's
# select-keys omits the key. The stage is therefore assembled here from ONCE's
# own exported pieces (templates, inventory, deploy keys) with green's
# select-keys semantics for the smtp map; byte parity with the committed
# goldens is the proof.


def _once_template(name: str) -> dict:
    content = files("package_once_blue").joinpath(f"resources/tools/{name}").read_text()
    return {"name": f"once/tools/{name}", "content": content}


def _data(opts: dict) -> dict:
    return {**opts, "sudoer": opts.get("sudoer") or "root",
            "hosts": [opts.get("ip") or "64.227.72.100"], "users": []}


# The yaml writer ONCE's colours share, copied because ONCE does not export it.
def _yaml_scalar(value: Any) -> str | None:
    import json
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list) and not value:
        return "[]"
    if isinstance(value, dict) and not value:
        return "{}"
    return None


def _yaml_lines(value: Any, indent: int = 0) -> list[str]:
    scalar = _yaml_scalar(value)
    if scalar is not None:
        return [" " * indent + scalar]
    if isinstance(value, list):
        lines: list[str] = []
        for item in value:
            child = _yaml_lines(item, indent + 2)
            prefix = " " * (indent + 2)
            lines.append(" " * indent + "- " + child[0][len(prefix):])
            lines.extend(child[1:])
        return lines
    lines = []
    for key, nested in value.items():
        nested_scalar = _yaml_scalar(nested)
        if nested_scalar is not None:
            lines.append(f"{' ' * indent}{key}: {nested_scalar}")
        else:
            lines.append(f"{' ' * indent}{key}:")
            lines.extend(_yaml_lines(nested, indent + 2))
    return lines


def _yaml(value: Any) -> str:
    return "\n".join(_yaml_lines(value)) + "\n"


def _resolve_env(env: Any) -> Any:
    return [f"{name}={par_lookup(str(key))}" for name, key in env.items()] if isinstance(env, dict) else env


def ansible_once(opts: dict) -> str:
    # Green's select-keys: a key absent from opts stays absent from the map, so
    # an unset smtp_password renders no line at all.
    smtp = {key: opts[key]
            for key in ["smtp_server", "smtp_port", "smtp_username", "smtp_password"]
            if key in opts}
    password_key = {"resend": "resend-password", "no-infra": "no-infra-smtp-password"}.get(
        opts.get("provider-smtp") or "resend")
    if password_key and smtp.get("smtp_password"):
        smtp["smtp_password"] = par_lookup(password_key)
    once = opts.get("once") or {}
    apps = []
    for app in once.get("applications", []):
        # github never reaches the host. It says where the deploy credentials
        # are published, which is no business of the module reconciling
        # containers.
        without_github = {k: v for k, v in app.items() if k != "github"}
        configured = {**without_github, **smtp,
                      "smtp_from": f"Info <info@notifications.{registrable_domain(app['host'])}>"}
        if isinstance(app.get("env"), dict):
            configured["env"] = _resolve_env(app["env"])
        apps.append(configured)
    return _yaml([{"name": "Reconcile ONCE applications", "become": True,
                   "once": {**once, "applications": apps}}])


def _remote_specs(opts: dict) -> list[dict]:
    dir, data = tool_dir(opts, "ansible-remote"), _data(opts)

    def spec(template: dict, target: str) -> dict:
        return {"template": template, "target": target, "data": data, "opts": _TEMPLATE_OPTS}

    return [
        spec(_once_template("ansible/ansible.cfg"), f"{dir}/ansible.cfg"),
        spec(_once_template("ansible/main.yml"), f"{dir}/main.yml"),
        spec(_once_template("ansible/files/authorized-keys"), f"{dir}/files/authorized-keys"),
        content_spec(f"{dir}/deploy_keys", once_tools.deploy_keys_content(opts)),
        spec(_once_template("ansible/files/deploy"), f"{dir}/files/deploy"),
        spec(_once_template("ansible/library/once"), f"{dir}/library/once"),
        content_spec(f"{dir}/inventory.json", once_tools.inventory(data)),
        content_spec(f"{dir}/once.yml", ansible_once(data)),
    ]


async def ansible_remote_step(opts: dict) -> dict:
    dir = tool_dir(opts, "ansible-remote")
    rendered = scaffold(opts, _remote_specs(opts))
    if opts.get("blue/event") in ("build", "delete"):
        return rendered
    return await ansible_step(rendered, dir=dir, inventory="inventory.json",
                              playbooks={"create": "main.yml"}, host_key_checking=False)
