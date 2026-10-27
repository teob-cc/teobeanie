// The develop and operate MCP tools: each write is exactly one revision by mcp:<caller>
// and a rejected one leaves the folder as it was; paths outside the working set are
// refused; active is refused without passing specs or a shadow decision, allowed with
// a journaled override; rollback and promote; test_run's failures; replay with a fact;
// package_export refusing a house id; the annotations on both doors and the revision in
// the tool-call journal.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import type { HaEntityState, SignalRow } from "@lambda-house/teob-ts/ha";
import { liveScope, type HouseScope } from "../src/allowlist.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { createHeuristicHost, loadInstances } from "../src/kernel/host.js";
import { loadLibrary, STARTER_DIR, starterPackages } from "../src/packages/library.js";
import { packageHash } from "../src/packages/lock.js";
import { createPauseControl, pauseAggregate, pauseEventCodec, pauseStateCodec } from "../src/pause.js";
import { applyConfig, createReloader, type ConfigFiles } from "../src/reload.js";
import { createRevisionStore, recordBootRevision, workingSetPaths } from "../src/revisions.js";
import { configAggregate, configEventCodec, configStateCodec, createConfigJournal, CONFIG_CATEGORY, type ConfigChanged } from "../src/working-set.js";
import { createDevelopTools, writablePath } from "../src/mcp/develop.js";
import { createMcp } from "../src/mcp/index.js";
import { createFailureLimiter } from "../src/mcp/agents.js";
import type { ToolCalled } from "../src/mcp/journal.js";
import { createHouseTools, INSTRUCTIONS } from "../src/mcp/tools.js";

const noLog = (): void => {};
const T = Date.UTC(2026, 9, 21, 12, 0, 0);

const ALLOWLIST = `{
  "policyVersion": 1,
  "entities": [
    { "id": "switch.gate_relay", "operate": true },
    { "id": "switch.coffee_machine" },
    { "id": "binary_sensor.front_door" },
    { "id": "binary_sensor.dark" },
    { "id": "light.porch", "operate": true }
  ]
}
`;
const GATE = { heuristic: "relay-pulse", id: "gate", mode: "shadow", params: { relays: ["switch.gate_relay"], pressMs: 1000, recheckMs: 5000 } };
const PORCH = { heuristic: "lamp", id: "porch", mode: "shadow", params: {} };

/** A house file: a fact and a decider that reads it (a light on when the door opens in the dark). */
const LAMP = `import { call, defineHeuristic, fact } from "teobeanie";

export const darkOut = fact("dark-out", ({ ha }) => ha.binary_sensor.dark.is("on"));

export const lamp = defineHeuristic({
  id: "lamp",
  title: "Porch lamp",
  description: "",
  watch: () => ["binary_sensor.front_door"],
  actuates: () => ["light.porch"],
  facts: () => ["dark-out"],
  initial: () => ({}),
  decide(_s, input, ctx) {
    if (input.kind !== "signal" || input.value !== true) return undefined;
    return ctx.fact("dark-out")?.value === true ? { why: "door opened in the dark", actions: [call("light.turn_on", "light.porch")] } : { why: "door opened in daylight" };
  },
  evolve: (s) => s,
});

export default [darkOut, lamp];
`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const sig = (n: number, entity: string, state = "on"): SignalRow =>
  ({ obsId: `obs-${n}`, entityId: entity, at: Date.now(), haTimeFired: Date.now(), raw: { state }, normalized: { value: state === "on", unit: null }, origin: "ha", haVersion: null, policyVersion: 1 }) as unknown as SignalRow;

