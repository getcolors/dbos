import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderTemplate } from "red/scaffold";
import { StepError, type Opts } from "red/workflow";

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

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(keygen())).toEqual([]);
  });

  test("name and machine key are never required", () => {
    const required = validate.spec.registry.digitalocean!.required;
    expect(required).not.toContain("digitalocean-name");
    expect(required).not.toContain("digitalocean-ssh-keys");
    const { "digitalocean-name": _n, "digitalocean-ssh-keys": _k, ...rest } = fixture();
    expect(validate.stateErrors(rest)).toEqual([]);
  });

  test("compute name falls back to the profile", () => {
    expect(validate.computeName(keygen())).toBe("dbos-keygen-fixture");
    expect(validate.computeName(fixture())).toBe("dbos-fixture");
    expect(validate.computeName(fixture({ "digitalocean-name": "other" }))).toBe("other");
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

  test("the stage names are ONCE's and the local one is this package's", () => {
    expect(tools.computeTool).toBe("tofu-compute");
    expect(tools.dnsTool).toBe("tofu-dns");
    expect(tools.ansibleLocalTool).toBe("dbos-ansible-local");
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
      expect((result['once/compute-params'] as Opts).ip).toBe(result.ip);
    expect((result['once/compute-params'] as Opts).node_id).toBe('0');
    expect(existsSync(join(work,'dbos-fixture/tofu-compute/nodes/0/node-none.tf.json'))).toBe(true);
    } finally { rmSync(work,{recursive:true,force:true}); }
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
    expect(keygenPlay).toContain('colors_keygen: true');
    const optoutPlay=renderPlay(fixture());
    expect(optoutPlay).toContain('colors_keygen: false');
    expect(optoutPlay).toContain('fcntl.flock');
  });
});


import * as machine from '../src/machine.ts';
test('direct library validation and application lifecycle', async () => {
  expect(Object.keys(validate.computeProviders).length).toBe(8);
  expect(machine.errors(fixture({'provider-compute':'no-infra'})).length).toBeGreaterThan(0);
  expect(machine.errors(fixture({'digitalocean-http-sources':[]}))).toEqual([]);
  expect(machine.errors(fixture({'digitalocean-ssh-sources':[]})).length).toBeGreaterThan(0);
  const planned=await workflow.startStep(keygen({'red/event':'build'}),{});
  expect(planned['red/exit']).toBe(0);
  expect((planned['once/smtp-params'] as Opts).smtp_server).toBe('127.0.0.1');
  const create=await workflow.startStep(fixture({'red/event':'create'}),{});
  expect(create['red/exit']).toBe(2);
  expect(String(create['red/err'])).toContain('COLORS_PAR_DBOS_POSTGRES_PASSWORD');
  const del=await workflow.startStep(fixture({'red/event':'delete'}),{});
  expect(del['red/exit']).toBe(2);
  expect(String(del['red/err'])).toContain('COMPUTE_PREVENT_DESTROY');
  expect(String(del['red/err'])).not.toContain('DBOS_POSTGRES_PASSWORD');
});
test('bootstrap follows compute and DNS; alias cleanup precedes library destroy',()=>{
  expect(workflow.wireFn('dbos/dns',{'red/event':'create'})!.slice(1)).toEqual(['dbos/bootstrap']);
  expect(workflow.wireFn('dbos/bootstrap',{'red/event':'create'})).toEqual([tools.bootstrapStep,'dbos/ansible-remote']);
  expect(workflow.wireFn('dbos/ssh-config',{'red/event':'delete'})!.slice(1)).toEqual(['dbos/compute']);
  expect(workflow.wireFn('dbos/compute',{'red/event':'delete'})).toEqual([tools.tofuComputeStep]);
  expect(machine.requirements(fixture()).legacy_state_keys).toEqual(['dbos-fixture/tofu-compute.tfstate']);
  expect(machine.clean(keygen({'digitalocean-ssh-authorized-keys':'/tmp/retired.pub'}))).not.toHaveProperty('digitalocean-ssh-authorized-keys');
  expect(()=>machine.fallbackParams(fixture())).toThrow('inventory unavailable');
});
