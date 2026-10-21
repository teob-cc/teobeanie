// The panel's instance editor, its model: a heuristic's schema as form fields and
// back, the server's own check run on the draft, and each problem shown at its field.

import { describe, expect, it } from "vitest";
import { describeParams, param } from "../src/kernel/params.js";
import { sensorLight } from "../packages/sensor-light/sensor-light.ts";
import {
  alternativeOf,
  blank,
  countSet,
  draftOf,
  draftProblems,
  newDraft,
  numberFrom,
  paramsFromJson,
  pickable,
  placeholderOf,
  problemsAt,
  problemsUnder,
  setField,
  splitFields,
  toInstance,
  unitOf,
  valueFrom,
  valueText,
} from "../panel/src/instanceForm.js";

const fields = describeParams(sensorLight)!;
const entry = { id: "sensor-light", params: fields };
const field = (name: string) => fields.find((f) => f.name === name)!;

describe("a draft instance", () => {
  it("starts in shadow with nothing set, and is checked as the server checks it", () => {
    const d = newDraft(entry);
    expect(toInstance(d)).toEqual({ heuristic: "sensor-light", id: "", mode: "shadow", params: {} });
    const problems = draftProblems(entry, d, ["hallway"]);
    expect(problems[0]).toMatch(/^id: lower case/);
    expect(problemsAt(problems, "params.sensors")).toEqual(["missing, expected a list of entity ids"]);
    expect(problemsAt(problems, "params.lights")).toEqual([expect.stringMatching(/^missing, expected a list of entity ids/)]);

    const filled = { ...d, id: "porch", params: { sensors: ["binary_sensor.porch_motion"], lights: ["light.porch"], offAfterMin: 3 } };
    expect(draftProblems(entry, filled, ["hallway"])).toEqual([]);
    expect(draftProblems(entry, { ...filled, id: "hallway" }, ["hallway"])).toEqual(['id: there already is an instance "hallway" of this heuristic']);
    // Editing one: its id is not checked again.
    expect(draftProblems(entry, { ...filled, id: "Old Name" }, null)).toEqual([]);
  });

  it("round-trips an instance of heuristics.json; alerts and commandHelp only when they say something", () => {
    const inst = { heuristic: "sensor-light", id: "porch", mode: "active" as const, params: { sensors: [], lights: [] }, notifyPerHour: 4 };
    expect(toInstance(draftOf(inst))).toEqual(inst);
    const d = { ...draftOf(inst), alerts: true, commandHelp: { porch_on: "Porch light on", "": "" } };
    expect(toInstance(d)).toEqual({ ...inst, alerts: true, commandHelp: { porch_on: "Porch light on" } });
    expect(draftProblems({ params: null }, { ...d, notifyPerHour: "lots" }, null)).toEqual(['notifyPerHour must be a positive whole number, got "lots"']);
  });

  it("a heuristic without a schema takes its params as JSON, checked by the reload", () => {
    expect(paramsFromJson('{ "a": 1 }')).toEqual({ params: { a: 1 } });
    expect(paramsFromJson("")).toEqual({ params: {} });
    expect(paramsFromJson("{ a: 1 }")).toMatchObject({ problem: expect.stringMatching(/^params: not JSON/) });
    expect(draftProblems({ params: null }, { ...newDraft({ id: "mine" }), id: "x", params: { anything: [1] } }, [])).toEqual([]);
  });
});

describe("fields from the schema", () => {
  it("puts the required fields first and the optional ones in a section that counts what is set", () => {
    const { required, optional } = splitFields(fields);
    expect(required.map((f) => f.name)).toEqual(["sensors", "lights", "offAfterMin"]);
    expect(optional.length).toBeGreaterThan(0);
    expect(countSet(optional, { sensors: [], level: { brightnessPct: 40 } })).toBe(1);
    expect(problemsUnder(["params.dark.illuminance: missing, expected ...", "params.lights: missing"], "params.dark")).toBe(1);
  });

  it("shows units, defaults as placeholders, and starts what someone adds empty", () => {
    expect(unitOf(field("offAfterMin"))).toBe("minutes");
    expect(unitOf(param.number({ unit: "lx" }).spec)).toBe("lx");
    expect(placeholderOf(param.duration("s").default(30).spec)).toBe("30");
    expect(placeholderOf(param.strings().default(["on"]).spec)).toBe('["on"]');
    expect(placeholderOf(param.text().default("Open").spec)).toBe("Open");
    expect([blank(field("sensors")), blank(param.object({}).spec), blank(param.bool().spec), blank(param.time().spec)]).toEqual([[], {}, false, undefined]);
  });

  it("keeps what was typed until it is valid: an unfinished number is a problem, not lost", () => {
    expect([numberFrom(""), numberFrom("12"), numberFrom("2,5"), numberFrom("12a")]).toEqual([undefined, 12, 2.5, "12a"]);
    expect([valueFrom("on"), valueFrom("21"), valueFrom('{"temperature": 21}'), valueFrom("{nope"), valueFrom("")]).toEqual(["on", 21, { temperature: 21 }, "{nope", undefined]);
    expect([valueText("heat"), valueText({ temperature: 21 }), valueText(undefined)]).toEqual(["heat", '{"temperature":21}', ""]);
    expect(setField({ a: 1, b: 2 }, "a", undefined)).toEqual({ b: 2 });
    expect(setField(undefined, "a", 1)).toEqual({ a: 1 });
  });

  it("tells a oneOf's alternative from the keys a value has", () => {
    const dark = field("dark");
    expect(dark.kind).toBe("oneOf");
    const names = dark.alternatives!.map((a) => a.name);
    const illuminance = dark.alternatives!.find((a) => (a.fields ?? []).some((f) => f.name === "illuminance"))!;
    expect(alternativeOf(dark, { illuminance: "sensor.porch_lux" })).toBe(names.indexOf(illuminance.name));
    expect(alternativeOf(dark, {})).toBe(-1);
    expect(alternativeOf(dark, undefined)).toBe(-1);
  });

  it("offers the house's entities of the field's domains", () => {
    const entities = [
      { id: "light.porch", name: "Porch", operate: true },
      { id: "switch.porch_lamp", operate: true },
      { id: "binary_sensor.porch_motion", operate: false },
    ];
    expect(pickable(entities, field("lights").domains).map((e) => e.id)).toEqual(["light.porch", "switch.porch_lamp"]);
    expect(pickable(entities, undefined)).toHaveLength(3);
  });
});