async function house(opts: { send?: (m: Record<string, unknown>) => unknown; states?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "teobeanie-develop-"));
  const config = join(dir, "config");
  const data = join(dir, "data");
  mkdirSync(join(config, "packages"), { recursive: true });
  mkdirSync(join(config, "heuristics"), { recursive: true });
  mkdirSync(data);
  cpSync(join(STARTER_DIR, "relay-pulse"), join(config, "packages", "relay-pulse"), { recursive: true });
  writeFileSync(join(config, "heuristics", "lamp.ts"), LAMP);
  writeFileSync(join(config, "allowlist.json"), ALLOWLIST);
  writeFileSync(join(config, "heuristics.json"), `${JSON.stringify({ instances: [GATE, PORCH] }, null, 2)}\n`);
  writeFileSync(join(config, "tiles.json"), JSON.stringify({ tiles: [] }));

  const { runtime, journal } = createSqliteRuntime({ path: join(data, "journal.db") }, [
    registration(configAggregate, configEventCodec, configStateCodec),
    registration(pauseAggregate, pauseEventCodec, pauseStateCodec),
  ]);
  const actuator = createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } });
  const lib = await loadLibrary(config, noLog);
  let current: Pick<ConfigFiles, "heuristics" | "facts" | "factSources" | "packages"> = { ...lib };
  let scope: HouseScope | undefined;
  const states = new Map<string, HaEntityState>((opts.states ?? []).map((id) => [id, { entity_id: id, state: "off", attributes: {}, last_changed: "", last_updated: "" }]));
  const first = await import("../src/allowlist.js").then((m) => m.loadAllowlist(config, noLog));
  scope = first.scope;
  const host = createHeuristicHost({
    library: lib.heuristics,
    facts: lib.facts,
    instances: loadInstances(config, noLog),
    actuator,
    liveState: (id) => states.get(id),
    scope: first.scope,
    house: first.house,
    forceShadow: false,
    log: noLog,
  });
  host.attach(journal);
  const record = createConfigJournal(runtime);
  const store = createRevisionStore({ dir: join(data, "revisions"), configDir: config, journal });
  await recordBootRevision(store, record);
  const reloader = createReloader({
    apply: () =>
      applyConfig({
        configDir: config,
        host,
        log: noLog,
        swap: (next) => {
          current = { heuristics: next.library, facts: next.facts, factSources: next.factSources, packages: next.packages };
          scope = next.allowlist.scope;
        },
      }),
    log: noLog,
    configDir: config,
    instances: () => host.instances(),
    record,
    revisions: store,
  });
  const pause = createPauseControl({ runtime, journal, actuator });
  closers.push(async () => {
    await host.stop();
    await runtime.shutdown();
    journal.close();
  });
  const commands: Array<{ name: string; args: string[]; from: unknown }> = [];
  const tools = createDevelopTools({
    configDir: config,
    reloader,
    revisions: store,
    journal,
    instances: () => host.instances(),
    library: () => current,
    starter: () => starterPackages(),
    scope: liveScope(() => scope!),
    liveStates: () => states.values(),
    ha: { send: async <R,>(m: Record<string, unknown>) => (opts.send?.(m) ?? []) as R },
    house: { timeZone: "UTC" },
    pause,
    command: (name, args, from) => {
      commands.push({ name, args, from });
      return host.command(name, args, from);
    },
    caller: () => ({ via: "agent", agent: "tester" }),
    now: () => Date.now(),
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    const r = await t.execute(args);
    return { ok: r.success, out: r.output as Record<string, unknown>, error: r.error };
  };
  const revisions = () => store.list().length;
  const changes = (): ConfigChanged[] => journal.queryEvents({ category: CONFIG_CATEGORY, order: "asc", limit: 1000 }).map((r) => r.payload as ConfigChanged);
  /** Every working-set file and its text. */
  const folder = (): Record<string, string> => Object.fromEntries(workingSetPaths(config).map((p) => [p, readFileSync(join(config, p), "utf8")]));
  const read = (p: string): string => readFileSync(join(config, p), "utf8");
  const shadowDecision = async (): Promise<void> => {
    await host.start({ subscribeTrigger: async () => async () => {} });
    host.onSignal(sig(1, "switch.gate_relay"));
    await vi.waitFor(() => expect(journal.queryEvents({ category: "relay-pulse", entityId: "gate", order: "asc", limit: 100 }).some((r) => r.manifest === "Decided")).toBe(true));
  };
  return { config, tools, call, revisions, changes, folder, read, host, journal, pause, commands, store, shadowDecision };
}

