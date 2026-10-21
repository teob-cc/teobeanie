// The working set's edits, journaled: a reload that changed something is a
// ConfigChanged with who did it (the file watch, the panel's HA user), the panel's
// mode change rewriting only the mode, reloading and journaling, a rejected one
// writing and journaling nothing, the timeline showing an edit only for the instances
// it touched, and journals from before the instance keys loading.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { CategoryId, EntityId, SequenceNr, ulid, type Codec } from "@lambda-house/teob-ts/core";
import { createSignalStore } from "@lambda-house/teob-ts/ha";
import { createSqliteJournal, createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { houseScope } from "../src/allowlist.js";
import { defineHeuristic } from "../src/kernel/heuristic.js";
import { createHeuristicHost, type InstanceConfig, type InstanceInfo } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { applyConfig, createReloader } from "../src/reload.js";
import { createHouseRecord } from "../src/mcp/timeline.js";
import {
  CONFIG_CATEGORY,
  CONFIG_ENTITY,
  configAggregate,
  configEventCodec,
  configStateCodec,
  createConfigJournal,
  describeChanges,
  mountInstanceMode,
  setInstanceMode,
  type ConfigChanged,
} from "../src/working-set.js";

const noLog = (): void => {};

const probe = defineHeuristic<{ sensor: string; light: string; delayMin?: number }, Record<string, never>, never>({
  id: "probe",
  title: "probe",
  description: "",
  watch: (p) => [p.sensor],
  actuates: (p) => [p.light],
  initial: () => ({}),
  decide: () => undefined,
  evolve: (s) => s,
});

const inst = (id: string, extra: Partial<InstanceConfig> = {}): InstanceConfig => ({
  heuristic: "probe",
  id,
  mode: "shadow",
  params: { sensor: `binary_sensor.${id}_motion`, light: `light.${id}` },
  ...extra,
});

const ALLOWLIST = JSON.stringify({ entities: ["a", "b"].flatMap((i) => [{ id: `binary_sensor.${i}_motion` }, { id: `light.${i}`, operate: true }]) });

/** As a person writes it: two-space indent, a key order of their own, a trailing newline. */
const HAND_WRITTEN = `{
  "instances": [
    {
      "heuristic": "probe",
      "id": "a",
      "mode": "shadow",
      "params": { "sensor": "binary_sensor.a_motion", "light": "light.a" }
    },
    {
      "id": "b",
      "heuristic": "probe",
      "params": {
        "light": "light.b",
        "sensor": "binary_sensor.b_motion"
      }
    }
  ]
}
`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A config folder, the host running it, and the reloader journaling into a sqlite runtime. */
function house(heuristicsJson = HAND_WRITTEN) {
  const dir = mkdtempSync(join(tmpdir(), "teobeanie-working-set-"));
  writeFileSync(join(dir, "allowlist.json"), ALLOWLIST);
  writeFileSync(join(dir, "heuristics.json"), heuristicsJson);
  writeFileSync(join(dir, "tiles.json"), JSON.stringify({ tiles: [] }));
  const { runtime, journal } = createSqliteRuntime({ path: join(dir, "journal.db") }, [registration(configAggregate, configEventCodec, configStateCodec)]);
  const scope = houseScope(["binary_sensor.a_motion", "binary_sensor.b_motion"], ["light.a", "light.b"]);
  const host = createHeuristicHost({
    library: [probe],
    instances: (JSON.parse(heuristicsJson) as { instances: InstanceConfig[] }).instances,
    actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
    liveState: () => undefined,
    scope,
    forceShadow: false,
    log: noLog,
  });
  host.attach(journal);
  const reloader = createReloader({
    apply: () => applyConfig({ configDir: dir, extra: [probe], host, log: noLog }),
    log: noLog,
    configDir: dir,
    instances: () => host.instances(),
    record: createConfigJournal(runtime),
  });
  const changes = (): ConfigChanged[] =>
    journal.queryEvents({ category: CONFIG_CATEGORY, order: "asc", limit: 100 }).map((r) => r.payload as ConfigChanged);
  const app = new Hono();
  mountInstanceMode(app, { mode: "addon", reloader });
  const post = (key: string, body: unknown, ip = "172.30.32.2", headers: Record<string, string> = { "x-remote-user-display-name": "Alex" }) =>
    app.request(`/api/instances/${key}/mode`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }, { incoming: { socket: { remoteAddress: ip } } });
  const heuristicsText = (): string => readFileSync(join(dir, "heuristics.json"), "utf8");
  closers.push(async () => {
    await host.stop();
    await runtime.shutdown();
    journal.close();
  });
  return { dir, host, journal, runtime, reloader, changes, post, heuristicsText, scope };
}

