from unittest.mock import AsyncMock
import pytest
from blue.workflow import run
from package_dbos_blue import machine, workflow, validate

@pytest.mark.asyncio
async def test_repeated_delete_stops_after_validated_inspection(monkeypatch, tmp_path):
    reads = AsyncMock(return_value={"status": "destroyed"})
    monkeypatch.setattr(machine, "read_deployment", reads)
    monkeypatch.setattr(validate, "state_errors", lambda opts: [])
    credentials = []
    monkeypatch.setattr(validate, "secret_errors", lambda *args: credentials.append(True) or [])
    original = workflow.wire_fn
    def guarded(step, opts):
        assert step == "dbos/start", "destroyed deployment reached cleanup or compute"
        return original(step, opts)
    from dataclasses import replace
    wf = replace(workflow.dbos_workflow, wire_fn=guarded)
    result = await run(wf, {"blue/event": "delete", "profile": "absent-keys", "workdir": str(tmp_path), "compute-prevent-destroy": False})
    assert result["blue/exit"] == 0
    assert result["colors-compute/already-destroyed"] is True
    assert credentials and reads.await_count == 1
    assert list(tmp_path.iterdir()) == []
    assert (await machine.load({"blue/event":"create"}, {}))["blue/exit"] == 1

@pytest.mark.asyncio
async def test_credentials_and_failures_still_stop(monkeypatch):
    monkeypatch.setattr(validate, "state_errors", lambda opts: [])
    monkeypatch.setattr(validate, "secret_errors", lambda *args: ["required credential absent"])
    reader = AsyncMock(side_effect=AssertionError("must not inspect before credentials"))
    monkeypatch.setattr(machine, "read_deployment", reader)
    result = await workflow.start_step({"blue/event":"delete", "compute-prevent-destroy":False}, {})
    assert result["blue/exit"] != 0
    reader.assert_not_awaited()
    assert workflow.next_fn("x", ["y"], {"blue/exit":1}) == []
    opts={"blue/exit":0}
    assert workflow.next_fn("x", ["y"], opts) == [("y",opts)]
