from pathlib import Path

from blue.scaffold import render_template
from conftest import fixture, keygen
from package_dbos_blue import tools, workflow

TEMPLATE_SOURCE = (Path(__file__).resolve().parents[1]
                   / "src/package_dbos_blue/resources/tools/infrastructure/digitalocean/main.tf")


def test_adapter_builds_production_application():
    app = tools.with_once_shape(fixture())["once"]["applications"][0]
    env = "\n".join(app["env"])
    assert app["host"] == "dbos.example.com"
    assert app["image"] == "ghcr.io/getcolors/dbos:4.25.14"
    assert "github" not in app
    assert "DBOS_APPLICATION_VERSION=4.25.14" in env
    assert "DBOS_SYSTEM_DATABASE_POOL_SIZE=10" in env
    assert "COLORS_PAR_DBOS_POSTGRES_PASSWORD" in env
    assert "COLORS_PAR_POSTGRES_BACKUP_R2_ACCESS_KEY_ID" in env
    assert "secret-value" not in env


def test_the_stage_names_are_onces_and_the_local_one_is_this_packages():
    assert tools.COMPUTE_TOOL == "tofu-compute"
    assert tools.DNS_TOOL == "tofu-dns"
    assert tools.ANSIBLE_LOCAL_TOOL == "dbos-ansible-local"


async def test_build_bridges_the_documentation_address_to_onces_stages(tmp_path):
    # A build renders against the fallback params and hands the same map to
    # ONCE's dns and remote stages as once/compute-params -- never the
    # pre-standard 192.168.0.1.
    result = await tools.tofu_compute_step({**fixture(), "workdir": str(tmp_path), "blue/event": "build"})
    assert result["blue/exit"] == 0
    assert result["ip"] == "192.0.2.10"
    assert result['once/compute-params']['ip'] == result['ip']
    assert result['once/compute-params']['node_id'] == '0'
    assert (tmp_path / 'dbos-fixture/tofu-compute/nodes/0/node-none.tf.json').exists()


def test_with_compute_params_sets_the_key_onces_stages_read():
    assert tools.with_compute_params({}, {"ip": "203.0.113.9"})["once/compute-params"] == {"ip": "203.0.113.9"}


def test_compute_credentials_reach_tofu_only_when_set():
    assert tools.compute_credential_env(fixture()) is None
    env = tools.compute_credential_env(fixture({"do-token": "t", "r2-access-key-id": "a",
                                                "r2-secret-access-key": "s"}))
    assert env["DIGITALOCEAN_TOKEN"] == "t"
    assert env["AWS_ACCESS_KEY_ID"] == "a"


async def test_once_yml_keeps_greens_select_keys_semantics():
    opts = await workflow.start_step(fixture({"blue/event": "build"}), {})
    rendered = tools.ansible_once(opts)
    assert 'smtp_server: "127.0.0.1"' in rendered
    assert 'smtp_username: "unused"' in rendered
    assert "smtp_password" not in rendered
