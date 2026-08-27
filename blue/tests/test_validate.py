from package_dbos_blue import validate

from conftest import fixture


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_reports_all_detected_errors():
    errors = validate.state_errors(fixture({
        "dbos-host": "bad",
        "dbos-version": "latest",
        "dbos-durable-delay-seconds": 0,
        "dbos-system-database-pool-size": 2,
        "digitalocean-vpc-mode": "created",
        "digitalocean-vpc-uuid": "hard-coded",
        "digitalocean-ssh-sources": ["bad"],
    }))
    text = "\n".join(errors)
    assert len(errors) >= 7
    for fragment in ["hostname", "exact semantic", "positive integer", "at least 5",
                     "must be default", "must not be configured", "invalid CIDR"]:
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
