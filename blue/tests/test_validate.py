from conftest import fixture, keygen
from package_dbos_blue import validate


def test_both_fixtures_are_valid():
    assert validate.state_errors(fixture()) == []
    assert validate.state_errors(keygen()) == []


# --- the spec handed to ONCE


def test_the_spec_carries_this_packages_registry_sources_and_default():
    # The operations are ONCE's; this is the data they run over. A colour
    # whose registry, sources or default drifts fails here, in that colour.
    assert set(validate.spec["registry"]) == {"digitalocean"}
    assert validate.spec["registry"] is validate.compute_providers
    assert validate.spec["registry"]["digitalocean"] == {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-ssh-sources", "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    }
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources"],
                                        "may_be_empty": ["http-sources"]}
    # DigitalOcean: the default is what a legacy state without
    # params.provider is, and the dbos-digitalocean state in R2 may hold one.
    assert validate.spec["default"] == "digitalocean"
    assert validate.spec["default"] == validate.default_compute_provider
    assert "name_rules" not in validate.spec, "the name rules are ONCE's"


def test_compute_provider_must_be_one_the_package_has_a_template_for():
    errors = validate.state_errors(fixture({"provider-compute": "vultr"}))
    assert ":provider-compute must be one of digitalocean" in errors


def test_name_and_machine_key_are_never_required():
    required = validate.spec["registry"]["digitalocean"]["required"]
    assert "digitalocean-name" not in required
    assert "digitalocean-ssh-keys" not in required
    stripped = {k: v for k, v in fixture().items()
                if k not in ("digitalocean-name", "digitalocean-ssh-keys")}
    assert validate.state_errors(stripped) == []


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(keygen()) is True
    assert validate.keygen(fixture()) is False
    assert validate.keygen(fixture({"digitalocean-ssh-keys": None})) is True


def test_compute_name_falls_back_to_the_profile():
    assert validate.compute_name(keygen()) == "dbos-keygen-fixture"
    assert validate.compute_name(fixture()) == "dbos-fixture"
    assert validate.compute_name(fixture({"digitalocean-name": "other"})) == "other"


def test_ssh_sources_must_not_be_empty_and_no_public_http_is_fine():
    assert ":digitalocean-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": []}))
    assert validate.state_errors(fixture({"digitalocean-http-sources": []})) == []


def test_malformed_sources_are_refused_before_any_provider_call():
    assert ':digitalocean-ssh-sources entry "bad" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": ["bad"]}))
    assert ':digitalocean-http-sources entry "10.0.0.0/33" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-http-sources": ["10.0.0.0/33"]}))


def test_vpc_configuration_is_refused_with_onces_wording():
    errors = validate.state_errors(fixture({"digitalocean-vpc-uuid": "u",
                                            "digitalocean-vpc-cidr": "c"}))
    assert ":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime" in errors
    assert ":digitalocean-vpc-cidr must be absent; this package must not create a VPC" in errors


def test_retired_keys_are_accepted_and_ignored():
    assert validate.retired_keys == [
        "digitalocean-ssh-key-name", "digitalocean-ssh-private-key",
        "digitalocean-ssh-authorized-keys", "digitalocean-https-sources",
        "digitalocean-vpc-mode",
    ]
    assert validate.state_errors(fixture({
        "digitalocean-ssh-key-name": "vaultwarden-digitalocean",
        "digitalocean-ssh-private-key": "~/.ssh/id_ed25519",
        "digitalocean-ssh-authorized-keys": "~/.ssh/id_ed25519.pub",
        "digitalocean-https-sources": ["not-a-cidr"],
        "digitalocean-vpc-mode": "created",
    })) == []
    stripped = {k: v for k, v in fixture().items() if k not in validate.retired_keys}
    assert validate.state_errors(stripped) == []


# --- the package's own checks


def test_reports_all_detected_errors():
    errors = validate.state_errors(fixture({
        "dbos-host": "bad",
        "dbos-version": "latest",
        "dbos-durable-delay-seconds": 0,
        "dbos-system-database-pool-size": 2,
        "digitalocean-vpc-uuid": "hard-coded",
        "digitalocean-ssh-sources": ["bad"],
    }))
    text = "\n".join(errors)
    assert len(errors) >= 7
    for fragment in ["hostname", "exact semantic", "positive integer", "at least 5",
                     "must be absent", "is not an IPv4 or IPv6 CIDR"]:
        assert fragment in text


def test_exact_official_image_is_required():
    assert any("explicit tag" in error for error in
               validate.state_errors(fixture({"dbos-image": "ghcr.io/getcolors/dbos"})))
    assert any("must match" in error for error in
               validate.state_errors(fixture({"dbos-image": "ghcr.io/getcolors/dbos:4.24.0"})))
    assert validate.state_errors(fixture({
        "dbos-image": "ghcr.io/getcolors/dbos@sha256:"
                      "e4824320dc6f4f7b542fb364d977b39341ac8dd892e1a30d09ce6a89af3130a6",
    })) == []


def test_profile_overlay_is_refused():
    assert validate.PROFILE_PAR == "COLORS_PAR_PROFILE"
    assert validate.env_errors({"COLORS_PAR_PROFILE": "other"})
    assert validate.env_errors({}) == []


def test_credentials_are_aggregated():
    text = "\n".join(validate.secret_errors(fixture()))
    for name in ["DO_TOKEN", "CLOUDFLARE_API_TOKEN", "DBOS_POSTGRES_PASSWORD",
                 "POSTGRES_BACKUP_R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]:
        assert name in text


def test_credentials_follow_the_event():
    # A delete renders the remote stage and never runs its play, so the
    # application secrets Ansible would look up are not demanded of it; the
    # infrastructure credentials are, on both events.
    create = "\n".join(validate.secret_errors(fixture(), "create"))
    assert "COLORS_PAR_DBOS_POSTGRES_PASSWORD" in create
    assert "COLORS_PAR_DO_TOKEN" in create
    delete = "\n".join(validate.secret_errors(fixture(), "delete"))
    assert "COLORS_PAR_DBOS_POSTGRES_PASSWORD" not in delete
    assert "POSTGRES_BACKUP_R2" not in delete
    for name in ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                 "COLORS_PAR_R2_ACCESS_KEY_ID", "COLORS_PAR_R2_SECRET_ACCESS_KEY"]:
        assert name in delete


def test_compute_credentials_and_environment_follow_the_registry():
    assert validate.tofu_env(fixture(), "provider-compute") == {"do-token": "DIGITALOCEAN_TOKEN"}
    assert validate.tofu_env(fixture({"provider-compute": "vultr"}), "provider-compute") == {}
