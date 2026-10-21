// appliance-auto-off: off once the room has been empty, a keep-on window, a switch-on time.

import { describe, expect, it, simulate } from "teobeanie/test";
import { minutes } from "teobeanie";
import { applianceAutoOff } from "./appliance-auto-off.ts";

describe("appliance-auto-off (coffee machine)", () => {
  const p = {
    occupancy: "binary_sensor.kitchen",
    appliance: "switch.coffee_machine",
    vacantMin: 10,
    keepOn: { from: "08:00", to: "10:00" },
    onAt: "07:00:00",
    timeZone: "Europe/Amsterdam",
  };
  const world = { "binary_sensor.kitchen": "on", "switch.coffee_machine": "on" };

  it("stays on inside the morning window (Amsterdam time, DST-aware)", () => {
    // 2026-07-06 07:00 UTC = 09:00 CEST — inside the window.
    const sim = simulate(applianceAutoOff, p, world, { t0: Date.UTC(2026, 6, 6, 7, 0) });
    sim.set("binary_sensor.kitchen", "off").advance(minutes(10));
    expect(sim.calls()).toEqual([]);
    expect(sim.whys().at(-1)).toContain("keep-on window");
  });

  it("without a timeZone param, the window is in the house's zone", () => {
    const { timeZone: _own, ...houseLocal } = p;
    // 2026-07-06 13:00 UTC = 09:00 in New York (EDT): inside the window there, not in UTC.
    const t0 = Date.UTC(2026, 6, 6, 13, 0);
    const ny = simulate(applianceAutoOff, houseLocal, world, { t0, timeZone: "America/New_York" });
    ny.set("binary_sensor.kitchen", "off").advance(minutes(10));
    expect(ny.calls()).toEqual([]);
    const utc = simulate(applianceAutoOff, houseLocal, world, { t0 });
    utc.set("binary_sensor.kitchen", "off").advance(minutes(10));
    expect(utc.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });

  it("goes off after vacancy outside the window", () => {
    // 2026-01-05 12:00 UTC = 13:00 CET.
    const sim = simulate(applianceAutoOff, p, world);
    sim.set("binary_sensor.kitchen", "off").advance(minutes(10));
    expect(sim.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });

  it("switches on at the scheduled time trigger", () => {
    const sim = simulate(applianceAutoOff, p, { ...world, "switch.coffee_machine": "off" }).trigger("on-at");
    expect(sim.calls()).toEqual(["switch.turn_on switch.coffee_machine"]);
  });

  it("already off when the room has been empty for the run-on: no call", () => {
    const sim = simulate(applianceAutoOff, p, { "binary_sensor.kitchen": "on", "switch.coffee_machine": "off" }).start();
    sim.set("binary_sensor.kitchen", "off").advance(minutes(10));
    expect(sim.calls()).toEqual([]);
    expect(sim.whys().at(-1)).toContain("already off");
  });

  it("switched on (an app) in an empty room: off after the run-on", () => {
    // 2026-01-05 12:00 UTC = 13:00 CET, outside the window.
    const sim = simulate(applianceAutoOff, p, { "binary_sensor.kitchen": "off", "switch.coffee_machine": "off" }).start();
    sim.advance(minutes(30)).set("switch.coffee_machine", "on").advance(minutes(9));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });

  it("switched on shortly after the room emptied: the run-on counts from the switch-on", () => {
    const sim = simulate(applianceAutoOff, p, { "binary_sensor.kitchen": "on", "switch.coffee_machine": "off" }).start();
    sim.set("binary_sensor.kitchen", "off").advance(minutes(1)).set("switch.coffee_machine", "on");
    sim.advance(minutes(9));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });

  it("a room that empties inside the window switches it off when the window ends", () => {
    // 2026-01-05 08:00 UTC = 09:00 CET: empty at 09:00, still empty at 10:00.
    const sim = simulate(applianceAutoOff, p, world, { t0: Date.UTC(2026, 0, 5, 8, 0) }).start();
    sim.set("binary_sensor.kitchen", "off").advance(minutes(10));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(49));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });

  it("someone in the room when the window ends: off once it has been empty for the run-on", () => {
    const sim = simulate(applianceAutoOff, p, world, { t0: Date.UTC(2026, 0, 5, 8, 0) }).start();
    sim.set("binary_sensor.kitchen", "off").advance(minutes(30)).set("binary_sensor.kitchen", "on"); // 09:30 back
    sim.advance(minutes(40)).set("binary_sensor.kitchen", "off"); // 10:10 leaves
    sim.advance(minutes(9));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });

  it("switched on by the schedule into an empty room: off when the window ends", () => {
    // 2026-01-05 06:00 UTC = 07:00 CET; nobody comes, window 08:00–10:00.
    const sim = simulate(applianceAutoOff, p, { "binary_sensor.kitchen": "off", "switch.coffee_machine": "off" }, { t0: Date.UTC(2026, 0, 5, 6, 0) }).start();
    sim.trigger("on-at").set("switch.coffee_machine", "on");
    sim.advance(minutes(10)); // 07:10, before the window: the run-on is over
    expect(sim.calls()).toEqual(["switch.turn_on switch.coffee_machine", "switch.turn_off switch.coffee_machine"]);
  });

  it("on at 07:00 with a 07:00–09:30 window and nobody in: off at 09:30", () => {
    const morning = { ...p, keepOn: { from: "07:00", to: "09:30" } };
    const sim = simulate(applianceAutoOff, morning, { "binary_sensor.kitchen": "off", "switch.coffee_machine": "off" }, { t0: Date.UTC(2026, 0, 5, 6, 0) }).start();
    sim.trigger("on-at").set("switch.coffee_machine", "on");
    sim.advance(minutes(149));
    expect(sim.calls()).toEqual(["switch.turn_on switch.coffee_machine"]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["switch.turn_on switch.coffee_machine", "switch.turn_off switch.coffee_machine"]);
    expect(sim.whys().at(-1)).toContain("room empty for 10 min");
  });
});

describe("startup reconcile", () => {
  it("a coffee machine left on in a kitchen empty since before boot goes off on the original deadline", () => {
    const p = { occupancy: "binary_sensor.kitchen", appliance: "switch.coffee_machine", vacantMin: 10 };
    const sim = simulate(applianceAutoOff, p, { "binary_sensor.kitchen": "off", "switch.coffee_machine": "on" });
    sim.advance(minutes(7)).start().advance(minutes(3));
    expect(sim.calls()).toEqual(["switch.turn_off switch.coffee_machine"]);
  });
});
