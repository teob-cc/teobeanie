// hold: a value applied when a condition starts, optionally kept.

import { describe, expect, it, simulate } from "teobeanie/test";
import { hours, minutes, seconds } from "teobeanie";
import { hold, type HoldParams } from "./hold.ts";

const heat = (temperature: number | null) => ({ hvac_modes: ["off", "heat"], temperature });

describe("hold", () => {
  const setpoint: HoldParams = { target: "climate.study", value: { temperature: 20 }, when: { entity: "climate.study", is: ["heat"] } };

  it("applies the value each time the condition starts, and leaves a person's change alone in between", () => {
    const sim = simulate(hold, setpoint, { "climate.study": "off" }).start();
    sim.set("climate.study", "heat", heat(23));
    expect(sim.calls()).toEqual(["climate.set_temperature climate.study"]);
    expect(sim.actions()[0]!.action).toMatchObject({ data: { temperature: 20 } });
    sim.set("climate.study", "heat", heat(20)).set("climate.study", "heat", heat(22)); // a person turns it up
    expect(sim.calls()).toHaveLength(1);
    sim.set("climate.study", "off", heat(22)).set("climate.study", "heat", heat(22)); // heating off and on again
    expect(sim.calls()).toEqual(["climate.set_temperature climate.study", "climate.set_temperature climate.study"]);
  });

  it("at start, a target already at the value gets no call", () => {
    const sim = simulate(hold, setpoint, { "climate.study": { state: "heat", attributes: heat(20) } }).start();
    expect(sim.calls()).toEqual([]);
  });

  it("enforce sets a drifted target back, once per grace period", () => {
    const sim = simulate(hold, { ...setpoint, enforce: true }, { "climate.study": { state: "heat", attributes: heat(20) } }).start();
    sim.set("climate.study", "heat", heat(23)); // attribute-only change: a signal for an enforced target
    expect(sim.calls()).toEqual(["climate.set_temperature climate.study"]);
    expect(sim.whys().at(-1)).toMatch(/^study back to \{"temperature":20\} \(drifted: temperature 23\)/);
    sim.set("climate.study", "heat", heat(20)).advance(seconds(10)).set("climate.study", "heat", heat(24));
    expect(sim.calls()).toHaveLength(1); // within the grace period: waits
    sim.advance(minutes(1));
    expect(sim.calls()).toHaveLength(2);
  });

  it("a schedule: on between two clock times, off outside", () => {
    // t0 = 13:00 in Lagos (UTC+1).
    const plants = simulate(hold, { target: "switch.plants", value: "on", between: { from: "06:00", to: "22:00" }, otherwise: "off" }, { "switch.plants": "off" }, { timeZone: "Africa/Lagos" });
    plants.start();
    expect(plants.calls()).toEqual(["switch.turn_on switch.plants"]);
    plants.set("switch.plants", "on").advance(hours(9));
    expect(plants.calls()).toEqual(["switch.turn_on switch.plants", "switch.turn_off switch.plants"]);
  });
});
