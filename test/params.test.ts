// Parameter schemas: every library heuristic has one, the loader checks instances
// against it (a misfit is a problem for that instance, which does not start), and
// describeParams gives the same schema as JSON for the panel's editor.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTER as LIBRARY } from "./starter.js";
import { GARAGE_DOOR_TEXTS } from "../packages/garage-door/garage-door.ts";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { loadCustomHeuristics } from "../src/kernel/custom.js";
import { defineHeuristic, type AnyHeuristic } from "../src/kernel/heuristic.js";
import { createHeuristicHost, type InstanceConfig } from "../src/kernel/host.js";
import { checkParams, describeParams, param, validateParams, type Infer } from "../src/kernel/params.js";
import { simulate } from "../src/kernel/simulate.js";
import { heuristicsJsonSchema } from "../src/studio/config-schema.js";

const root = join(import.meta.dirname, "..");
const noLog = (): void => {};
const byId = (id: string): AnyHeuristic => LIBRARY.find((d) => d.id === id)!;
const instancesOf = (dir: string): InstanceConfig[] =>
  (JSON.parse(readFileSync(join(root, "examples", dir, "heuristics.json"), "utf8")) as { instances: InstanceConfig[] }).instances;

const hall = { sensors: ["binary_sensor.hall_motion"], lights: ["light.hall"], offAfterMin: 5 };

