import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "red/workflow";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");

function fixture(overrides: Opts = {}): Opts {
  return { ...(Bun.YAML.parse(readFileSync(fixtureFile, "utf8")) as Opts), ...overrides };
}

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("fixture is valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
  });

  test("reports all detected errors", () => {
    const errors = validate.stateErrors(fixture({
      "dbos-host": "bad",
      "dbos-version": "latest",
      "dbos-durable-delay-seconds": 0,
      "dbos-system-database-pool-size": 2,
      "digitalocean-vpc-mode": "created",
      "digitalocean-vpc-uuid": "hard-coded",
      "digitalocean-ssh-sources": ["bad"],
    }));
    const text = errors.join("\n");
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const fragment of ["hostname", "exact semantic", "positive integer", "at least 5",
                            "must be default", "must not be configured", "invalid CIDR"]) {
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
    const source = readFileSync(join(import.meta.dir, "../resources/tofu-compute/main.tf"), "utf8");
    expect(source).toContain('data "digitalocean_vpc" "default"');
    expect(source).toContain('region = "<{ digitalocean-region }>"');
    expect(source).toContain("vpc_uuid = data.digitalocean_vpc.default.id");
    expect(source).not.toContain('resource "digitalocean_vpc"');
  });

  test("once.yml keeps green's select-keys semantics for the absent smtp password", async () => {
    const opts = await workflow.startStep(fixture({ "red/event": "build" }), {});
    const rendered = tools.ansibleOnce(opts);
    expect(rendered).toContain('smtp_server: "127.0.0.1"');
    expect(rendered).toContain('smtp_username: "unused"');
    expect(rendered).not.toContain("smtp_password");
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  test("build and dry-run need no credentials", async () => {
    expect((await workflow.startStep(fixture({ "red/event": "build" }), {}))["red/exit"]).toBe(0);
    expect((await workflow.startStep(
      fixture({ "red/event": "create", "red/dry-run": true }), {}))["red/exit"]).toBe(0);
  });

  test("real create reports all missing credentials", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "create" }), {});
    expect(result["red/exit"]).toBe(2);
    for (const name of ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                        "COLORS_PAR_DBOS_POSTGRES_PASSWORD", "COLORS_PAR_R2_ACCESS_KEY_ID"]) {
      expect(String(result["red/err"])).toContain(name);
    }
  });

  test("delete is protected", async () => {
    const blocked = await workflow.startStep(fixture({ "red/event": "delete" }), {});
    expect(blocked["red/exit"]).toBe(2);
    expect(String(blocked["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
    expect((await workflow.startStep(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false }), {}))["red/exit"]).toBe(0);
  });

  test("graph creates and reverses only required stages", () => {
    expect(workflow.wireFn("dbos/start", { "red/event": "create" })!.slice(1)).toEqual(["dbos/compute"]);
    expect(workflow.wireFn("dbos/compute", { "red/event": "create" })!.slice(1)).toEqual(["dbos/dns"]);
    expect(workflow.wireFn("dbos/dns", { "red/event": "create" })!.slice(1))
      .toEqual(["dbos/ansible-local", "dbos/ansible-remote"]);
    expect(workflow.wireFn("dbos/start", { "red/event": "delete" })!.slice(1)).toEqual(["dbos/ansible-cleanup"]);
    expect(workflow.wireFn("dbos/dns", { "red/event": "delete" })!.slice(1)).toEqual(["dbos/compute"]);
  });
});
