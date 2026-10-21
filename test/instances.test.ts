// The panel's instance editor, server side: instances of heuristics.json added, changed
// and removed in the hand-written text (the rest of the file as it was), each through
// the reload path and journaled with who did it; an edit the loader would refuse
// refused before anything is written, one the reload rejects put back; and the
// catalogue the editor is opened from.

import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { houseScope } from "../src/allowlist.js";
import { defineHeuristic } from "../src/kernel/heuristic.js";
import { createHeuristicHost, type InstanceConfig } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { checkInstance, newIdProblem } from "../src/kernel/instance-check.js";
import { param, type Infer } from "../src/kernel/params.js";
import { applyConfig, createReloader } from "../src/reload.js";
import type { PackageInfo } from "../src/packages/library.js";
import { mountInstances, type CatalogueEntry, type PickerEntity } from "../src/instances.js";
import {
  CONFIG_CATEGORY,
  addInstance,
  configAggregate,
  configEventCodec,
  configStateCodec,
  createConfigJournal,
  removeInstance,
  replaceInstance,
  type ConfigChanged,
} from "../src/working-set.js";

const noLog = (): void => {};

const PROBE_PARAMS = param.object({
  sensor: param.entity("binary_sensor").doc("Wakes it."),
  light: param.entity("light").doc("What it switches."),
  delayMin: param.duration("min", { positive: true }).default(5).doc("Run-on."),
  texts: param.texts({ on: "{light} is on" }),
});

const probe = defineHeuristic<Infer<typeof PROBE_PARAMS>, Record<string, never>, never>({
  id: "probe",
  pattern: "trigger",
  title: "Probe",
  description: "A light from a sensor.",
  guarantees: "Leaves a light switched by hand alone.",
  params: PROBE_PARAMS,
  watch: (p) => [p.sensor],
  actuates: (p) => [p.light],
  initial: () => ({}),
  decide: () => undefined,
  evolve: (s) => s,
});

/** A house's own heuristic without a schema: any params. */
const free = defineHeuristic<{ watch?: string[] }, Record<string, never>, never>({
  id: "free",
  title: "Free",
  description: "",
  watch: (p) => p?.watch ?? [],
  actuates: () => [],
  initial: () => ({}),
  decide: () => undefined,
  evolve: (s) => s,
});

// light.c is listed but not operable, to see the reload reject what the file alone cannot tell.
const ALLOWLIST = JSON.stringify({
  entities: [...["a", "b", "c"].map((i) => ({ id: `binary_sensor.${i}_motion` })), { id: "light.a", operate: true }, { id: "light.b", operate: true }, { id: "light.c" }],
});