describe("parameter schemas", () => {
  it("every library heuristic has one", () => {
    expect(LIBRARY.filter((d) => d.params === undefined).map((d) => d.id)).toEqual([]);
  });

  it("every example instance fits its heuristic's schema", () => {
    for (const dir of ["starter", "rules", "custom-heuristic"]) {
      for (const i of instancesOf(dir)) {
        const def = LIBRARY.find((d) => d.id === i.heuristic);
        // The house's own heuristics (rules, a decider) have none: anything goes, as before.
        expect(def === undefined ? [] : validateParams(def, i.params), `${dir}: ${i.heuristic}/${i.id}`).toEqual([]);
      }
    }
  });

  it("a wrong domain, a missing param, an unknown key and a bad duration are each named, with the path and what was expected", () => {
    const sensorLight = byId("sensor-light");
    expect(validateParams(sensorLight, { ...hall, lights: ["light.hall", "sensor.hall_lux"] })).toEqual([
      'params.lights[1]: expected an entity id of domain light or switch, got "sensor.hall_lux"',
    ]);
    expect(validateParams(byId("door-nag"), { door: "binary_sensor.front_door", text: "Front door open" })).toEqual([
      "params.everyMin: missing, expected minutes: a number > 0",
    ]);
    expect(validateParams(sensorLight, { ...hall, offAfterMins: 5 })).toEqual([
      "params.offAfterMins: unknown, expected one of sensors, activeStates, lights, offAfterMin, dark, level, levels, keepOnWhile",
    ]);
    expect(validateParams(sensorLight, { ...hall, offAfterMin: "5m" })).toEqual(['params.offAfterMin: expected minutes: a number ≥ 0, got "5m"']);
    expect(validateParams(sensorLight, { ...hall, offAfterMin: -1 })).toEqual(["params.offAfterMin: expected minutes: a number ≥ 0, got -1"]);
  });

  it("nested objects, lists, times, alternatives and texts are checked too", () => {
    const sensorLight = byId("sensor-light");
    expect(validateParams(sensorLight, { ...hall, levels: [{ from: "22:00", to: "7:00", brightnessPct: 30 }, { from: "25:00", to: "06:00" }] })).toEqual([
      'params.levels[1].from: expected a time "HH:MM", got "25:00"',
    ]);
    // dark is one of three shapes: the one whose keys are there is the one meant.
    expect(validateParams(sensorLight, { ...hall, dark: { illuminance: "sensor.hall_lux", below: "dim" } })).toEqual([
      'params.dark.below: expected a number (lx), got "dim"',
    ]);
    expect(validateParams(sensorLight, { ...hall, dark: { sunBelow: 3 } })).toEqual([]);
    expect(validateParams(sensorLight, { ...hall, dark: { lux: 3 } })).toEqual([
      "params.dark: expected one of illuminance {illuminance, below}, tooBright {tooBright}, sunBelow {sunBelow}, got {\"lux\":3}",
    ]);
    const garage = { button: "switch.opener", contact: "binary_sensor.garage_door", commands: { open: "garage_open", close: "garage_close" } };
    expect(validateParams(byId("garage-door"), { ...garage, texts: { open: "Open!" } })).toEqual([]);
    expect(validateParams(byId("garage-door"), { ...garage, texts: { opn: "Open!", closed: 3 } })).toEqual([
      `params.texts.opn: unknown, expected one of ${Object.keys(GARAGE_DOOR_TEXTS).join(", ")}`,
      "params.texts.closed: expected a string, got 3",
    ]);
    // climate-guard's waiver: a room and a command, hours above 0.
    const den = { climate: "climate.den", setpoints: { heat: 20 } };
    expect(validateParams(byId("climate-guard"), { ...den, waive: { command: "climate_waive", room: "den", hours: 0 } })).toEqual([
      "params.waive.hours: expected hours: a number > 0, got 0",
    ]);
    expect(validateParams(byId("climate-guard"), { ...den, waive: { command: "climate_waive" } })).toEqual(["params.waive.room: missing, expected a string"]);
    // No params at all: what is missing is named.
    expect(validateParams(byId("relay-pulse"), undefined)).toEqual([
      "params.relays: missing, expected a list of entity ids of domain switch",
      "params.pressMs: missing, expected milliseconds: a number ≥ 0",
      "params.recheckMs: missing, expected milliseconds: a number ≥ 0",
    ]);
  });

  it("the loader leaves an instance whose params do not fit out (with why), and a reload that needs it is rejected", () => {
    const logged: string[] = [];
    const instances: InstanceConfig[] = [
      { heuristic: "sensor-light", id: "hall", params: hall },
      { heuristic: "sensor-light", id: "porch", params: { ...hall, lights: ["sensor.porch"] } },
    ];
    const host = createHeuristicHost({
      library: LIBRARY,
      instances,
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
      liveState: () => undefined,
      forceShadow: true,
      log: (_l, m) => logged.push(m),
    });
    expect(host.instances().map((i) => i.key)).toEqual(["sensor-light/hall"]);
    expect(logged).toEqual([
      'heuristics.json: sensor-light/porch: params.lights[0]: expected an entity id of domain light or switch, got "sensor.porch" — skipped',
    ]);
    expect(() => host.prepare({ library: LIBRARY, instances })).toThrow(/sensor-light\/porch: params\.lights\[0\]/);
  });

  it("simulate refuses params the loader would", () => {
    expect(() => simulate(byId("door-nag"), { door: "binary_sensor.front_door", everyMin: 0, text: "Open" })).toThrow(
      "door-nag: params.everyMin: expected minutes: a number > 0, got 0",
    );
  });

  it("a heuristic of the house's own may declare a schema with the toolkit; one without takes anything", async () => {
    const PARAMS = param.object({ power: param.entity("sensor"), quietMin: param.duration("min").default(3) });
    const done = defineHeuristic<Infer<typeof PARAMS>, Record<string, never>, never>({
      id: "done",
      title: "Done",
      description: "",
      params: PARAMS,
      watch: (p) => [p.power],
      actuates: () => [],
      initial: () => ({}),
      decide: () => undefined,
      evolve: (s) => s,
    });
    expect(validateParams(done, { power: "switch.washer" })).toEqual(['params.power: expected an entity id of domain sensor, got "switch.washer"']);
    expect(validateParams({ ...done, params: undefined }, { power: "switch.washer", anything: true })).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "teobeanie-params-"));
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(
      join(dir, "heuristics", "bad-schema.js"),
      `export default { id: "bad-schema", title: "", description: "", params: { power: "sensor" }, watch: () => [], actuates: () => [], initial: () => ({}), decide: () => undefined, evolve: (s) => s };\n`,
    );
    const failures: string[] = [];
    expect(await loadCustomHeuristics(dir, LIBRARY, noLog, failures)).toEqual([]);
    expect(failures).toEqual(["bad-schema.js: params must be a schema made with param.object({ ... })"]);
  });
});