describe("develop tools: one revision each, by mcp:<caller>", () => {
  it("file_write, scope_add, scope_operate, instance_upsert, package_install and package_scaffold each make exactly one revision", async () => {
    const h = await house();
    const writes: Array<[string, Record<string, unknown>]> = [
      ["file_write", { path: "packages/relay-pulse/README.md", content: "# Momentary relay\n\nChanged.\n" }],
      ["scope_add", { entity: "binary_sensor.shed_door" }],
      ["scope_operate", { entity: "switch.coffee_machine", reason: "relay-pulse/side releases it" }],
      ["instance_upsert", { heuristic: "relay-pulse", id: "side", params: { relays: ["switch.coffee_machine"], pressMs: 500, recheckMs: 5000 }, mode: "off" }],
      ["instance_upsert", { heuristic: "relay-pulse", id: "side", params: { relays: ["switch.coffee_machine"], pressMs: 700, recheckMs: 5000 }, mode: "shadow" }],
      ["package_install", { name: "hold" }],
      ["package_scaffold", { name: "porch-notice", pattern: "notice" }],
      ["package_scaffold", { name: "porch-light", pattern: "trigger", kind: "rule" }],
      ["package_scaffold", { name: "hall-light", pattern: "trigger" }],
    ];
    for (const [name, args] of writes) {
      const before = h.revisions();
      const r = await h.call(name, args);
      expect(r.error, name).toBeUndefined();
      expect(h.revisions(), name).toBe(before + 1);
      expect(r.out["revision"], name).toBe(h.store.last()!.revision);
      expect(h.changes().at(-1)!.by, name).toBe("mcp:agent:tester");
    }
    expect(h.read("allowlist.json")).toContain('{ "id": "binary_sensor.shed_door" }');
    expect(h.read("heuristics.json")).toContain('"pressMs": 700');
    expect(JSON.parse(h.read("teobeanie.lock.json")).packages.hold.origin).toBe("starter");
    // The skeletons load (the reload took them) and their specs pass.
    for (const pkg of ["porch-notice", "porch-light", "hall-light"]) {
      const run = await h.call("test_run", { package: pkg });
      expect(run.out["failed"], pkg).toBe(0);
      expect(run.out["passed"], pkg).toBeGreaterThan(0);
    }
    // Nothing changed: no revision.
    const same = await h.call("file_write", { path: "packages/relay-pulse/README.md", content: "# Momentary relay\n\nChanged.\n" });
    expect(same.out["unchanged"]).toBe(true);
  });

  it("package_install upgrades an installed starter package to the add-on's version; one the house changed only with replace_modified", async () => {
    const h = await house();
    expect((await h.call("package_install", { name: "hold" })).error).toBeUndefined();
    expect((await h.call("package_install", { name: "hold" })).error).toMatch(/already the add-on's version/);
    // An older version, as the lock recorded it when it was installed.
    const dir = join(h.config, "packages", "hold");
    const old = h.read("packages/hold/README.md");
    await h.call("file_write", { path: "packages/hold/README.md", content: "# Hold\n\nAn older version.\n" });
    const lockPath = join(h.config, "teobeanie.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages.hold = { origin: "starter", version: "0.9.0", hash: packageHash(dir) };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    const before = h.revisions();
    const up = await h.call("package_install", { name: "hold" });
    expect(up.error).toBeUndefined();
    expect(up.out["upgraded_from"]).toBe("0.9.0");
    expect(h.revisions()).toBe(before + 1);
    expect(h.read("packages/hold/README.md")).toBe(old);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).packages.hold).toMatchObject({ origin: "starter", hash: packageHash(dir) });
    // Changed by the house: refused, then replaced on request.
    await h.call("file_write", { path: "packages/hold/README.md", content: "# Hold\n\nOurs.\n" });
    expect((await h.call("package_install", { name: "hold" })).error).toMatch(/replace_modified: true/);
    expect((await h.call("package_install", { name: "hold", replace_modified: true })).error).toBeUndefined();
    expect(h.read("packages/hold/README.md")).toBe(old);
    // Nothing is left beside the packages.
    expect(readdirSync(join(h.config, "packages")).filter((d) => d.startsWith("hold"))).toEqual(["hold"]);
  });

  it("a change the reload rejects leaves the folder as it was, and no revision", async () => {
    const h = await house();
    const before = h.folder();
    const n = h.revisions();
    const broken = await h.call("file_write", { path: "packages/relay-pulse/relay-pulse.ts", content: "export default 42;\n" });
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/the reload rejected the change, and the config folder is as it was/);
    const scaffold = await h.call("instance_upsert", { heuristic: "relay-pulse", id: "x", params: { relays: ["switch.coffee_machine"], pressMs: 1000, recheckMs: 5000 } });
    expect(scaffold.error).toMatch(/rejected/); // switch.coffee_machine is observed only: the host refuses to let it own it
    expect((await h.call("instance_upsert", { heuristic: "nope", id: "x", params: {} })).error).toMatch(/no heuristic nope/);
    expect((await h.call("file_write", { path: "heuristics.json", content: "{ not json" })).error).toMatch(/not JSON/);
    expect(h.folder()).toEqual(before);
    expect(h.revisions()).toBe(n);
  });

  it("refuses paths outside the working set, the lock and generated files", async () => {
    const h = await house();
    for (const path of ["../x.json", "/etc/passwd", "teobeanie.lock.json", "heuristics/ha.d.ts", ".teob/heuristics.schema.json", "packages/relay-pulse/.hidden", "packages/x/node_modules/a.js", "secrets.json", "packages/../allowlist.json", "heuristics\\a.ts"]) {
      expect(() => writablePath(path), path).toThrow();
      expect((await h.call("file_write", { path, content: "{}" })).ok, path).toBe(false);
    }
    expect(writablePath("packages/relay-pulse/relay-pulse.ts")).toBe("packages/relay-pulse/relay-pulse.ts");
    expect((await h.call("file_read", { path: "../etc/passwd" })).ok).toBe(false);
    expect((await h.call("file_read", { path: "allowlist.json" })).out["text"]).toBe(ALLOWLIST);
  });

  it("never widens operate or goes active by the back door", async () => {
    const h = await house();
    expect((await h.call("scope_add", { entity: "light.hall", operate: true })).error).toMatch(/scope_operate/);
    expect((await h.call("file_write", { path: "allowlist.json", content: ALLOWLIST.replace('{ "id": "switch.coffee_machine" }', '{ "id": "switch.coffee_machine", "operate": true }') })).error).toMatch(/only scope_operate/);
    const active = h.read("heuristics.json").replace('"mode": "shadow"', '"mode": "active"');
    expect((await h.call("file_write", { path: "heuristics.json", content: active })).error).toMatch(/only instance_mode/);
    expect((await h.call("instance_upsert", { ...GATE, mode: "active" })).error).toMatch(/never makes an instance active/);
  });
});