/** As a person writes it: keys of their own, one-line and multi-line params, a note. */
const HAND_WRITTEN = `{
  "$schema": ".teob/heuristics.schema.json",
  "_readme": "what runs in this house",
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
      "_note": "the stairs",
      "params": {
        "light": "light.b",
        "sensor": "binary_sensor.b_motion",
        "delayMin": 3
      }
    }
  ]
}
`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function house(heuristicsJson: string | null = HAND_WRITTEN) {
  const dir = mkdtempSync(join(tmpdir(), "teobeanie-instances-"));
  writeFileSync(join(dir, "allowlist.json"), ALLOWLIST);
  if (heuristicsJson !== null) writeFileSync(join(dir, "heuristics.json"), heuristicsJson);
  writeFileSync(join(dir, "tiles.json"), JSON.stringify({ tiles: [] }));
  const { runtime, journal } = createSqliteRuntime({ path: join(dir, "journal.db") }, [registration(configAggregate, configEventCodec, configStateCodec)]);
  const scope = houseScope(["binary_sensor.a_motion", "binary_sensor.b_motion", "binary_sensor.c_motion", "light.c"], ["light.a", "light.b"]);
  const library = [probe, free];
  const host = createHeuristicHost({
    library,
    instances: heuristicsJson === null ? [] : (JSON.parse(heuristicsJson) as { instances: InstanceConfig[] }).instances,
    actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
    liveState: () => undefined,
    scope,
    forceShadow: false,
    log: noLog,
  });
  host.attach(journal);
  const reloader = createReloader({
    // "free" stands for one of the house's own: the reload's library has it, the catalogue marks it.
    apply: () => applyConfig({ configDir: dir, extra: library, host, log: noLog }),
    log: noLog,
    configDir: dir,
    instances: () => host.instances(),
    record: createConfigJournal(runtime),
  });
  const app = new Hono();
  const st = (entity_id: string, name?: string) => ({ entity_id, state: "off", attributes: name ? { friendly_name: name } : {}, last_changed: "", last_updated: "" });
  mountInstances(app, {
    mode: "addon",
    reloader,
    configDir: dir,
    library: () => library,
    // probe came with the add-on (a starter package); "free" is the house's own.
    packages: () => [{ name: "probe", version: "1.0.0", origin: "starter", modified: false, heuristics: ["probe"] } as unknown as PackageInfo],
    scope,
    liveStates: () => [st("light.a", "Hall"), st("light.b"), st("camera.outside", "Not in scope")],
  });
  const send = (method: string, path: string, body?: unknown, ip = "172.30.32.2") =>
    app.request(
      path,
      { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { "content-type": "application/json", "x-remote-user-display-name": "Alex" } },
      { incoming: { socket: { remoteAddress: ip } } },
    );
  const changes = (): ConfigChanged[] => journal.queryEvents({ category: CONFIG_CATEGORY, order: "asc", limit: 100 }).map((r) => r.payload as ConfigChanged);
  const text = (): string => readFileSync(join(dir, "heuristics.json"), "utf8");
  const keys = (): string[] => host.instances().map((i) => i.key);
  closers.push(async () => {
    await host.stop();
    await runtime.shutdown();
    journal.close();
  });
  return { dir, host, send, changes, text, keys };
}

