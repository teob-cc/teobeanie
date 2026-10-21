// trigger: occupancy-light and follow-with-run-on on the simulator.

import { describe, expect, it, simulate } from "teobeanie/test";
import { minutes } from "teobeanie";
import { followWithRunOn, occupancyLight, trigger, type OccupancyLightParams } from "./trigger.ts";

describe("trigger pattern: occupancy-light", () => {
  const stairs: OccupancyLightParams = {
    occupancy: ["binary_sensor.stairs_a", "binary_sensor.stairs_b"],
    lights: ["light.stairs_1", "light.stairs_2"],
    offAfterMin: 5,
  };
  const world = { "binary_sensor.stairs_a": "off", "binary_sensor.stairs_b": "off", "light.stairs_1": "off", "light.stairs_2": "off" };
  const on = ["light.turn_on light.stairs_1", "light.turn_on light.stairs_2"];
  const off = ["light.turn_off light.stairs_1", "light.turn_off light.stairs_2"];

  it("switches on with occupancy and off after every sensor is vacant for offAfterMin", () => {
    const sim = simulate(occupancyLight, stairs, world).start();
    sim.set("binary_sensor.stairs_a", "on");
    expect(sim.calls()).toEqual(on);
    expect(sim.whys().at(-1)).toBe("stairs_1 → on, stairs_2 → on · stairs_a is on");
    sim.set("light.stairs_1", "on").set("light.stairs_2", "on");

    sim.set("binary_sensor.stairs_b", "on").set("binary_sensor.stairs_a", "off");
    sim.advance(minutes(10));
    expect(sim.calls()).toEqual(on); // b still occupied, and nothing re-sent

    sim.set("binary_sensor.stairs_b", "off").advance(minutes(4));
    expect(sim.calls()).toEqual(on);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual([...on, ...off]);
  });

  it("returning before the deadline cancels the switch-off", () => {
    const sim = simulate(occupancyLight, stairs, { ...world, "light.stairs_1": "on", "light.stairs_2": "on" });
    sim.set("binary_sensor.stairs_a", "on").set("binary_sensor.stairs_a", "off").advance(minutes(3));
    sim.set("binary_sensor.stairs_a", "on").advance(minutes(10));
    expect(sim.calls().filter((c) => c.includes("turn_off"))).toEqual([]);
  });

  it("a light switched off by hand stays off while the zone stays occupied", () => {
    const sim = simulate(occupancyLight, stairs, world).start();
    sim.set("binary_sensor.stairs_a", "on").set("light.stairs_1", "on").set("light.stairs_2", "on");
    sim.set("light.stairs_1", "off"); // by hand
    sim.set("binary_sensor.stairs_b", "on").set("binary_sensor.stairs_a", "off").set("binary_sensor.stairs_a", "on");
    expect(sim.calls()).toEqual(on);
    sim.set("binary_sensor.stairs_a", "off").set("binary_sensor.stairs_b", "off").advance(minutes(5));
    sim.set("binary_sensor.stairs_a", "on");
    expect(sim.calls()).toEqual([...on, ...off, ...on]); // a new arrival switches on again
  });

  it("only switches on in the dark, but always switches off", () => {
    const garden: OccupancyLightParams = {
      occupancy: ["binary_sensor.garden"],
      lights: ["switch.garden_lights"],
      offAfterMin: 5,
      darkness: { sensor: "sensor.garden_lux", below: 300 },
    };
    const sim = simulate(occupancyLight, garden, { "binary_sensor.garden": "off", "switch.garden_lights": "off", "sensor.garden_lux": "2176" });
    sim.set("binary_sensor.garden", "on");
    expect(sim.calls()).toEqual([]);
    sim.set("binary_sensor.garden", "off").set("sensor.garden_lux", "40").set("binary_sensor.garden", "on");
    expect(sim.calls()).toEqual(["switch.turn_on switch.garden_lights"]);
    sim.set("switch.garden_lights", "on").set("binary_sensor.garden", "off").set("sensor.garden_lux", "900").advance(minutes(5));
    expect(sim.calls()).toEqual(["switch.turn_on switch.garden_lights", "switch.turn_off switch.garden_lights"]);
  });

  it("a light left on in an empty zone goes off after a restart, counted from when it became vacant", () => {
    const sim = simulate(occupancyLight, stairs, world);
    sim.advance(minutes(3)).set("light.stairs_1", "on").start(); // zone vacant since t0, boot at t0+3
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(2));
    expect(sim.calls()).toEqual(off);
  });

  it("is the generic trigger under its own parameter names", () => {
    const script = (sim: ReturnType<typeof simulate>) => {
      sim.start().set("binary_sensor.stairs_a", "on").set("light.stairs_1", "on").advance(minutes(1));
      sim.set("binary_sensor.stairs_a", "off").advance(minutes(6));
      return sim.calls();
    };
    const generic = { when: stairs.occupancy, targets: stairs.lights, offAfterMin: stairs.offAfterMin };
    expect(script(simulate(trigger, generic, world))).toEqual(script(simulate(occupancyLight, stairs, world)));
  });
});

describe("follow-with-run-on (floor heating pump)", () => {
  const params = { demand: "binary_sensor.ch_active", target: "switch.pump", runOnMin: 20 };

  it("runs while demand is on and 20 min after", () => {
    const sim = simulate(followWithRunOn, params, { "binary_sensor.ch_active": "off", "switch.pump": "off" });
    sim.set("binary_sensor.ch_active", "on");
    expect(sim.calls()).toEqual(["switch.turn_on switch.pump"]);
    sim.set("switch.pump", "on").set("binary_sensor.ch_active", "off").advance(minutes(10));
    sim.set("binary_sensor.ch_active", "on").set("binary_sensor.ch_active", "off").advance(minutes(19));
    expect(sim.calls()).toHaveLength(1);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["switch.turn_on switch.pump", "switch.turn_off switch.pump"]);
  });
});

describe("startup reconcile", () => {
  it("pump run-on counts from when the demand stopped", () => {
    const p = { demand: "binary_sensor.ch", target: "switch.pump", runOnMin: 20 };
    const sim = simulate(followWithRunOn, p, { "binary_sensor.ch": "off", "switch.pump": "on" });
    sim.advance(minutes(25)).start(); // overdue at boot: off at once
    expect(sim.calls()).toEqual(["switch.turn_off switch.pump"]);
  });
});