describe("operate tools", () => {
  it("refuses active without passing specs or without a shadow decision, and allows it with an override, journaled", async () => {
    const h = await house();
    // No shadow decision yet: refused, though the specs pass.
    const early = await h.call("instance_mode", { key: "relay-pulse/gate", mode: "active" });
    expect(early.error).toMatch(/has not decided in shadow within the last 24 h/);
    expect(early.error).not.toMatch(/specs/);
    await h.shadowDecision();
    // A failing spec: refused, with the failure.
    const spec = h.read("packages/relay-pulse/relay-pulse.test.ts").replace('pressMs: 1000, recheckMs: 5000 };\n\n  it("releases', 'pressMs: 1000, recheckMs: 5000 };\n\n  it("is wrong", () => expect(1).toBe(2));\n\n  it("releases');
    expect((await h.call("file_write", { path: "packages/relay-pulse/relay-pulse.test.ts", content: spec })).ok).toBe(true);
    const run = await h.call("test_run", { package: "relay-pulse" });
    expect(run.out["failed"]).toBe(1);
    expect((run.out["specs"] as Array<{ name: string; ok: boolean; error?: string }>).find((s) => !s.ok)).toMatchObject({ name: "relay-pulse (garage step button) › is wrong", error: "expected 1 to be 2" });
    const n = h.revisions();
    const red = await h.call("instance_mode", { key: "relay-pulse/gate", mode: "active" });
    expect(red.error).toMatch(/its specs do not pass \(1 failed\): .*is wrong: expected 1 to be 2/);
    expect(h.revisions()).toBe(n);
    // The owner's say-so, journaled.
    const over = await h.call("instance_mode", { key: "relay-pulse/gate", mode: "active", override_reason: "the owner accepts the red spec for tonight" });
    expect(over.ok).toBe(true);
    expect(over.out).toMatchObject({ mode: "active", rollback: `rollback with n: ${n}` });
    expect(h.changes().at(-1)).toMatchObject({ by: "mcp:agent:tester", summary: expect.stringContaining("override: the owner accepts the red spec for tonight") });
    expect(h.host.instances().find((i) => i.key === "relay-pulse/gate")!.mode).toBe("active");
    // And with the spec green and a shadow decision, no override is needed.
    expect((await h.call("file_write", { path: "packages/relay-pulse/relay-pulse.test.ts", content: readFileSync(join(STARTER_DIR, "relay-pulse", "relay-pulse.test.ts"), "utf8") })).ok).toBe(true);
    expect((await h.call("instance_mode", { key: "relay-pulse/gate", mode: "shadow" })).ok).toBe(true);
    const green = await h.call("instance_mode", { key: "relay-pulse/gate", mode: "active" });
    expect(green.error).toBeUndefined();
    expect(green.out["checks"]).toMatchObject({ specs: "3 passed, 0 failed" });
  });

  it("a house file without specs cannot go active without an override", async () => {
    const h = await house();
    expect((await h.call("instance_mode", { key: "lamp/porch", mode: "active" })).error).toMatch(/it has no specs/);
  });

  it("scope_operate needs a reason and journals it", async () => {
    const h = await house();
    expect((await h.call("scope_operate", { entity: "switch.coffee_machine" })).error).toMatch(/reason is required/);
    expect((await h.call("scope_operate", { entity: "switch.pump", reason: "x" })).error).toMatch(/not in the house scope/);
    const ok = await h.call("scope_operate", { entity: "switch.coffee_machine", reason: "relay-pulse/side releases it" });
    expect(ok.out["revision"]).toBe(h.store.last()!.revision);
    expect(h.read("allowlist.json")).toContain('{ "id": "switch.coffee_machine", "operate": true }');
    expect(h.changes().at(-1)!.summary).toBe("scope: switch.coffee_machine may be operated (relay-pulse/side releases it)");
  });

  it("adds a twin, compares, promotes it and rolls the promote back, each a revision", async () => {
    const h = await house();
    const original = h.read("heuristics.json");
    const twin = await h.call("instance_upsert", { heuristic: "relay-pulse", id: "gate-next", params: { relays: ["switch.gate_relay"], pressMs: 400, recheckMs: 5000 }, twinOf: "relay-pulse/gate" });
    expect(twin.error).toBeUndefined();
    expect(h.host.instances().find((i) => i.key === "relay-pulse/gate-next")!.twinOf).toBe("relay-pulse/gate");
    const compared = await h.call("twin_compare", { key: "relay-pulse/gate" });
    expect(compared.out).toMatchObject({ twin: "relay-pulse/gate-next", original: "relay-pulse/gate" });
    const beforePromote = h.store.last()!.revision;
    const promoted = await h.call("promote", { key: "relay-pulse/gate-next" });
    expect(promoted.out["revision"]).toBe(beforePromote + 1);
    const after = JSON.parse(h.read("heuristics.json")) as { instances: Array<{ id: string; params: { pressMs: number }; twinOf?: string }> };
    expect(after.instances.find((i) => i.id === "gate")).toMatchObject({ params: { pressMs: 400 } });
    expect(after.instances.some((i) => i.twinOf !== undefined || i.id === "gate-next")).toBe(false);
    const back = await h.call("rollback", { n: 1 });
    expect(back.out).toMatchObject({ to: 1, revision: beforePromote + 2, summary: "rollback to 1" });
    expect(h.read("heuristics.json")).toBe(original);
    const listed = (await h.call("revisions")).out as unknown as Array<{ revision: number; by: string }>;
    expect(listed[0]).toMatchObject({ revision: beforePromote + 2, by: "mcp:agent:tester" });
    const diff = await h.call("revision_diff", { a: 1, b: beforePromote, path: "heuristics.json" });
    expect((diff.out["files"] as Array<{ diff: string }>)[0]!.diff).toContain('+      "twinOf": "relay-pulse/gate"');
  });

  it("pause, resume and a command carry the agent as who", async () => {
    const h = await house();
    const p = await h.call("pause", { reason: "testing" });
    expect(p.out).toMatchObject({ paused: true, by: "mcp:agent:tester", note: "guards still act" });
    expect(h.pause.state()).toMatchObject({ paused: true, by: "mcp:agent:tester", reason: "testing" });
    expect((await h.call("resume")).out).toMatchObject({ paused: false });
    const cmd = await h.call("command", { name: "open_gate" });
    expect(cmd.error).toMatch(/no running instance answers \/open_gate/);
    expect(h.commands[0]).toEqual({ name: "open_gate", args: [], from: { channel: "mcp", user: "mcp:agent:tester" } });
  });
});