describe("editing whole instances in heuristics.json's text", () => {
  it("adds an instance after the last one, in its layout, and nothing else changes", () => {
    const out = addInstance(HAND_WRITTEN, { heuristic: "probe", id: "c", mode: "shadow", params: { sensor: "binary_sensor.c_motion", light: "light.c" } });
    const end = HAND_WRITTEN.lastIndexOf("    }\n  ]");
    expect(out.slice(0, end + 5)).toBe(HAND_WRITTEN.slice(0, end + 5));
    expect(out.slice(end + 5)).toBe(`,
    {
      "heuristic": "probe",
      "id": "c",
      "mode": "shadow",
      "params": { "sensor": "binary_sensor.c_motion", "light": "light.c" }
    }
  ]
}
`);
  });

  it("adds to an empty list and to a file written on one line", () => {
    expect(addInstance('{\n  "instances": []\n}\n', { heuristic: "free", id: "x", params: {} })).toBe(`{
  "instances": [
    {
      "heuristic": "free",
      "id": "x",
      "params": {}
    }
  ]
}
`);
    expect(addInstance('{"instances":[{"heuristic":"free","id":"x","params":{}}]}', { heuristic: "free", id: "y", alerts: true, params: { a: [1, 2] } })).toBe(
      '{"instances":[{"heuristic":"free","id":"x","params":{}},{"heuristic":"free","id":"y","params":{"a":[1,2]},"alerts":true}]}',
    );
    expect(() => addInstance(HAND_WRITTEN, { heuristic: "probe", id: "a", params: {} })).toThrow(/already is an instance probe\/a/);
  });

  it("changes only the values that differ: one param, a mode after the id, a flag removed", () => {
    // A changed param replaces that value; the person's key order stays.
    const params = { sensor: "binary_sensor.b_motion", light: "light.b", delayMin: 10 };
    const out = replaceInstance(HAND_WRITTEN, "probe/b", { mode: "active", params });
    expect(out).toBe(HAND_WRITTEN.replace('"delayMin": 3', '"delayMin": 10').replace('"id": "b",\n', '"id": "b",\n      "mode": "active",\n'));
    // A param added to a one-line params object stays on its line; one removed takes its comma.
    const a = replaceInstance(HAND_WRITTEN, "probe/a", { mode: "shadow", params: { sensor: "binary_sensor.a_motion", light: "light.a", texts: { on: "Light" } }, alerts: true });
    expect(a).toBe(
      HAND_WRITTEN.replace(
        '"params": { "sensor": "binary_sensor.a_motion", "light": "light.a" }\n',
        '"params": { "sensor": "binary_sensor.a_motion", "light": "light.a", "texts": { "on": "Light" } },\n      "alerts": true\n',
      ),
    );
    expect(replaceInstance(a, "probe/a", { mode: "shadow", params: { sensor: "binary_sensor.a_motion", light: "light.a" } })).toBe(HAND_WRITTEN);
    // Nothing different: the very same text.
    expect(replaceInstance(HAND_WRITTEN, "probe/b", { params: { delayMin: 3, sensor: "binary_sensor.b_motion", light: "light.b" } })).toBe(HAND_WRITTEN);
  });

  it("removes an instance with its comma: the first, the last, the only one", () => {
    const withoutA = removeInstance(HAND_WRITTEN, "probe/a");
    expect(JSON.parse(withoutA)).toEqual({ ...JSON.parse(HAND_WRITTEN), instances: [JSON.parse(HAND_WRITTEN).instances[1]] });
    expect(withoutA).toBe(HAND_WRITTEN.replace(/    \{\n      "heuristic": "probe",\n      "id": "a",[^}]*\}\n    \},\n/, ""));
    const withoutB = removeInstance(HAND_WRITTEN, "probe/b");
    expect(withoutB).toBe(HAND_WRITTEN.slice(0, HAND_WRITTEN.indexOf(",\n    {\n      \"id\": \"b\"")) + "\n  ]\n}\n");
    expect(removeInstance(withoutB, "probe/a")).toBe('{\n  "$schema": ".teob/heuristics.schema.json",\n  "_readme": "what runs in this house",\n  "instances": []\n}\n');
    expect(() => removeInstance(HAND_WRITTEN, "probe/z")).toThrow(/no instance probe\/z/);
  });
});

describe("the check the panel and the server share", () => {
  it("takes a kebab-case id not yet used, and the loader's rules for the rest", () => {
    expect(newIdProblem("back-door", ["front"])).toBeUndefined();
    expect(newIdProblem("Back Door", [])).toMatch(/^id: lower case/);
    expect(newIdProblem("front", ["front"])).toMatch(/already is an instance "front"/);
    expect(checkInstance(PROBE_PARAMS.spec, { mode: "loud", alerts: "yes", notifyPerHour: 0, commandHelp: { x: 1 }, params: { sensor: "light.a", light: "light.a" } })).toEqual([
      'mode: expected off, shadow or active, got "loud"',
      'alerts: expected true or false, got "yes"',
      "notifyPerHour must be a positive whole number, got 0",
      'commandHelp: expected an object of descriptions by command name, got {"x":1}',
      'params.sensor: expected an entity id of domain binary_sensor, got "light.a"',
    ]);
    expect(checkInstance(undefined, { params: { anything: true } })).toEqual([]);
  });
});

