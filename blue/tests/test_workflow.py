import pytest
from blue.workflow import StepError
from conftest import fixture, keygen
from package_dbos_blue import workflow

# The compute state is read once per run, through `state_output`, on a real
# create or delete. Every lifecycle test stubs it: None is a readable state
# holding no compute, a dict is a recorded `params`, and a raise is a backend
# that cannot be read.

INFRASTRUCTURE_CREDENTIALS = {"do-token": "d", "cloudflare-api-token": "c",
                              "r2-access-key-id": "a", "r2-secret-access-key": "s"}
CREDENTIALS = {**INFRASTRUCTURE_CREDENTIALS, "dbos-postgres-password": "p",
               "postgres-backup-r2-access-key-id": "k",
               "postgres-backup-r2-secret-access-key": "s"}


@pytest.fixture
def state(monkeypatch):
    def install(params):
        async def stub(_opts):
            return params
        monkeypatch.setattr(workflow, "state_output", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    def install(message="tofu output failed: no backend"):
        async def boom(_opts):
            raise StepError(message)
        monkeypatch.setattr(workflow, "state_output", boom)
    install()
    return install


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Redirect `~/.ssh` for the paths that fill the real key paths."""
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


async def test_build_and_dry_run_need_no_credentials():
    assert (await workflow.start_step({**fixture(), "blue/event": "build"}, env={}))["blue/exit"] == 0
    assert (await workflow.start_step(
        {**fixture(), "blue/event": "create", "blue/dry-run": True}, env={}))["blue/exit"] == 0
    assert (await workflow.start_step({**keygen(), "blue/event": "build"}, env={}))["blue/exit"] == 0


async def test_build_and_dry_run_never_touch_ssh_or_state(unreadable):
    for opts in [{**keygen(), "blue/event": "build"},
                 {**keygen(), "blue/event": "create", "blue/dry-run": True},
                 {**keygen(), "blue/event": "delete", "blue/dry-run": True}]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert str(result["ssh-public-key-path"]).startswith("/home/build-placeholder"), \
            "a build must not name the operator's home directory"


async def test_the_application_shape_and_the_smtp_shim_survive_preflight():
    result = await workflow.start_step({**fixture(), "blue/event": "build"}, env={})
    assert result["once"]["applications"][0]["host"] == "dbos.example.com"
    assert result["smtp_server"] == "127.0.0.1"
    assert result["once/smtp-params"]["domains"] == []


async def test_real_create_reports_all_missing_credentials(state):
    state(None)
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    for name in ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                 "COLORS_PAR_DBOS_POSTGRES_PASSWORD", "COLORS_PAR_R2_ACCESS_KEY_ID"]:
        assert name in result["blue/err"]


async def test_real_delete_requires_the_infrastructure_credentials_only(state):
    state(None)
    result = await workflow.start_step(
        {**fixture(), "blue/event": "delete", "compute-prevent-destroy": False}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_CLOUDFLARE_API_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_DBOS_POSTGRES_PASSWORD" not in result["blue/err"]


async def test_delete_is_protected(state):
    state(None)
    blocked = await workflow.start_step({**fixture(), "blue/event": "delete"}, env={})
    assert blocked["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in blocked["blue/err"]
    assert (await workflow.start_step(
        {**fixture(), **INFRASTRUCTURE_CREDENTIALS, "blue/event": "delete",
         "compute-prevent-destroy": False}, env={}))["blue/exit"] == 0


# --- provider switching is a rebuild, never an apply


async def test_a_provider_switch_is_refused_on_create_and_delete(state):
    state({"provider": "vultr", "ip": "203.0.113.9"})
    for event in ["create", "delete"]:
        result = await workflow.start_step(
            {**fixture(), "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert result["blue/exit"] == 2, event
        assert ("state holds a vultr machine; set provider-compute back to vultr "
                "and delete first") in result["blue/err"]
        # The validator order is the thing under test: the actionable error,
        # not a missing token for the provider that was just selected.
        assert "required credential is not set" not in result["blue/err"]


async def test_legacy_state_is_accepted_on_digitalocean(state):
    # A state recorded before this package wrote params.provider -- the
    # dbos-digitalocean state in R2 may be one -- is a DigitalOcean machine's.
    state({"ip": "203.0.113.9"})
    for event in ["create", "delete"]:
        result = await workflow.start_step(
            {**fixture(), "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert "state holds" not in result["blue/err"], event
        assert "no recorded provider" not in result["blue/err"], event
        assert "required credential is not set" in result["blue/err"], event


async def test_a_matching_provider_passes_to_the_credentials(state):
    state({"provider": "digitalocean", "ip": "203.0.113.9"})
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "could not read" not in result["blue/err"]
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # No state stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does.
    result = await workflow.start_step(
        {**fixture(), "workdir": str(tmp_path), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


def deletable_fixture(overrides: dict | None = None) -> dict:
    """A fixture that passes real-delete preflight: guard lifted, secrets
    present."""
    return fixture({"compute-prevent-destroy": False, **CREDENTIALS, **(overrides or {})})


async def test_delete_fails_loudly_when_state_is_unreadable(unreadable):
    unreadable("Unauthorized")
    result = await workflow.start_step({**deletable_fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in result["blue/err"]
    assert "Unauthorized" in result["blue/err"]


async def test_delete_with_empty_state_proceeds_without_an_address(state, home):
    state(None)
    result = await workflow.start_step({**deletable_fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 0
    assert result.get("ip") is None
    assert result.get("once/compute-params") is None


async def test_a_real_delete_adopts_the_recorded_address_into_onces_params(state, home):
    # The bridge: ONCE's remote and dns stages read once/compute-params, so
    # the adopted params land there as well as at top level.
    state({"provider": "digitalocean", "ip": "203.0.113.9", "user": "root",
           "sudoer": "root", "name": "dbos-fixture"})
    adopted = await workflow.start_step({**deletable_fixture(), "blue/event": "delete"}, env={})
    assert adopted["blue/exit"] == 0
    assert adopted["ip"] == "203.0.113.9"
    assert adopted["once/compute-params"]["ip"] == "203.0.113.9"
    assert adopted["once/compute-params"]["provider"] == "digitalocean"


def test_graph_creates_and_reverses_only_required_stages():
    create = {"blue/event": "create"}
    assert workflow.wire_fn("dbos/start", create)[1:] == ("dbos/compute",)
    assert workflow.wire_fn("dbos/compute", create)[1:] == ("dbos/ssh-config",)
    assert workflow.wire_fn("dbos/ssh-config", create)[1:] == ("dbos/dns",)
    assert workflow.wire_fn("dbos/dns", create)[1:] == ("dbos/ansible-remote",)
    assert workflow.wire_fn("dbos/ansible-remote", create)[1:] == ()
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("dbos/start", delete)[1:] == ("dbos/ansible-cleanup",)
    assert workflow.wire_fn("dbos/ansible-cleanup", delete)[1:] == ("dbos/dns",)


def test_delete_removes_the_config_block_before_the_destroy():
    # The opposite of the keypair below: a block that outlives its host is
    # stale but harmless, so removing it early costs nothing.
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("dbos/dns", delete)[1:] == ("dbos/ssh-config",)
    assert workflow.wire_fn("dbos/ssh-config", delete)[1:] == ("dbos/compute",)
    assert "dbos/ssh-config" in workflow.side_effecting_steps


def test_delete_removes_the_key_after_the_compute_destroy():
    # The ordering is what makes "key present <=> deployment exists" hold: a
    # failed destroy never reaches the cleanup step, and correctly leaves the
    # key that is still the only credential to whatever survived.
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("dbos/compute", delete)[1:] == ("dbos/ssh-cleanup",)
    assert workflow.wire_fn("dbos/ssh-cleanup", delete)[1:] == ()
    assert "dbos/ssh-cleanup" in workflow.side_effecting_steps