describe("replay and export", () => {
  it("replays an instance over the recorder with the fact it reads evaluated", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const from = now - 86_400_000;
    const s = (ms: number) => ms / 1000;
    const h = await house({
      send: (m) => {
        asked.push(m);
        if (m["type"] === "history/history_during_period") {
          return {
            "binary_sensor.dark": [{ s: "off", lu: s(from) }, { s: "on", lu: s(from + 2 * 3600_000) }],
            "binary_sensor.front_door": [{ s: "off", lu: s(from) }, { s: "on", lu: s(from + 3600_000) }, { s: "off", lu: s(from + 3600_000 + 60_000) }, { s: "on", lu: s(from + 3 * 3600_000) }],
            "light.porch": [{ s: "off", lu: s(from) }],
          };
        }
        return [];
      },
    });
    const r = await h.call("replay", { instance: "lamp/porch", days: 1 });
    expect(r.error).toBeUndefined();
    expect((asked[0]!["entity_ids"] as string[]).sort()).toEqual(["binary_sensor.dark", "binary_sensor.front_door", "light.porch"]);
    expect(r.out).toMatchObject({ facts: ["dark-out"], would_call: 1, parity: [{ entity: "light.porch", teobeanie_calls: 1, house_changes: 0, matched: 0, teobeanie_only: 1 }] });
    expect((r.out["calls"] as Array<{ why: string }>)[0]!.why).toBe("door opened in the dark");
    expect((await h.call("replay", { instance: "lamp/porch", days: 30 })).out["days"]).toBe(7);
  });

  it("package_export returns placeholder files when clean, and refuses a house id", async () => {
    const env = process.env["PRIVACY_DENY"];
    process.env["PRIVACY_DENY"] = "a-word-no-file-has";
    try {
      const h = await house({ states: ["light.den_lamp", "switch.pump"] });
      const clean = await h.call("package_export", { name: "relay-pulse" });
      expect(clean.out["exportable"]).toBe(true);
      const example = JSON.parse((clean.out["files"] as Record<string, string>)["example.json"]!) as { id: string; params: { relays: string[] } };
      expect(example).toMatchObject({ id: "example", params: { relays: ["switch.relays"] } });
      const readme = h.read("packages/relay-pulse/README.md");
      expect((await h.call("file_write", { path: "packages/relay-pulse/README.md", content: `${readme}\nIn our house it drives light.den_lamp.\n` })).ok).toBe(true);
      const dirty = await h.call("package_export", { name: "relay-pulse" });
      expect(dirty.out["exportable"]).toBe(false);
      expect(dirty.out["files"]).toBeUndefined();
      expect((dirty.out["hits"] as string[]).some((x) => x.startsWith("README.md:") && x.includes("an entity id of this house"))).toBe(true);
    } finally {
      if (env === undefined) delete process.env["PRIVACY_DENY"];
      else process.env["PRIVACY_DENY"] = env;
    }
  });
});

