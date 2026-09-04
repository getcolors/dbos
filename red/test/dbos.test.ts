import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderTemplate } from "red/scaffold";
import { StepError, type Opts } from "red/workflow";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const keygenFile = join(import.meta.dir, "../../test/fixtures/keygen.yml");
const templateSource = join(import.meta.dir, "../resources/tools/infrastructure/digitalocean/main.tf");

function readFixture(path: string, overrides: Opts): Opts {
  return { ...(Bun.YAML.parse(readFileSync(path, "utf8")) as Opts), ...overrides };
}

// Opt-out mode (an explicit key id, a name equal to the profile: the shape of
// the live dbos-digitalocean deployment) and keygen mode (no
// `digitalocean-ssh-keys`, no `digitalocean-name`).
const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const keygen = (overrides: Opts = {}) => readFixture(keygenFile, overrides);

// ~/.ssh redirection: ONCE's ssh module and this package's ssh-config both
// read $HOME at call time, exactly so tests can point them at a fresh
// temporary home. Nothing here may touch the real one.
let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "dbos-red-test"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The compute template, rendered as `build` would.
function render(opts: Opts): string {
  return renderTemplate(tools.computeTemplate(opts), tools.computeData(opts), tools.templateOpts);
}

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(keygen())).toEqual([]);
  });

  test("the spec carries this package's registry, sources and default", () => {
    // The operations are ONCE's; this is the data they run over. A colour
    // whose registry, sources or default drifts fails here, in that colour.
    expect(Object.keys(validate.spec.registry)).toEqual(["digitalocean"]);
    expect(validate.spec.registry).toBe(validate.computeProviders);
    expect(validate.spec.registry.digitalocean).toEqual({
      required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                 "digitalocean-ssh-sources", "digitalocean-http-sources"],
      secrets: ["do-token"],
      tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    });
    expect(validate.spec.sources).toEqual({ nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources"] });
    // DigitalOcean: the default is what a legacy state without
    // params.provider is, and the dbos-digitalocean state in R2 may hold one.
    expect(validate.spec.default).toBe("digitalocean");
    expect(validate.spec.default).toBe(validate.defaultComputeProvider);
    expect("nameRules" in validate.spec).toBe(false);
  });

  test("compute provider must be one the package has a template for", () => {
    expect(validate.stateErrors(fixture({ "provider-compute": "vultr" })))
      .toContain(":provider-compute must be one of digitalocean");
  });

  test("name and machine key are never required", () => {
    const required = validate.spec.registry.digitalocean!.required;
    expect(required).not.toContain("digitalocean-name");
    expect(required).not.toContain("digitalocean-ssh-keys");
    const { "digitalocean-name": _n, "digitalocean-ssh-keys": _k, ...rest } = fixture();
    expect(validate.stateErrors(rest)).toEqual([]);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(keygen())).toBe(true);
    expect(validate.keygen(fixture())).toBe(false);
    expect(validate.keygen(fixture({ "digitalocean-ssh-keys": null }))).toBe(true);
  });

  test("compute name falls back to the profile", () => {
    expect(validate.computeName(keygen())).toBe("dbos-keygen-fixture");
    expect(validate.computeName(fixture())).toBe("dbos-fixture");
    expect(validate.computeName(fixture({ "digitalocean-name": "other" }))).toBe("other");
  });

  test("ssh sources must not be empty; no public HTTP is fine", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": [] })))
      .toContain(":digitalocean-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "digitalocean-http-sources": [] }))).toEqual([]);
  });

  test("malformed sources are refused before any provider call", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": ["bad"] })))
      .toContain(':digitalocean-ssh-sources entry "bad" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "digitalocean-http-sources": ["10.0.0.0/33"] })))
      .toContain(':digitalocean-http-sources entry "10.0.0.0/33" is not an IPv4 or IPv6 CIDR');
  });

  test("vpc configuration is refused with ONCE's wording", () => {
    const errors = validate.stateErrors(fixture({ "digitalocean-vpc-uuid": "u", "digitalocean-vpc-cidr": "c" }));
    expect(errors).toContain(":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime");
    expect(errors).toContain(":digitalocean-vpc-cidr must be absent; this package must not create a VPC");
  });

  test("retired keys are accepted and ignored", () => {
    expect(validate.retiredKeys).toEqual([
      "digitalocean-ssh-key-name", "digitalocean-ssh-private-key",
      "digitalocean-ssh-authorized-keys", "digitalocean-https-sources",
      "digitalocean-vpc-mode",
    ]);
    expect(validate.stateErrors(fixture({
      "digitalocean-ssh-key-name": "vaultwarden-digitalocean",
      "digitalocean-ssh-private-key": "~/.ssh/id_ed25519",
      "digitalocean-ssh-authorized-keys": "~/.ssh/id_ed25519.pub",
      "digitalocean-https-sources": ["not-a-cidr"],
      "digitalocean-vpc-mode": "created",
    }))).toEqual([]);
    const stripped = fixture();
    for (const key of validate.retiredKeys) delete stripped[key];
    expect(validate.stateErrors(stripped)).toEqual([]);
  });

  test("reports all detected errors", () => {
    const errors = validate.stateErrors(fixture({
      "dbos-host": "bad",
      "dbos-version": "latest",
      "dbos-durable-delay-seconds": 0,
      "dbos-system-database-pool-size": 2,
      "digitalocean-vpc-uuid": "hard-coded",
      "digitalocean-ssh-sources": ["bad"],
    }));
    const text = errors.join("\n");
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const fragment of ["hostname", "exact semantic", "positive integer", "at least 5",
                            "must be absent", "is not an IPv4 or IPv6 CIDR"]) {
      expect(text).toContain(fragment);
    }
  });

  test("exact official image is required", () => {
    expect(validate.stateErrors(fixture({ "dbos-image": "ghcr.io/getcolors/dbos" }))
      .some((error) => error.includes("explicit tag"))).toBe(true);
    expect(validate.stateErrors(fixture({ "dbos-image": "ghcr.io/getcolors/dbos:4.24.0" }))
      .some((error) => error.includes("must match"))).toBe(true);
    expect(validate.stateErrors(fixture({
      "dbos-image": "ghcr.io/getcolors/dbos@sha256:e4824320dc6f4f7b542fb364d977b39341ac8dd892e1a30d09ce6a89af3130a6",
    }))).toEqual([]);
  });

  test("profile overlay is refused", () => {
    expect(validate.profilePar).toBe("COLORS_PAR_PROFILE");
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBeGreaterThan(0);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("credentials are aggregated", () => {
    const text = validate.secretErrors(fixture()).join("\n");
    for (const name of ["DO_TOKEN", "CLOUDFLARE_API_TOKEN", "DBOS_POSTGRES_PASSWORD",
                        "POSTGRES_BACKUP_R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
      expect(text).toContain(name);
    }
  });

  test("credentials follow the event", () => {
    // A delete renders the remote stage and never runs its play, so the
    // application secrets Ansible would look up are not demanded of it; the
    // infrastructure credentials are, on both events.
    const create = validate.secretErrors(fixture(), "create").join("\n");
    expect(create).toContain("COLORS_PAR_DBOS_POSTGRES_PASSWORD");
    expect(create).toContain("COLORS_PAR_DO_TOKEN");
    const del = validate.secretErrors(fixture(), "delete").join("\n");
    expect(del).not.toContain("COLORS_PAR_DBOS_POSTGRES_PASSWORD");
    expect(del).not.toContain("POSTGRES_BACKUP_R2");
    for (const name of ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                        "COLORS_PAR_R2_ACCESS_KEY_ID", "COLORS_PAR_R2_SECRET_ACCESS_KEY"]) {
      expect(del).toContain(name);
    }
  });

  test("compute credentials and environment follow the registry", () => {
    expect(validate.tofuEnv(fixture(), "provider-compute")).toEqual({ "do-token": "DIGITALOCEAN_TOKEN" });
    expect(validate.tofuEnv(fixture({ "provider-compute": "vultr" }), "provider-compute")).toEqual({});
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("adapter builds production application", () => {
    const app = (tools.withOnceShape(fixture()).once as any).applications[0];
    const env = app.env.join("\n");
    expect(app.host).toBe("dbos.example.com");
    expect(app.image).toBe("ghcr.io/getcolors/dbos:4.25.14");
    expect("github" in app).toBe(false);
    expect(env).toContain("DBOS_APPLICATION_VERSION=4.25.14");
    expect(env).toContain("DBOS_SYSTEM_DATABASE_POOL_SIZE=10");
    expect(env).toContain("COLORS_PAR_DBOS_POSTGRES_PASSWORD");
    expect(env).toContain("COLORS_PAR_POSTGRES_BACKUP_R2_ACCESS_KEY_ID");
    expect(env).not.toContain("secret-value");
  });

  test("default vpc is rendered as runtime data source", () => {
    const source = readFileSync(templateSource, "utf8");
    expect(source).toContain('data "digitalocean_vpc" "default"');
    expect(source).toContain('region = "<{ digitalocean-region }>"');
    expect(source).toContain("vpc_uuid = data.digitalocean_vpc.default.id");
    expect(source).not.toContain('resource "digitalocean_vpc"');
  });

  test("the template lives under the provider directory and never branches on it", () => {
    expect(tools.computeTemplate(fixture()).name).toBe("infrastructure/digitalocean/main.tf");
    const source = readFileSync(templateSource, "utf8");
    expect(source).not.toContain("provider-compute");
    expect(source).toContain("<% if ssh-keygen %>");
  });

  test("the stage names are ONCE's and the local one is this package's", () => {
    expect(tools.computeTool).toBe("tofu-compute");
    expect(tools.dnsTool).toBe("tofu-dns");
    expect(tools.ansibleLocalTool).toBe("dbos-ansible-local");
  });

  test("keygen mode declares the key resource and references it by attribute", () => {
    const main = render(keygen({ "red/event": "build" }));
    expect(main).toContain('resource "digitalocean_ssh_key" "machine"');
    expect(main).toContain('name       = "dbos-keygen-fixture"');
    expect(main).toContain("ssh_keys = [digitalocean_ssh_key.machine.id]");
    expect(main).toContain("ssh_key_id = digitalocean_ssh_key.machine.id");
    expect(main).toContain('private_key = file("');
  });

  test("opt-out mode keeps the literal id and relies on the agent", () => {
    const main = render(fixture({ "red/event": "build" }));
    expect(main).not.toContain("digitalocean_ssh_key");
    expect(main).toContain('ssh_keys = ["00000000"]');
    expect(main).not.toContain("ssh_key_id");
    expect(main).not.toContain("private_key");
    expect(main).not.toContain("pathexpand");
  });

  test("the machine and firewall keep their addresses and are named from one value", () => {
    const main = render(fixture({ "digitalocean-name": "custom" }));
    expect(main).toContain('resource "digitalocean_droplet" "node1"');
    expect(main).toContain('resource "digitalocean_firewall" "node1"');
    expect(main.match(/name\s+= "custom"/g)?.length).toBe(3);
    expect(main).toContain('name     = "custom"\n    user');
    expect(main).toContain("postcondition");
    expect(main).toContain("vpc_uuid = data.digitalocean_vpc.default.id");
  });

  test("the firewall admits 22 and http from the two source lists", () => {
    const main = render(fixture());
    expect(main).toContain('port_range       = "22"\n    source_addresses = ["129.159.242.163/32"]');
    expect(main).toContain('for_each = length(["0.0.0.0/0", "::/0"]) > 0 ? [');
    expect(main).toContain('{ protocol = "tcp", port_range = "80" }');
    expect(main).toContain('{ protocol = "tcp", port_range = "443" }');
    expect(main).not.toContain('udp", port_range');
    expect(main).not.toContain("https-sources");
    expect(render(fixture({ "digitalocean-http-sources": [] }))).toContain("for_each = length([]) > 0 ? [");
  });

  test("params carry the provider", () => {
    const main = render(fixture());
    expect(main).toContain('provider = "digitalocean"');
    expect(main).toContain("ip       = digitalocean_droplet.node1.ipv4_address");
  });

  test("build bridges the documentation address to ONCE's stages", async () => {
    // A build renders against the fallback params and hands the same map to
    // ONCE's dns and remote stages as once/compute-params -- never the
    // pre-standard 192.168.0.1.
    const work = mkdtempSync(join(tmpdir(), "dbos-red-build"));
    try {
      const result = await tools.tofuComputeStep(fixture({ workdir: work, "red/event": "build" }));
      expect(result["red/exit"]).toBe(0);
      expect(result.ip).toBe("192.0.2.10");
      expect(result["once/compute-params"]).toEqual({
        provider: "digitalocean", ip: "192.0.2.10", user: "root", sudoer: "root", name: "dbos-fixture",
      });
      expect(existsSync(join(work, "dbos-fixture", "tofu-compute", "main.tf"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a real converge refuses a missing ip", () => {
    const fallback = tools.fallbackParams(fixture());
    expect(tools.resolvedCompute({}, fallback, undefined)["red/exit"]).toBe(1);
    expect(String(tools.resolvedCompute({}, fallback, { provider: "digitalocean" })["red/err"]))
      .toContain("compute produced no ip output; refusing to converge against the documentation address");
    const resolved = tools.resolvedCompute({}, fallback, { ip: "203.0.113.9", provider: "digitalocean" });
    expect(resolved.ip).toBe("203.0.113.9");
    expect(resolved.user).toBe("root");
  });

  test("with compute params sets the key ONCE's stages read", () => {
    expect(tools.withComputeParams({}, { ip: "203.0.113.9" })["once/compute-params"]).toEqual({ ip: "203.0.113.9" });
  });

  test("compute credentials reach tofu only when set", () => {
    expect(tools.computeCredentialEnv(fixture())).toBeUndefined();
    const env = tools.computeCredentialEnv(fixture({ "do-token": "t", "r2-access-key-id": "a", "r2-secret-access-key": "s" }));
    expect(env?.DIGITALOCEAN_TOKEN).toBe("t");
    expect(env?.AWS_ACCESS_KEY_ID).toBe("a");
  });

  test("once.yml keeps green's select-keys semantics for the absent smtp password", async () => {
    const opts = await workflow.startStep(fixture({ "red/event": "build" }), {});
    const rendered = tools.ansibleOnce(opts);
    expect(rendered).toContain('smtp_server: "127.0.0.1"');
    expect(rendered).toContain('smtp_username: "unused"');
    expect(rendered).not.toContain("smtp_password");
  });
});

// --- ssh ---------------------------------------------------------------------

describe("ssh", () => {
  // The matrix itself is ONCE's and tested there; these prove the delegation
  // with this package's fixtures: absence of `digitalocean-ssh-keys` selects
  // keygen, a build renders the placeholder path and never names $HOME,
  // opt-out passes through untouched, and the create matrix, the preflight
  // and the cleanup reach ONCE.
  test("build renders a stable placeholder path", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "build" }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    expect(opts["digitalocean-ssh-keys"]).toBe(opts["ssh-public-key-path"]);
    expect(String(opts["ssh-private-key-path"])).not.toContain(home);
  });

  test("a dry-run renders the placeholder too", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create", "red/dry-run": true }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
  });

  test("real events render the real path", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create" }));
    expect(opts["ssh-private-key-path"]).toBe(join(home, ".ssh", "dbos-keygen-fixture"));
    expect(opts["ssh-public-key-path"]).toBe(join(home, ".ssh", "dbos-keygen-fixture.pub"));
  });

  test("opt-out passes through untouched", () => {
    for (const event of ["build", "create", "delete"]) {
      const opts = ssh.withMachineKey(fixture({ "red/event": event }));
      expect(opts["digitalocean-ssh-keys"]).toBe("00000000");
      expect(opts["ssh-public-key-path"]).toBeUndefined();
      expect(opts["ssh-keygen"]).toBeUndefined();
    }
  });

  test("identity args select the generated key only in keygen mode", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create" }));
    expect(ssh.identityArgs(opts)).toEqual(["-o", "IdentitiesOnly=yes", "-i", String(opts["ssh-private-key-path"])]);
    expect(ssh.identityArgs(ssh.withMachineKey(fixture({ "red/event": "create" })))).toEqual([]);
  });

  test("first create generates the keypair", async () => {
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => undefined);
    const prv = join(home, ".ssh", "dbos-keygen-fixture");
    const pub = `${prv}.pub`;
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(prv)).toBe(true);
    expect(existsSync(pub)).toBe(true);
    expect(readFileSync(pub, "utf8")).toContain("ssh-ed25519");
    expect(readFileSync(pub, "utf8")).toContain("dbos-keygen-fixture managed by Colors");
    expect(statSync(prv).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  test("a key without state is never overwritten", async () => {
    const prv = join(home, ".ssh", "dbos-keygen-fixture");
    write(prv, "irreplaceable");
    write(`${prv}.pub`, "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("no compute state is readable");
    expect(String(opts["red/err"])).toContain("survives");
    expect(readFileSync(prv, "utf8")).toBe("irreplaceable");
  });

  test("state without a key is an error", async () => {
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("does not hold the machine key");
  });

  test("opt-out generates nothing", async () => {
    const result = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(result["red/err"]).toBeUndefined();
    expect(existsSync(join(home, ".ssh"))).toBe(false);
  });

  test("preflight lists keys with the DigitalOcean token", async () => {
    const seen: Array<[string, string]> = [];
    const capture = async (provider: string, token: string) => { seen.push([provider, token]); return []; };
    await ssh.preflight(ssh.withMachineKey(keygen({ "red/event": "create",
      "do-token": "do-secret", "vultr-api-key": "wrong" })), capture);
    expect(seen).toEqual([["digitalocean", "do-secret"]]);
  });

  test("preflight refuses a foreign key and says do not delete it", async () => {
    write(join(home, ".ssh", "dbos-keygen-fixture.pub"), "ssh-ed25519 OURS comment");
    const opts = await ssh.preflight(ssh.withMachineKey(keygen({ "red/event": "create" })),
      async () => [{ id: "abc", name: "dbos-keygen-fixture", public: "ssh-ed25519 THEIRS" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("Do not delete it");
  });

  test("preflight is skipped in opt-out mode", async () => {
    const opts = await ssh.preflight(fixture({ "red/event": "create" }),
      async () => { throw new Error("must not be called"); });
    expect(opts["red/err"]).toBeUndefined();
  });

  test("delete removes the keypair; ~/.ssh itself survives", () => {
    write(join(home, ".ssh", "dbos-keygen-fixture"), "private");
    write(join(home, ".ssh", "dbos-keygen-fixture.pub"), "public");
    ssh.cleanupStep(keygen({ "red/event": "delete", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "dbos-keygen-fixture"))).toBe(false);
    expect(existsSync(join(home, ".ssh", "dbos-keygen-fixture.pub"))).toBe(false);
    expect(existsSync(join(home, ".ssh"))).toBe(true);
  });

  test("cleanup is inert on create and in opt-out mode", () => {
    write(join(home, ".ssh", "dbos-keygen-fixture"), "private");
    ssh.cleanupStep(keygen({ "red/event": "create", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "dbos-keygen-fixture"))).toBe(true);
    ssh.cleanupStep(fixture({ "red/event": "delete" }));
    expect(existsSync(join(home, ".ssh", "dbos-keygen-fixture"))).toBe(true);
  });
});

// --- ssh-config --------------------------------------------------------------

describe("ssh-config", () => {
  const configFile = () => join(home, ".ssh", "config");

  test("the alias is the profile and the identity file keeps the tilde", () => {
    expect(sshConfig.hostAlias(fixture())).toBe("dbos-fixture");
    expect(sshConfig.identityFile(fixture())).toBe("~/.ssh/dbos-fixture");
    expect(sshConfig.identityFile(fixture())).not.toContain(home);
  });

  test("the marker is the alias alone, and owned-markers holds only it", () => {
    expect(sshConfig.beginMarker("dbos-digitalocean")).toBe("# BEGIN dbos-digitalocean ANSIBLE MANAGED BLOCK");
    expect(sshConfig.endMarker("dbos-digitalocean")).toBe("# END dbos-digitalocean ANSIBLE MANAGED BLOCK");
    const owned = sshConfig.ownedMarkers("dbos-digitalocean");
    expect([...owned.begin]).toEqual(["# BEGIN dbos-digitalocean ANSIBLE MANAGED BLOCK"]);
    expect([...owned.end]).toEqual(["# END dbos-digitalocean ANSIBLE MANAGED BLOCK"]);
  });

  test("host patterns are read from a Host line", () => {
    expect(sshConfig.hostPatterns("Host dbos-fixture")).toEqual(["dbos-fixture"]);
    expect(sshConfig.hostPatterns("  host   web dbos-fixture  db ")).toEqual(["web", "dbos-fixture", "db"]);
    expect(sshConfig.hostPatterns("    HostName 192.0.2.1")).toBeUndefined();
    expect(sshConfig.hostPatterns("Match host dbos-fixture")).toBeUndefined();
  });

  test("a foreign stanza is found; our own block is not foreign", () => {
    expect(sshConfig.foreignStanzaLine(
      ["Host other", "    HostName 192.0.2.1", "", "Host dbos-fixture"], "dbos-fixture")).toBe(4);
    const alias = "dbos-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, "    HostName 192.0.2.1", sshConfig.endMarker(alias)],
      alias)).toBeUndefined();
  });

  test("a stanza after our block is still foreign", () => {
    const alias = "dbos-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, sshConfig.endMarker(alias), `Host ${alias}`], alias)).toBe(4);
  });

  test("a block under a package-prefixed marker is foreign", () => {
    const alias = "dbos-digitalocean";
    expect(sshConfig.foreignStanzaLine(
      [`# BEGIN dbos ${alias} ANSIBLE MANAGED BLOCK`, `Host ${alias}`, `# END dbos ${alias} ANSIBLE MANAGED BLOCK`],
      alias)).toBe(2);
  });

  test("multi-pattern host lines count; unrelated files are left alone", () => {
    expect(sshConfig.foreignStanzaLine(["Host web dbos-fixture db"], "dbos-fixture")).toBe(1);
    expect(sshConfig.foreignStanzaLine(["Host build", "Host dbos-other"], "dbos-fixture")).toBeUndefined();
  });

  test("an option above the first Host is refused; comments and Host openers are fine", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host a"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# comment", "", "IdentitiesOnly yes", "Host a"])).toBe(3);
    expect(sshConfig.leadingOptionLine(["Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# lead comment", "", "Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Match host b", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# nothing here", ""])).toBeUndefined();
  });

  test("preflight refuses rather than overwrites", () => {
    const refused = sshConfig.preflight(fixture(), {
      adoptError: () => "already declares `Host x`",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    const clean = sshConfig.preflight(fixture(), { adoptError: () => undefined, placementError: () => undefined });
    expect(clean["red/exit"]).toBeUndefined();
  });

  test("adopt error names the file and the line; our own block and a missing file pass", () => {
    expect(sshConfig.adoptError(fixture())).toBeUndefined();
    write(configFile(), "Host other\n    HostName 192.0.2.1\n\nHost dbos-fixture\n    User root\n");
    const error = String(sshConfig.adoptError(fixture()));
    expect(error).toContain(configFile());
    expect(error).toContain("`Host dbos-fixture` at line 4");
    expect(error).toContain("will not overwrite it");
    const alias = "dbos-fixture";
    write(configFile(), `${sshConfig.beginMarker(alias)}\nHost ${alias}\n    HostName 192.0.2.1\n${sshConfig.endMarker(alias)}\n`);
    expect(sshConfig.adoptError(fixture())).toBeUndefined();
  });

  test("placement error names the file and the line and mentions the recovery", () => {
    write(configFile(), "# comment\n\n\nIdentitiesOnly yes\nHost a\n");
    const error = String(sshConfig.placementError(fixture()));
    expect(error).toContain(configFile());
    expect(error).toContain("line 4");
    expect(error).toContain("Host *");
  });

  test("preflight reads the redirected file end to end", () => {
    write(configFile(), "Host dbos-fixture\n    HostName 192.0.2.1\n");
    const refused = sshConfig.preflight(fixture());
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    write(configFile(), "ServerAliveInterval 60\nHost a\n");
    const placed = sshConfig.preflight(fixture());
    expect(placed["red/exit"]).toBe(1);
    expect(String(placed["red/err"])).toContain("line 1");
    write(configFile(), "Host a\n    User root\n");
    expect(sshConfig.preflight(fixture())["red/exit"]).toBeUndefined();
  });

  test("build and dry-run never read the config", async () => {
    // A leading-option file that would refuse a real create must not disturb
    // a build or a dry-run.
    write(configFile(), "ServerAliveInterval 60\nHost dbos-fixture\n");
    for (const opts of [fixture({ "red/event": "build" }),
                        keygen({ "red/event": "build" }),
                        fixture({ "red/event": "create", "red/dry-run": true })]) {
      expect((await workflow.startStep(opts, {}))["red/exit"]).toBe(0);
    }
  });

  test("the local play renders no address and follows keygen mode", () => {
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7" }));
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/dbos-fixture");
    expect(data["ssh-keygen"]).toBe(false);
    expect(tools.ansibleLocalData(keygen())["ssh-keygen"]).toBe(true);
  });

  test("the local stage renders three files", () => {
    const targets = tools.ansibleLocalSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["/ansible.cfg", "/inventory.ini", "/main.yml"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
    expect(targets.every((t) => t.includes("dbos-ansible-local"))).toBe(true);
  });

  test("the rendered play carries the IdentityFile pair only in keygen mode", () => {
    const renderPlay = (opts: Opts) =>
      renderTemplate(tools.template("ansible-local", "main.yml"), tools.ansibleLocalData(opts), tools.templateOpts);
    const keygenPlay = renderPlay(keygen());
    expect(keygenPlay).toContain("IdentityFile ~/.ssh/dbos-keygen-fixture");
    expect(keygenPlay).toContain("IdentitiesOnly yes");
    const optoutPlay = renderPlay(fixture());
    expect(optoutPlay).not.toContain("IdentityFile ~/.ssh/");
    expect(optoutPlay).not.toContain("IdentitiesOnly yes");
    for (const play of [keygenPlay, optoutPlay]) {
      expect(play).toContain("insertbefore: BOF");
      expect(play).toContain("HostName {{ ip }}");
      expect(play).toContain("Host {{ host_alias }}");
      expect(play).toContain("StrictHostKeyChecking accept-new");
      expect(play).not.toMatch(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
    }
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  // The compute state is read once per run, through the injectable reader,
  // on a real create or delete. Every lifecycle test stubs it: undefined is a
  // readable state holding no compute, a map is a recorded `params`, and a
  // throw is a backend that cannot be read.
  const start = (opts: Opts, state: Record<string, unknown> | undefined) =>
    workflow.startStep(opts, {}, async () => state);
  // The shape `red/tofu` throws: the SDK's StepError. Only that is an
  // unreadable backend; anything else propagates as a defect.
  const startUnreadable = (opts: Opts, message = "tofu output failed: no backend") =>
    workflow.startStep(opts, {}, async () => { throw new StepError(message); });
  const infrastructureCredentials = { "do-token": "d", "cloudflare-api-token": "c",
    "r2-access-key-id": "a", "r2-secret-access-key": "s" };
  const credentials = { ...infrastructureCredentials, "dbos-postgres-password": "p",
    "postgres-backup-r2-access-key-id": "k", "postgres-backup-r2-secret-access-key": "s" };

  test("build and dry-run need no credentials", async () => {
    expect((await workflow.startStep(fixture({ "red/event": "build" }), {}))["red/exit"]).toBe(0);
    expect((await workflow.startStep(
      fixture({ "red/event": "create", "red/dry-run": true }), {}))["red/exit"]).toBe(0);
    expect((await workflow.startStep(keygen({ "red/event": "build" }), {}))["red/exit"]).toBe(0);
  });

  test("build and dry-run never touch ~/.ssh or the state", async () => {
    for (const opts of [keygen({ "red/event": "build" }),
                        keygen({ "red/event": "create", "red/dry-run": true }),
                        keygen({ "red/event": "delete", "red/dry-run": true })]) {
      const result = await startUnreadable(opts);
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
    }
  });

  test("the application shape and the smtp shim survive preflight", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "build" }), {});
    expect((result.once as any).applications[0].host).toBe("dbos.example.com");
    expect(result.smtp_server).toBe("127.0.0.1");
    expect((result["once/smtp-params"] as any).domains).toEqual([]);
  });

  test("real create reports all missing credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), undefined);
    expect(result["red/exit"]).toBe(2);
    for (const name of ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                        "COLORS_PAR_DBOS_POSTGRES_PASSWORD", "COLORS_PAR_R2_ACCESS_KEY_ID"]) {
      expect(String(result["red/err"])).toContain(name);
    }
  });

  test("real delete requires the infrastructure credentials only", async () => {
    const result = await start(fixture({ "red/event": "delete", "compute-prevent-destroy": false }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
    expect(String(result["red/err"])).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(String(result["red/err"])).not.toContain("COLORS_PAR_DBOS_POSTGRES_PASSWORD");
  });

  test("delete is protected", async () => {
    const blocked = await start(fixture({ "red/event": "delete" }), undefined);
    expect(blocked["red/exit"]).toBe(2);
    expect(String(blocked["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
    expect((await start(fixture({ ...infrastructureCredentials, "red/event": "delete",
      "compute-prevent-destroy": false }), undefined))["red/exit"]).toBe(0);
  });

  test("a provider switch is refused on create and delete", async () => {
    for (const event of ["create", "delete"]) {
      const result = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { provider: "vultr", ip: "203.0.113.9" });
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"]))
        .toContain("state holds a vultr machine; set provider-compute back to vultr and delete first");
      // The validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected.
      expect(String(result["red/err"])).not.toContain("required credential is not set");
    }
  });

  test("legacy state is accepted on digitalocean", async () => {
    // A state recorded before this package wrote params.provider -- the
    // dbos-digitalocean state in R2 may be one -- is a DigitalOcean machine's.
    for (const event of ["create", "delete"]) {
      const result = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { ip: "203.0.113.9" });
      expect(String(result["red/err"])).not.toContain("state holds");
      expect(String(result["red/err"])).not.toContain("no recorded provider");
      expect(String(result["red/err"])).toContain("required credential is not set");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), { provider: "digitalocean", ip: "203.0.113.9" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("an unreadable backend counts as no state on create", async () => {
    const result = await startUnreadable(fixture({ "red/event": "create" }));
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("could not read");
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // No reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does.
    const work = mkdtempSync(join(tmpdir(), "dbos-red-fresh"));
    try {
      const result = await workflow.startStep(fixture({ workdir: work, "red/event": "create" }), {});
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  const deletableFixture = (overrides: Opts = {}) => fixture({
    "compute-prevent-destroy": false, ...credentials, ...overrides,
  });

  test("delete fails loudly when state is unreadable", async () => {
    const result = await startUnreadable(deletableFixture({ "red/event": "delete" }), "Unauthorized");
    expect(result["red/exit"]).toBe(1);
    expect(String(result["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(result["red/err"])).toContain("Unauthorized");
  });

  test("delete with empty state proceeds without an address", async () => {
    const result = await start(deletableFixture({ "red/event": "delete" }), undefined);
    expect(result["red/exit"]).toBe(0);
    expect(result.ip).toBeUndefined();
    expect(result["once/compute-params"]).toBeUndefined();
  });

  test("a real delete adopts the recorded address into ONCE's params", async () => {
    // The bridge: ONCE's remote and dns stages read once/compute-params, so
    // the adopted params land there as well as at top level.
    const adopted = await start(deletableFixture({ "red/event": "delete" }),
      { provider: "digitalocean", ip: "203.0.113.9", user: "root", sudoer: "root", name: "dbos-fixture" });
    expect(adopted["red/exit"]).toBe(0);
    expect(adopted.ip).toBe("203.0.113.9");
    expect((adopted["once/compute-params"] as any).ip).toBe("203.0.113.9");
    expect((adopted["once/compute-params"] as any).provider).toBe("digitalocean");
  });

  test("graph creates and reverses only required stages", () => {
    const next = (step: string, event: string) =>
      (workflow.wireFn(step, { "red/event": event }) ?? []).slice(1);
    expect(next("dbos/start", "create")).toEqual(["dbos/compute"]);
    expect(next("dbos/compute", "create")).toEqual(["dbos/ssh-config"]);
    expect(next("dbos/ssh-config", "create")).toEqual(["dbos/dns"]);
    expect(next("dbos/dns", "create")).toEqual(["dbos/ansible-remote"]);
    expect(next("dbos/ansible-remote", "create")).toEqual([]);
    expect(next("dbos/start", "delete")).toEqual(["dbos/ansible-cleanup"]);
    expect(next("dbos/ansible-cleanup", "delete")).toEqual(["dbos/dns"]);
  });

  test("delete removes the config block before the destroy", () => {
    const next = (step: string) => (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("dbos/dns")).toEqual(["dbos/ssh-config"]);
    expect(next("dbos/ssh-config")).toEqual(["dbos/compute"]);
    expect(workflow.sideEffectingSteps).toContain("dbos/ssh-config");
  });

  test("delete removes the key after the compute destroy", () => {
    const next = (step: string) => (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("dbos/compute")).toEqual(["dbos/ssh-cleanup"]);
    expect(next("dbos/ssh-cleanup")).toEqual([]);
    expect(workflow.sideEffectingSteps).toContain("dbos/ssh-cleanup");
  });
});
