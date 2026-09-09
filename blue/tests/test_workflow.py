from conftest import fixture, keygen
from package_dbos_blue import workflow, machine, tools


async def test_build_and_dry_run_do_not_inspect_or_generate(monkeypatch):
    async def forbidden(*args):
        raise AssertionError('live compute call during planning')
    monkeypatch.setattr(machine, 'read_deployment', forbidden)
    monkeypatch.setattr(machine, 'orchestrate', forbidden)
    for event, dry in [('build', False), ('create', True), ('delete', True)]:
        result = await workflow.start_step(keygen({'blue/event': event, 'blue/dry-run': dry}), {})
        assert result['blue/exit'] == 0
        assert result['once']['applications'][0]['host'] == 'dbos.example.com'
        assert result['once/smtp-params']['smtp_server'] == '127.0.0.1'


async def test_create_credentials_and_delete_guard_are_retained():
    create = await workflow.start_step(fixture({'blue/event':'create'}), {})
    assert create['blue/exit'] == 2
    assert 'COLORS_PAR_DBOS_POSTGRES_PASSWORD' in create['blue/err']
    delete = await workflow.start_step(fixture({'blue/event':'delete'}), {})
    assert delete['blue/exit'] == 2
    assert 'COMPUTE_PREVENT_DESTROY' in delete['blue/err']
    assert 'DBOS_POSTGRES_PASSWORD' not in delete['blue/err']


async def test_inventory_is_required_and_recorded_address_wins(monkeypatch):
    async def absent(opts,env):
        assert env == {'AWS_PROFILE':'fixture'}
        return {'status':'absent'}
    monkeypatch.setattr(machine,'read_deployment',absent)
    result=await machine.load(fixture({'ip':'203.0.113.99'}),{'AWS_PROFILE':'fixture'})
    assert result['blue/exit'] == 1
    async def present(opts,env):
        return {'status':'present','cluster':{'nodes':[{'node_id':'0','name':'provider-label','ip':'203.0.113.8','user':'ubuntu','sudoer':'ubuntu','provider':'digitalocean'}]}}
    monkeypatch.setattr(machine,'read_deployment',present)
    result=await machine.load(fixture({'ip':'203.0.113.99'}),{})
    assert result['ip'] == '203.0.113.8'
    assert result['once/compute-params']['user'] == 'ubuntu'


def test_lifecycle_keeps_bootstrap_and_teardown_order():
    assert workflow.wire_fn('dbos/compute',{'blue/event':'create'}) == (tools.tofu_compute_step,'dbos/ssh-config')
    assert workflow.wire_fn('dbos/dns',{'blue/event':'create'})[1:] == ('dbos/bootstrap',)
    assert workflow.wire_fn('dbos/bootstrap',{'blue/event':'create'}) == (tools.bootstrap_step,'dbos/ansible-remote')
    assert workflow.wire_fn('dbos/ssh-config',{'blue/event':'delete'})[1:] == ('dbos/compute',)
    assert workflow.wire_fn('dbos/compute',{'blue/event':'delete'})[1:] == ()
    assert machine.requirements(fixture())['legacy_state_keys'] == ['dbos-fixture/tofu-compute.tfstate']


def test_retired_keys_are_not_sent_to_the_library():
    opts=keygen({'digitalocean-ssh-authorized-keys':'/tmp/retired.pub','digitalocean-vpc-mode':'retired'})
    assert 'digitalocean-ssh-authorized-keys' not in machine.clean(opts)
    assert machine.errors(opts) == []
    import pytest
    with pytest.raises(ValueError,match='inventory unavailable'):
        machine.fallback_params(opts)