describe("the MCP surface", () => {
  it("lists every tool on both doors with its annotations, and journals a write's revision", async () => {
    const h = await house();
    const recorded: Array<Omit<ToolCalled, "tag">> = [];
    const read = createHouseTools({
      scope: liveScope(() => ({ observes: () => false, operates: () => false, observed: [], operated: [] })),
      liveState: () => undefined,
      signals: { query: () => [] },
      journal: h.journal,
      ha: { send: async () => [] as never },
      instances: () => [],
      configDir: h.config,
      house: {},
      caller: () => undefined,
    });
    const mcp = createMcp({ mode: "standalone", networks: [], tools: [...read, ...h.tools], instructions: INSTRUCTIONS, version: "test", record: (c) => recorded.push(c), log: noLog });
    const ingress = new Hono();
    mcp.mountIngress(ingress);
    const agents = new Hono();
    const tokens = { verify: () => ({ id: "t1", name: "tester" }) as never, known: () => true };
    mcp.mountAgents(agents, { tokens, limiter: createFailureLimiter() });
    const post = (app: Hono, body: unknown) =>
      app.request("/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", authorization: "Bearer tbn_t1_x" } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    for (const app of [ingress, agents]) {
      const listed = (await (await post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> } };
      const by = new Map(listed.result.tools.map((t) => [t.name, t.annotations]));
      expect(by.get("decisions")).toMatchObject({ readOnlyHint: true });
      expect(by.get("test_run")).toMatchObject({ readOnlyHint: true });
      expect(by.get("file_write")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(by.get("instance_upsert")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      for (const t of ["instance_mode", "scope_operate", "rollback", "promote", "pause", "resume", "command"]) expect(by.get(t), t).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    const res = await post(ingress, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scope_add", arguments: { entity: "binary_sensor.shed_door" } } });
    expect(res.status).toBe(200);
    expect(recorded.at(-1)).toMatchObject({ tool: "scope_add", ok: true, revision: h.store.last()!.revision });
    expect(existsSync(join(h.config, "allowlist.json"))).toBe(true);
  });
});
