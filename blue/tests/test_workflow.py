from package_dbos_blue import workflow

from conftest import fixture


async def test_build_and_dry_run_need_no_credentials():
    assert (await workflow.start_step(fixture({"blue/event": "build"}), {}))["blue/exit"] == 0
    assert (await workflow.start_step(
        fixture({"blue/event": "create", "blue/dry-run": True}), {}))["blue/exit"] == 0


async def test_real_create_reports_all_missing_credentials():
    result = await workflow.start_step(fixture({"blue/event": "create"}), {})
    assert result["blue/exit"] == 2
    for name in ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                 "COLORS_PAR_DBOS_POSTGRES_PASSWORD", "COLORS_PAR_R2_ACCESS_KEY_ID"]:
        assert name in result["blue/err"]


async def test_delete_is_protected():
    blocked = await workflow.start_step(fixture({"blue/event": "delete"}), {})
    assert blocked["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in blocked["blue/err"]
    assert (await workflow.start_step(
        fixture({"blue/event": "delete", "compute-prevent-destroy": False}), {}))["blue/exit"] == 0


def test_graph_creates_and_reverses_only_required_stages():
    assert list(workflow.wire_fn("dbos/start", {"blue/event": "create"})[1:]) == ["dbos/compute"]
    assert list(workflow.wire_fn("dbos/compute", {"blue/event": "create"})[1:]) == ["dbos/dns"]
    assert list(workflow.wire_fn("dbos/dns", {"blue/event": "create"})[1:]) == [
        "dbos/ansible-local", "dbos/ansible-remote"]
    assert list(workflow.wire_fn("dbos/start", {"blue/event": "delete"})[1:]) == ["dbos/ansible-cleanup"]
    assert list(workflow.wire_fn("dbos/dns", {"blue/event": "delete"})[1:]) == ["dbos/compute"]
