from pathlib import Path

from blue.scaffold import render_template
from conftest import fixture, keygen
from package_dbos_blue import tools, workflow

TEMPLATE_SOURCE = (Path(__file__).resolve().parents[1]
                   / "src/package_dbos_blue/resources/tools/infrastructure/digitalocean/main.tf")


def _render(opts: dict) -> str:
    return render_template(tools.compute_template(opts), tools.compute_data(opts), tools.template_opts)


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
    source = TEMPLATE_SOURCE.read_text()
    assert 'data "digitalocean_vpc" "default"' in source
    assert 'region = "<{ digitalocean-region }>"' in source
    assert "vpc_uuid = data.digitalocean_vpc.default.id" in source
    assert 'resource "digitalocean_vpc"' not in source


def test_the_template_lives_under_the_provider_directory_and_never_branches_on_it():
    assert tools.compute_template(fixture())["name"] == "tools/infrastructure/digitalocean/main.tf"
    source = TEMPLATE_SOURCE.read_text()
    assert "provider-compute" not in source
    assert "<% if ssh-keygen %>" in source


def test_the_stage_names_are_onces_and_the_local_one_is_this_packages():
    assert tools.COMPUTE_TOOL == "tofu-compute"
    assert tools.DNS_TOOL == "tofu-dns"
    assert tools.ANSIBLE_LOCAL_TOOL == "dbos-ansible-local"


def test_keygen_mode_declares_the_key_resource_and_references_it_by_attribute():
    main = _render({**keygen(), "blue/event": "build"})
    assert 'resource "digitalocean_ssh_key" "machine"' in main
    assert 'name       = "dbos-keygen-fixture"' in main
    assert "ssh_keys = [digitalocean_ssh_key.machine.id]" in main
    assert "ssh_key_id = digitalocean_ssh_key.machine.id" in main
    assert 'private_key = file("' in main


def test_opt_out_mode_keeps_the_literal_id_and_relies_on_the_agent():
    main = _render({**fixture(), "blue/event": "build"})
    assert "digitalocean_ssh_key" not in main
    assert 'ssh_keys = ["00000000"]' in main
    assert "ssh_key_id" not in main
    assert "private_key" not in main
    assert "pathexpand" not in main


def test_the_machine_and_firewall_keep_their_addresses_and_are_named_from_one_value():
    import re
    main = _render(fixture({"digitalocean-name": "custom"}))
    assert 'resource "digitalocean_droplet" "node1"' in main
    assert 'resource "digitalocean_firewall" "node1"' in main
    assert len(re.findall(r'name\s+= "custom"', main)) == 3
    assert 'name     = "custom"\n    user' in main
    assert "postcondition" in main
    assert "vpc_uuid = data.digitalocean_vpc.default.id" in main


def test_the_firewall_admits_22_and_http_from_the_two_source_lists():
    main = _render(fixture())
    assert 'port_range       = "22"\n    source_addresses = ["129.159.242.163/32"]' in main
    assert 'for_each = length(["0.0.0.0/0", "::/0"]) > 0 ? [' in main
    assert '{ protocol = "tcp", port_range = "80" }' in main
    assert '{ protocol = "tcp", port_range = "443" }' in main
    assert 'udp", port_range' not in main
    assert "https-sources" not in main
    assert "for_each = length([]) > 0 ? [" in _render(fixture({"digitalocean-http-sources": []}))


def test_params_carry_the_provider():
    main = _render(fixture())
    assert 'provider = "digitalocean"' in main
    assert "ip       = digitalocean_droplet.node1.ipv4_address" in main


async def test_build_bridges_the_documentation_address_to_onces_stages(tmp_path):
    # A build renders against the fallback params and hands the same map to
    # ONCE's dns and remote stages as once/compute-params -- never the
    # pre-standard 192.168.0.1.
    result = await tools.tofu_compute_step({**fixture(), "workdir": str(tmp_path), "blue/event": "build"})
    assert result["blue/exit"] == 0
    assert result["ip"] == "192.0.2.10"
    assert result["once/compute-params"] == {
        "provider": "digitalocean", "ip": "192.0.2.10", "user": "root", "sudoer": "root",
        "name": "dbos-fixture"}
    assert (tmp_path / "dbos-fixture" / "tofu-compute" / "main.tf").exists()


def test_a_real_converge_refuses_a_missing_ip():
    fallback = tools.fallback_params(fixture())
    assert tools.resolved_compute({}, fallback, None)["blue/exit"] == 1
    assert ("compute produced no ip output; refusing to converge against the documentation address"
            in tools.resolved_compute({}, fallback, {"provider": "digitalocean"})["blue/err"])
    resolved = tools.resolved_compute({}, fallback, {"ip": "203.0.113.9", "provider": "digitalocean"})
    assert resolved["ip"] == "203.0.113.9"
    assert resolved["user"] == "root"


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
