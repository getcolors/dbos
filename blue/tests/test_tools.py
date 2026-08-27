from pathlib import Path

from package_dbos_blue import tools, workflow

from conftest import fixture


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


def test_default_vpc_is_rendered_as_runtime_data_source():
    source = (Path(__file__).resolve().parents[1]
              / "src/package_dbos_blue/resources/tofu-compute/main.tf").read_text()
    assert 'data "digitalocean_vpc" "default"' in source
    assert 'region = "<{ digitalocean-region }>"' in source
    assert "vpc_uuid = data.digitalocean_vpc.default.id" in source
    assert 'resource "digitalocean_vpc"' not in source


async def test_once_yml_keeps_greens_select_keys_semantics():
    opts = await workflow.start_step(fixture({"blue/event": "build"}), {})
    rendered = tools.ansible_once(opts)
    assert 'smtp_server: "127.0.0.1"' in rendered
    assert 'smtp_username: "unused"' in rendered
    assert "smtp_password" not in rendered
