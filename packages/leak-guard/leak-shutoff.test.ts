// leak-shutoff: a wet sensor closes the valve; reopening is never automatic.

import { describe, expect, it, simulate } from "teobeanie/test";
import { leakShutoff } from "./leak-shutoff.ts";

describe("leak-shutoff", () => {
  const params = { sensors: ["binary_sensor.leak_kitchen", "binary_sensor.leak_meters"], valve: "switch.water_valve", text: "Water leak! Shutting off water!" };

  it("forbids reopening with the instance's reason, or the default one", () => {
    expect(leakShutoff.forbids!(params).map((f) => f.reason)).toEqual(Array(2).fill("reopening the water valve after a leak is human-only"));
    expect(leakShutoff.forbids!({ ...params, forbidReason: "only by hand" }).map((f) => f.reason)).toEqual(["only by hand", "only by hand"]);
  });

  it("closes the valve and alerts on any wet sensor", () => {
    const sim = simulate(leakShutoff, params, { "binary_sensor.leak_kitchen": "off", "binary_sensor.leak_meters": "off", "switch.water_valve": "on" });
    sim.set("binary_sensor.leak_meters", "on");
    expect(sim.calls()).toEqual(["switch.turn_off switch.water_valve", "notify: Water leak! Shutting off water! binary_sensor.leak_meters"]);
    sim.set("binary_sensor.leak_meters", "off");
    expect(sim.calls()).toHaveLength(2); // drying never reopens
  });

  it("shuts off at start if a sensor is already wet", () => {
    const sim = simulate(leakShutoff, params, { "binary_sensor.leak_kitchen": "on", "binary_sensor.leak_meters": "off", "switch.water_valve": "on" }).start();
    expect(sim.calls()[0]).toBe("switch.turn_off switch.water_valve");
  });
});
