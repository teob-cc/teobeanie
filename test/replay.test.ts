// replay: a heuristic over recorded history, in shadow and in drive mode.

import { describe, expect, it } from "vitest";
import { minutes } from "../src/kernel/heuristic.js";
import { rule } from "../src/kernel/rule.js";
import { sensorLight } from "../packages/sensor-light/sensor-light.ts";
import { compare, fmtAt, formatParity, houseChanges, replay, type Recorded } from "../src/replay.js";

const T0 = Date.UTC(2026, 0, 5, 18, 0, 0);
const at = (min: number) => T0 + minutes(min);
const params = { sensors: ["binary_sensor.den_motion"], lights: ["light.den"], offAfterMin: 5 };

// Another automation switches the light on with the motion and off after 2 min of quiet.
const recorded: Recorded[] = [
  { entity: "binary_sensor.den_motion", at: at(-60), state: "off", attributes: {} },
  { entity: "light.den", at: at(-60), state: "off", attributes: {} },
  { entity: "binary_sensor.den_motion", at: at(10), state: "on", attributes: {} },
  { entity: "light.den", at: at(10) + 500, state: "on", attributes: {} },
  { entity: "binary_sensor.den_motion", at: at(12), state: "off", attributes: {} },
  { entity: "light.den", at: at(14), state: "off", attributes: {} },
];
const span = { from: at(0), to: at(60) };

describe("replay", () => {
  it("shadow: the recorded world, so the other automation's early off leaves Teobeanie nothing to do", () => {
    const calls = replay(sensorLight, params, recorded, span);
    expect(calls.map((c) => `${c.service} ${c.entity}`)).toEqual(["light.turn_on light.den"]);
  });

  it("drive: Teobeanie's calls take effect, the replaced automation's switches are dropped", () => {
    const calls = replay(sensorLight, params, recorded, span, { drive: { keep: (r) => r.entity !== "light.den" } });
    expect(calls.map((c) => [c.service, (c.at - T0) / 60_000])).toEqual([
      ["light.turn_on", 10],
      ["light.turn_off", 17],
    ]);
  });

  it("compares calls with the recorded changes: matched, Teobeanie only, house only", () => {
    const calls = replay(sensorLight, params, recorded, span, { drive: { keep: (r) => r.entity !== "light.den" } });
    const changes = houseChanges(recorded, ["light.den"]).map((c) => ({ ...c, by: "other" }));
    const [row] = compare(calls, changes, ["light.den"], 120_000);
    expect(row!.matched).toBe(1);
    expect(row!.teobOnly.map((t) => [t.call.service, t.offset])).toEqual([["light.turn_off", minutes(3)]]);
    expect(row!.houseOnly.map((h) => [h.change.state, h.offset])).toEqual([["off", -minutes(3)]]);
    expect(formatParity([row!], 120_000)).toContain("3 min after the house's");
  });
});

describe("replay in the house's time zone", () => {
  const porch = rule("porch", ({ ha, between }) => ha.light.porch.to(between("19:00", "23:00") ? "on" : "off"));
  const lights: Recorded[] = [{ entity: "light.porch", at: at(-60), state: "off", attributes: {} }];

  it("clock rules run, and times print, in the zone it is given", () => {
    // T0 = 18:00 UTC = 03:00 next day in Tokyo, 13:00 in New York: night in neither.
    const day = { from: T0, to: T0 + 24 * 3_600_000 };
    const tokyo = replay(porch, undefined, lights, day, { house: { timeZone: "Asia/Tokyo" } });
    const ny = replay(porch, undefined, lights, day, { house: { timeZone: "America/New_York" } });
    expect(tokyo.map((c) => [c.service, fmtAt(c.at, "Asia/Tokyo")])).toEqual([["light.turn_on", "06 Jan, 19:00"], ["light.turn_off", "06 Jan, 23:00"]]);
    expect(ny.map((c) => [c.service, fmtAt(c.at, "America/New_York")])).toEqual([["light.turn_on", "05 Jan, 19:00"], ["light.turn_off", "05 Jan, 23:00"]]);
    expect([tokyo[0]!.at, ny[0]!.at]).toEqual([Date.UTC(2026, 0, 6, 10, 0), Date.UTC(2026, 0, 6, 0, 0)]);
    const [row] = compare(ny, [], ["light.porch"], 120_000);
    expect(formatParity([row!], 120_000, { timeZone: "America/New_York" })).toContain("05 Jan, 19:00 on");
    expect(formatParity([row!], 120_000)).toContain("06 Jan, 00:00 on"); // no zone: UTC
  });
});