describe("describeParams", () => {
  it("is JSON, round-trips, and checks exactly as the loader does from the JSON alone", () => {
    const samples: Array<[string, unknown]> = [
      ["sensor-light", { ...hall, lights: ["sensor.hall"], extra: 1 }],
      ["garage-door", { button: "light.l1", contact: "binary_sensor.door", commands: { open: "garage_open" } }],
      ["hold", { target: "climate.study", value: true }],
    ];
    for (const def of LIBRARY) {
      const fields = describeParams(def)!;
      const json = JSON.parse(JSON.stringify(fields)) as typeof fields;
      expect(json, def.id).toEqual(fields);
      // Every parameter says what it is for.
      expect(json.filter((f) => f.doc === undefined).map((f) => f.name), def.id).toEqual([]);
      const spec = { kind: "object" as const, required: true, fields: json };
      for (const [id, params] of samples.filter(([id]) => id === def.id)) {
        expect(checkParams(spec, params), id).toEqual(validateParams(def, params));
        expect(checkParams(spec, params).length, id).toBeGreaterThan(0);
      }
    }
  });

  it("names, kinds, domains, units, defaults and texts with their slots", () => {
    expect(describeParams(byId("door-nag"))).toEqual([
      { name: "door", kind: "entity", required: true, doc: "The door contact: on = open." },
      { name: "everyMin", kind: "duration", required: true, unit: "min", positive: true, doc: "Minutes between reminders, the first one after the door opened." },
      { name: "text", kind: "text", required: true, doc: "The reminder." },
      { name: "quietWhileOn", kind: "entity", required: false, doc: "Skip a reminder (but keep counting) while this entity is on." },
      { name: "onlyWhileFact", kind: "string", required: false, doc: "A fact id (nobody-near-garage): remind only while this fact is true; a skipped reminder keeps the count." },
    ]);
    const garage = describeParams(byId("garage-door"))!;
    expect(garage.find((f) => f.name === "button")).toMatchObject({ kind: "entity", domains: ["switch"] });
    expect(garage.find((f) => f.name === "confirmSec")).toMatchObject({ kind: "duration", unit: "s", required: false, default: 30 });
    const texts = garage.find((f) => f.name === "texts")!;
    expect(texts.kind).toBe("texts");
    expect(texts.fields!.find((f) => f.name === "autoAnnounce")).toMatchObject({ kind: "text", default: "Garage is open and no one is in it. I'll close it in {min} min.{keep}", slots: ["min", "keep"] });
    const waive = describeParams(byId("climate-guard"))!.find((f) => f.name === "waive")!;
    expect(waive.fields!.map((f) => [f.name, f.kind, f.required, f.default])).toEqual([
      ["command", "string", true, undefined],
      ["room", "string", true, undefined],
      ["hours", "duration", false, 3],
    ]);
    expect(describeParams({})).toBeUndefined();
  });

  it("cli.js types' heuristics.schema.json carries every schema", () => {
    const schema = heuristicsJsonSchema(LIBRARY) as { properties: { instances: { items: { allOf: Array<{ if: unknown; then: { properties: { params: Record<string, unknown> } } }> } } } };
    const allOf = schema.properties.instances.items.allOf;
    expect(allOf.length).toBe(LIBRARY.length);
    const sensorLight = allOf.find((a) => JSON.stringify(a.if).includes('"sensor-light"'))!.then.properties.params as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(sensorLight.required).toEqual(["sensors", "lights", "offAfterMin"]);
    expect(sensorLight.additionalProperties).toBe(false);
    expect(sensorLight.properties["lights"]).toMatchObject({ type: "array", items: { pattern: "^(light|switch)\\.[a-z0-9_]+$" } });
    expect(sensorLight.properties["offAfterMin"]).toMatchObject({ type: "number", minimum: 0 });
  });
});