describe("setting an instance's mode in heuristics.json", () => {
  it("replaces the mode's value and nothing else", () => {
    const out = setInstanceMode(HAND_WRITTEN, "probe/a", "active");
    expect(out).toBe(HAND_WRITTEN.replace('"mode": "shadow"', '"mode": "active"'));
  });

  it("adds a missing mode after the id, in the instance's layout", () => {
    const out = setInstanceMode(HAND_WRITTEN, "probe/b", "off");
    expect(out).toBe(HAND_WRITTEN.replace('"id": "b",\n', '"id": "b",\n      "mode": "off",\n'));
    const oneLine = `{"instances":[{"heuristic":"probe","id":"b","params":{}}]}`;
    expect(setInstanceMode(oneLine, "probe/b", "active")).toBe(`{"instances":[{"heuristic":"probe","id":"b", "mode":"active","params":{}}]}`);
    expect((JSON.parse(setInstanceMode(oneLine, "probe/b", "active")) as { instances: InstanceConfig[] }).instances[0]!.mode).toBe("active");
  });

  it("refuses an unknown instance and a file it cannot read", () => {
    expect(() => setInstanceMode(HAND_WRITTEN, "probe/z", "active")).toThrow(/no instance probe\/z/);
    expect(() => setInstanceMode("{ nope", "probe/a", "active")).toThrow(/unparseable JSON/);
    expect(() => setInstanceMode("{}", "probe/a", "active")).toThrow(/missing "instances"/);
  });
});

describe("what a reload changed, in a line per instance", () => {
  const info = (key: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
    key, heuristic: key.split("/")[0]!, id: key.split("/")[1]!, title: "", mode: "shadow", configuredMode: "shadow",
    watch: [], reads: [], actuates: [], uses: [], commands: [], triggers: [], params: { maxRunMin: 180, room: "a" }, alerts: false, notifyPerHour: 6, ...extra,
  });
  it("names the parameters, the modes and what was added and removed", () => {
    const lines = describeChanges(
      { added: ["door-nag/back"], removed: ["door-nag/old"], changed: [{ key: "climate-guard/attic", why: "params" }, { key: "relay-pulse/gate", why: "mode" }, { key: "x/code", why: "code" }], unchanged: 3 },
      [info("climate-guard/attic"), info("relay-pulse/gate"), info("x/code")],
      [info("climate-guard/attic", { params: { maxRunMin: 240, room: "a" } }), info("relay-pulse/gate", { configuredMode: "active", mode: "active" }), info("x/code")],
    );
    expect(lines).toEqual(["+door-nag/back", "−door-nag/old", "climate-guard/attic: params changed (maxRunMin 180 → 240)", "relay-pulse/gate: mode shadow → active", "x/code: code changed"]);
  });
});