describe("the instance endpoints", () => {
  it("adds an instance: written after the others, running, journaled with who and what", async () => {
    const h = house();
    const res = await h.send("POST", "/api/instances", { heuristic: "probe", id: "c", params: { sensor: "binary_sensor.c_motion", light: "light.a" } });
    expect(res.status).toBe(422); // light.a is probe/a's: two owners
    expect(h.text()).toBe(HAND_WRITTEN);

    const outside = await h.send("POST", "/api/instances", { heuristic: "probe", id: "c", params: { sensor: "binary_sensor.c_motion", light: "light.c" }, alerts: true });
    expect(outside.status).toBe(422); // light.c may not be switched
    expect(h.changes()).toEqual([]);

    const added = await h.send("POST", "/api/instances", { heuristic: "free", id: "night", params: { watch: ["binary_sensor.c_motion"] } });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ ok: true, by: "person:Alex", summary: "+1 −0 ~0 unchanged 2" });
    expect(h.text().startsWith(HAND_WRITTEN.slice(0, HAND_WRITTEN.lastIndexOf("\n  ]")))).toBe(true);
    expect(JSON.parse(h.text()).instances[2]).toEqual({ heuristic: "free", id: "night", mode: "shadow", params: { watch: ["binary_sensor.c_motion"] } });
    expect(h.keys()).toContain("free/night");
    expect(h.changes()).toMatchObject([{ file: "heuristics.json", by: "person:Alex", summary: "+free/night (shadow)", instances: ["free/night"] }]);
  });

  it("replaces an instance's fields: only those values change in the file, the summary says which", async () => {
    const h = house();
    const res = await h.send("PUT", "/api/instances/probe/b", { mode: "active", params: { light: "light.b", sensor: "binary_sensor.b_motion", delayMin: 10 }, notifyPerHour: 4 });
    expect(res.status).toBe(200);
    expect(h.text()).toBe(
      HAND_WRITTEN.replace('"delayMin": 3\n      }', '"delayMin": 10\n      },\n      "notifyPerHour": 4').replace('"id": "b",\n', '"id": "b",\n      "mode": "active",\n'),
    );
    expect(h.host.instances().find((i) => i.key === "probe/b")).toMatchObject({ mode: "active", notifyPerHour: 4 });
    expect(h.changes()).toMatchObject([{ by: "person:Alex", summary: "probe/b: mode shadow → active, params changed (delayMin 3 → 10), notifyPerHour unset → 4", instances: ["probe/b"] }]);
    // The note a person left stays.
    expect(JSON.parse(h.text()).instances[1]._note).toBe("the stairs");
  });

  it("removes an instance", async () => {
    const h = house();
    const res = await h.send("DELETE", "/api/instances/probe/a");
    expect(res.status).toBe(200);
    expect(h.keys()).toEqual(["probe/b"]);
    expect(JSON.parse(h.text())).toMatchObject({ $schema: ".teob/heuristics.schema.json", _readme: "what runs in this house" });
    expect(h.changes()).toMatchObject([{ summary: "−probe/a", instances: ["probe/a"] }]);
  });

  it("a reload that rejects the edit puts the file back and journals nothing", async () => {
    const h = house();
    // light.c is in the scope but not operable: only the reload can tell.
    const res = await h.send("PUT", "/api/instances/probe/a", { mode: "shadow", params: { sensor: "binary_sensor.a_motion", light: "light.c" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/outside the house scope.*light\.c/) });
    expect(h.text()).toBe(HAND_WRITTEN);
    expect(h.host.instances().find((i) => i.key === "probe/a")?.params).toEqual({ sensor: "binary_sensor.a_motion", light: "light.a" });
    expect(h.changes()).toEqual([]);
  });

  it("refuses before writing: a bad id, a taken id, an unknown heuristic, params the loader would refuse", async () => {
    const h = house();
    const problems = async (body: unknown) => {
      const res = await h.send("POST", "/api/instances", body);
      expect(res.status).toBe(422);
      return ((await res.json()) as { problems: string[] }).problems;
    };
    expect(await problems({ heuristic: "probe", id: "Back Door", params: { sensor: "binary_sensor.c_motion", light: "light.c" } })).toEqual([
      'id: lower case letters, digits and dashes (like back-door), got "Back Door"',
    ]);
    expect(await problems({ heuristic: "probe", id: "a", params: { sensor: "binary_sensor.c_motion", light: "light.c" } })).toEqual(['id: there already is an instance "a" of this heuristic']);
    expect(await problems({ heuristic: "nope", id: "x", params: {} })).toEqual(['heuristic: unknown heuristic "nope"']);
    expect(await problems({ heuristic: "probe", id: "c", params: { sensor: "binary_sensor.c_motion", delayMin: -1, colour: "red" } })).toEqual([
      "params.colour: unknown, expected one of sensor, light, delayMin, texts",
      "params.light: missing, expected an entity id of domain light",
      "params.delayMin: expected minutes: a number > 0, got -1",
    ]);
    expect(await problems({ heuristic: "free", id: "x", params: {}, colour: "red" })).toEqual([expect.stringMatching(/^colour: unknown/)]);
    const put = await h.send("PUT", "/api/instances/probe/a", { mode: "active", params: { sensor: "binary_sensor.a_motion" } });
    expect(put.status).toBe(422);
    expect(await put.json()).toMatchObject({ ok: false, problems: ["params.light: missing, expected an entity id of domain light"] });
    expect(h.text()).toBe(HAND_WRITTEN);
    expect(h.changes()).toEqual([]);
  });

  it("answers an unknown instance, a rename, a bad body and a write from outside ingress without touching the file", async () => {
    const h = house();
    expect((await h.send("PUT", "/api/instances/probe/z", { params: {} })).status).toBe(404);
    expect((await h.send("DELETE", "/api/instances/probe/z")).status).toBe(404);
    expect((await h.send("PUT", "/api/instances/probe/a", { id: "b", params: {} })).status).toBe(400);
    expect((await h.send("POST", "/api/instances", [1])).status).toBe(400);
    expect((await h.send("DELETE", "/api/instances/probe/a", undefined, "172.30.33.5")).status).toBe(403);
    expect((await h.send("POST", "/api/instances", { heuristic: "free", id: "x", params: {} }, "172.30.33.5")).status).toBe(403);
    expect(h.text()).toBe(HAND_WRITTEN);
    expect(h.changes()).toEqual([]);
  });

  it("the first instance from the panel writes heuristics.json; a rejected one leaves no file", async () => {
    const h = house(null);
    const bad = await h.send("POST", "/api/instances", { heuristic: "probe", id: "c", params: { sensor: "binary_sensor.c_motion", light: "light.c" } });
    expect(bad.status).toBe(422);
    expect(existsSync(join(h.dir, "heuristics.json"))).toBe(false);
    const ok = await h.send("POST", "/api/instances", { heuristic: "probe", id: "a", params: { sensor: "binary_sensor.a_motion", light: "light.a" } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(h.text())).toEqual({ instances: [{ heuristic: "probe", id: "a", mode: "shadow", params: { sensor: "binary_sensor.a_motion", light: "light.a" } }] });
    unlinkSync(join(h.dir, "heuristics.json"));
  });

  it("reads an instance as written, and the catalogue with the pickers' entities", async () => {
    const h = house();
    const inst = await h.send("GET", "/api/instances/probe/b");
    expect(await inst.json()).toEqual(JSON.parse(HAND_WRITTEN).instances[1]);
    expect((await h.send("GET", "/api/instances/probe/z")).status).toBe(404);

    const lib = (await (await h.send("GET", "/api/library")).json()) as { heuristics: CatalogueEntry[]; entities: PickerEntity[] };
    expect(lib.heuristics.map((e) => [e.id, e.own, e.params === null])).toEqual([
      ["probe", false, false],
      ["free", true, true],
    ]);
    expect(lib.heuristics[0]).toMatchObject({ title: "Probe", pattern: "trigger", rule: false, guarantees: "Leaves a light switched by hand alone.", notifyPerHour: 12 });
    expect(lib.heuristics[0]!.params!.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["sensor", "entity", true],
      ["light", "entity", true],
      ["delayMin", "duration", false],
      ["texts", "texts", false],
    ]);
    expect(lib.entities).toContainEqual({ id: "light.a", name: "Hall", operate: true });
    expect(lib.entities).toContainEqual({ id: "light.c", operate: false });
    expect(lib.entities.some((e) => e.id === "camera.outside")).toBe(false);
  });
});