describe("journaling the working set's changes", () => {
  it("journals a file-watch change with by: file and the instances it touched, and an unchanged reload not at all", async () => {
    const h = house();
    await h.reloader.reload("file"); // an editor's save that changed nothing
    expect(h.changes()).toEqual([]);

    writeFileSync(join(h.dir, "heuristics.json"), HAND_WRITTEN.replace('"light": "light.a" }', '"light": "light.a", "delayMin": 10 }'));
    const outcome = await h.reloader.reload("file");
    expect(outcome).toMatchObject({ ok: true, by: "file", journaled: { file: "heuristics.json", by: "file" } });
    expect(h.changes()).toEqual([
      { tag: "ConfigChanged", at: outcome.at, file: "heuristics.json", by: "file", summary: "probe/a: params changed (delayMin unset → 10)", instances: ["probe/a"] },
    ]);

    // A re-indent is no change; a scope change is everyone's.
    writeFileSync(join(h.dir, "heuristics.json"), JSON.stringify(JSON.parse(readFileSync(join(h.dir, "heuristics.json"), "utf8"))));
    await h.reloader.reload("file");
    expect(h.changes()).toHaveLength(1);
    writeFileSync(join(h.dir, "allowlist.json"), JSON.stringify({ entities: [...(JSON.parse(ALLOWLIST) as { entities: unknown[] }).entities, { id: "sensor.extra" }] }));
    await h.reloader.reload("file");
    expect(h.changes()[1]).toMatchObject({ file: "allowlist.json", by: "file", summary: "no instance changed" });
    expect(h.changes()[1]).not.toHaveProperty("instances");
  });

  it("a panel mode change rewrites only the mode, reloads and journals who did it", async () => {
    const h = house();
    const res = await h.post("probe/a", { mode: "active" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, by: "person:Alex", summary: "+0 −0 ~1 (mode) unchanged 1" });
    expect(h.heuristicsText()).toBe(HAND_WRITTEN.replace('"mode": "shadow"', '"mode": "active"'));
    expect(h.host.instances().find((i) => i.key === "probe/a")?.mode).toBe("active");
    expect(h.changes()).toMatchObject([{ file: "heuristics.json", by: "person:Alex", summary: "probe/a: mode shadow → active", instances: ["probe/a"] }]);

    // The file watch sees the same write a second later: nothing new to journal.
    await h.reloader.reload("file");
    expect(h.changes()).toHaveLength(1);
  });

  it("a rejected reload writes nothing and journals nothing", async () => {
    const h = house();
    writeFileSync(join(h.dir, "allowlist.json"), "{ broken"); // someone's half-saved edit
    const res = await h.post("probe/a", { mode: "active" }, "172.30.32.2", { "x-remote-user-id": "0123456789abcdef" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, by: "user:01234567", error: expect.stringMatching(/allowlist/) });
    expect(h.heuristicsText()).toBe(HAND_WRITTEN);
    expect(h.host.instances().find((i) => i.key === "probe/a")?.mode).toBe("shadow");
    expect(h.changes()).toEqual([]);
  });

  it("answers a bad request, an unknown instance and a write from outside ingress without touching the file", async () => {
    const h = house();
    expect((await h.post("probe/a", { mode: "active" }, "172.30.33.5")).status).toBe(403);
    expect((await h.post("probe/a", { mode: "loud" })).status).toBe(400);
    const missing = await h.post("probe/z", { mode: "active" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ reason: "heuristics.json: no instance probe/z" });
    expect(h.heuristicsText()).toBe(HAND_WRITTEN);
    expect(h.changes()).toEqual([]);
  });

  it("the timeline shows an edit for the instances it touched, and an old row for all", async () => {
    const h = house();
    await h.post("probe/a", { mode: "active" });
    // A row from before the instance keys (as an older reader expected it).
    const passthrough: Codec<{ tag: string }> = { manifest: (e) => e.tag, encode: (e) => e, decode: (_m, d) => d as { tag: string } };
    const at = Date.now() - 1000;
    h.journal.persistEvents(CategoryId(CONFIG_CATEGORY), EntityId("heuristics.json"), [{ tag: "ConfigChanged", at, file: "heuristics.json", by: "person:alex", summary: "probe/b offAfterMin 5 → 10" }], SequenceNr(0), passthrough, [{ eventId: ulid(at), v: 1 }]);
    const store = createSignalStore({ path: join(h.dir, "signals.db") });
    closers.push(async () => store.close());
    const record = createHouseRecord({
      scope: h.scope,
      signals: store,
      journal: h.journal,
      users: { originOf: async (id) => `user:${id}`, refresh: async () => {} },
      instances: () => h.host.instances(),
      house: { timeZone: "UTC" },
    });
    const range = { fromMs: Date.now() - 3600_000, toMs: Date.now() + 60_000, limit: 100 };
    const config = async (target: { instance?: string; entity?: string }) =>
      (await record.timeline(target, range)).rows.filter((r) => r.kind === "config").map((r) => (r.kind === "config" ? r.summary : ""));
    const mine = "heuristics.json: probe/a: mode shadow → active";
    const old = "heuristics.json: probe/b offAfterMin 5 → 10";
    expect(await config({ instance: "probe/a" })).toEqual([old, mine]);
    expect(await config({ instance: "probe/b" })).toEqual([old]);
    expect(await config({ entity: "light.a" })).toEqual([old, mine]);
    expect(await config({ entity: "binary_sensor.b_motion" })).toEqual([old]);
  });
});

describe("old journals", () => {
  it("a teob-config stream from before the instance keys loads, and the next change follows it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-working-set-old-"));
    const path = join(dir, "journal.db");
    const old = createSqliteJournal({ path });
    old.persistEvents(CONFIG_CATEGORY, CONFIG_ENTITY, [{ tag: "ConfigChanged", at: 1, file: "heuristics.json", by: "file", summary: "+0 −0 ~1 (params) unchanged 3" }], SequenceNr(0), configEventCodec as never, [{ eventId: ulid(1), v: 1 }]);
    old.close();
    const { runtime, journal } = createSqliteRuntime({ path }, [registration(configAggregate, configEventCodec, configStateCodec)]);
    await createConfigJournal(runtime)({ at: 2, file: "heuristics.json", by: "cli", summary: "probe/a: mode shadow → active", instances: ["probe/a"] });
    const rows = journal.queryEvents({ category: CONFIG_CATEGORY, order: "asc", limit: 10 });
    expect(rows.map((r) => [r.sequenceNr, (r.payload as ConfigChanged).by, (r.payload as ConfigChanged).instances])).toEqual([
      [1, "file", undefined],
      [2, "cli", ["probe/a"]],
    ]);
    await runtime.shutdown();
    journal.close();
  });
});
