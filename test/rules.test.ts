// Desired-state rules on the simulator: the same decideStep/applyEvent the house runs.

import { describe, expect, it } from "vitest";
import { hours, minutes } from "../src/kernel/heuristic.js";
import { simulate } from "../src/kernel/simulate.js";
import { actionsFor, entitiesInSource, keep, rule } from "../src/kernel/rule.js";
import { occupancyLight, type OccupancyLightParams } from "../packages/trigger/trigger.ts";
import { followWithRunOn, type FollowParams } from "../packages/trigger/trigger.ts";

const hallway = rule("hallway-light", ({ ha, held }) => {
  const motion = ha.binary_sensor.hallway_motion;
  return ha.light.hallway.to(motion.is("on") ? "on" : held(() => motion.is("off"), minutes(5)) ? "off" : keep);
});

describe("rule()", () => {
  it("derives what it watches and owns from its source and a first evaluation", () => {
    expect(hallway.watch(undefined)).toEqual(expect.arrayContaining(["binary_sensor.hallway_motion"]));
    expect(hallway.actuates(undefined)).toEqual(["light.hallway"]);
    expect(entitiesInSource(`ha.sensor.lux.above(3); ha.cover["blinds_1"]`)).toEqual(["sensor.lux", "cover.blinds_1"]);
  });

  it("calls only when the desired value changes, and explains itself from the branch taken", () => {
    const sim = simulate(hallway, undefined, { "binary_sensor.hallway_motion": "off", "light.hallway": "off" }).start();
    expect(sim.calls()).toEqual([]); // vacant and already off at start: nothing to do

    sim.set("binary_sensor.hallway_motion", "on");
    expect(sim.calls()).toEqual(["light.turn_on light.hallway"]);
    expect(sim.whys().at(-1)).toBe("hallway → on · hallway_motion is on");

    // Moving about: off → on within the 5 min sends nothing new.
    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(2)).set("binary_sensor.hallway_motion", "on");
    expect(sim.calls()).toHaveLength(1);

    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(4) + 59_000);
    expect(sim.calls()).toHaveLength(1);
    sim.advance(1000);
    expect(sim.calls()).toEqual(["light.turn_on light.hallway", "light.turn_off light.hallway"]);
    expect(sim.whys().at(-1)).toBe("hallway → off · hallway_motion is on ✗, hallway_motion is off for 5 min");
  });

  it("labels a time condition with the facts it found, negations included", () => {
    const dim = rule("dim", ({ ha, held }) => {
      const lux = ha.sensor.porch_lux;
      const motion = ha.binary_sensor.porch_motion;
      return ha.light.porch.to(held(() => !motion.is("on") && !lux.above(50), minutes(5)) ? "off" : keep);
    });
    const sim = simulate(dim, undefined, { "binary_sensor.porch_motion": "off", "sensor.porch_lux": "20", "light.porch": "on" }).start();
    sim.advance(minutes(5));
    expect(sim.whys().at(-1)).toBe("porch → off · porch_motion is not on & porch_lux ≤ 50 for 5 min");
  });

  it("a person who overrides the device is not fought until the rule changes its mind", () => {
    const sim = simulate(hallway, undefined, { "binary_sensor.hallway_motion": "on", "light.hallway": "on" }).start();
    expect(sim.calls()).toEqual([]); // already on at start
    sim.set("light.hallway", "off"); // switched off by hand while someone is there
    sim.set("binary_sensor.hallway_motion", "off").set("binary_sensor.hallway_motion", "on");
    expect(sim.calls()).toEqual([]);
    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(5));
    expect(sim.calls()).toEqual(["light.turn_off light.hallway"]);
  });

  it("held() measures a numeric condition across value changes, not from the last change", () => {
    const blinds = rule("blinds", ({ ha, held }) =>
      ha.cover.blinds.to(held(() => ha.sensor.lux.above(40_000), minutes(10)) ? { position: 30 } : keep),
    );
    const sim = simulate(blinds, undefined, { "sensor.lux": "1000", "cover.blinds": "open" }).start();
    sim.set("sensor.lux", "41000").advance(minutes(4)).set("sensor.lux", "45000").advance(minutes(4)).set("sensor.lux", "43000");
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(2));
    expect(sim.calls()).toEqual(["cover.set_cover_position cover.blinds"]);
    expect(sim.actions()[0]?.action).toMatchObject({ data: { position: 30 } });
  });

  it("held() after a restart counts from last_changed, not from boot", () => {
    const sim = simulate(hallway, undefined, { "binary_sensor.hallway_motion": "on", "light.hallway": "on" });
    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(3)); // add-on down: no evaluation yet
    sim.start();
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(2));
    expect(sim.calls()).toEqual(["light.turn_off light.hallway"]);
  });

  it("between() wakes the rule at the clock boundaries in house time", () => {
    // 2026-01-05 12:00 UTC = 21:00 in Tokyo.
    const porch = rule("porch", ({ ha, between }) => ha.light.porch.to(between("22:00", "06:30") ? "on" : "off"));
    const sim = simulate(porch, undefined, { "light.porch": "off" }, { timeZone: "Asia/Tokyo" }).start();
    expect(sim.calls()).toEqual([]);
    sim.advance(hours(1) - 1);
    expect(sim.calls()).toEqual([]);
    sim.advance(1);
    expect(sim.calls()).toEqual(["light.turn_on light.porch"]); // 22:00 local
    sim.advance(hours(8.5));
    expect(sim.calls()).toEqual(["light.turn_on light.porch", "light.turn_off light.porch"]); // 06:30 local
  });

  it("between() follows the house's zone across a DST change", () => {
    // New York falls back on 1 Nov 2026: 22:00 EDT is 02:00 UTC, 06:30 EST is 11:30 UTC.
    const porch = rule("porch", ({ ha, between }) => ha.light.porch.to(between("22:00", "06:30") ? "on" : "off"));
    const t0 = Date.UTC(2026, 10, 1, 1, 0);
    const sim = simulate(porch, undefined, { "light.porch": "off" }, { t0, house: { timeZone: "America/New_York" } }).start();
    sim.advance(hours(1));
    expect(sim.calls()).toEqual(["light.turn_on light.porch"]);
    sim.advance(hours(9.5) - 1); // 06:30 by the summer clock: still night
    expect(sim.calls()).toHaveLength(1);
    sim.advance(1);
    expect(sim.calls()).toEqual(["light.turn_on light.porch", "light.turn_off light.porch"]);
    expect(sim.now).toBe(Date.UTC(2026, 10, 1, 11, 30));
  });

  it("between() is in UTC while the house names no zone", () => {
    const porch = rule("porch", ({ ha, between }) => ha.light.porch.to(between("22:00", "06:30") ? "on" : "off"));
    const sim = simulate(porch, undefined, { "light.porch": "off" }).start(); // 12:00 UTC
    sim.advance(hours(10) - 1);
    expect(sim.calls()).toEqual([]);
    sim.advance(1);
    expect(sim.calls()).toEqual(["light.turn_on light.porch"]);
  });

  it("a rule must return entity.to(value), once per entity", () => {
    const bad = rule("bad", ({ ha }) => ({ [String(ha.light.x)]: "on" }) as never);
    expect(() => bad.actuates(undefined)).toThrow(/must return entity.to\(value\)/);
    const twice = rule("twice", ({ ha }) => [ha.light.x.to("on"), ha.light.x.to("off")]);
    expect(() => twice.actuates(undefined)).toThrow(/two values for light.x/);
  });

  it("richer desired values send only what changed", () => {
    expect(actionsFor("light.x", { state: "on", brightness_pct: 80, color_temp_kelvin: 2700 }, { state: "on", brightness_pct: 30, color_temp_kelvin: 2700 })).toEqual([
      { kind: "call", service: "light.turn_on", entities: ["light.x"], data: { brightness_pct: 30 } },
    ]);
    expect(actionsFor("light.x", "off", { state: "on", brightness_pct: 30 })).toEqual([
      { kind: "call", service: "light.turn_on", entities: ["light.x"], data: { brightness_pct: 30 } },
    ]);
    expect(actionsFor("climate.x", { hvac_mode: "heat", temperature: 20 }, { hvac_mode: "heat", temperature: 21 })).toEqual([
      { kind: "call", service: "climate.set_temperature", entities: ["climate.x"], data: { temperature: 21 } },
    ]);
    expect(actionsFor("select.x", undefined, "eco")).toEqual([{ kind: "call", service: "select.select_option", entities: ["select.x"], data: { option: "eco" } }]);
    expect(() => actionsFor("sensor.x", undefined, "on")).toThrow(/no way to reach/);
  });

  it("an instance recovered with a decider's state (the same id, before it became a rule) still decides", () => {
    const stale = { lit: true } as never;
    const step = hallway.decide(stale, { kind: "signal", at: 0, obsId: "o", entity: "binary_sensor.hallway_motion", value: true, state: "on", origin: "ha" }, {
      now: 0,
      params: undefined,
      instance: "main",
      get: (e: string) => (e === "binary_sensor.hallway_motion" ? { value: true, state: "on", since: 0, attributes: {} } : undefined),
      value: () => undefined,
      timer: () => undefined,
      house: {},
    });
    expect(step?.actions).toEqual([{ kind: "call", service: "light.turn_on", entities: ["light.hallway"] }]);
    expect(hallway.evolve(stale, { tag: "LightsOn", by: "x" } as never)).toEqual({ desired: {}, track: {}, unwatched: [] });
  });

  it("a read of an entity it does not watch is reported once", () => {
    // entity("...") ids are not in the source scan, and the probe never takes the branch that reads sensor.lux.
    const sneaky = rule("sneaky", ({ entity }) =>
      entity("light.x").to(entity("binary_sensor.a").is("on") && entity("sensor.lux").above(5) ? "on" : keep),
    );
    expect(sneaky.watch(undefined)).toEqual(["binary_sensor.a"]);
    const sim = simulate(sneaky, undefined, { "binary_sensor.a": "off", "sensor.lux": "10" }).start();
    sim.set("binary_sensor.a", "on").set("binary_sensor.a", "off").set("binary_sensor.a", "on");
    expect(sim.journal.filter((e) => e.event.tag === "UnwatchedRead").map((e) => e.event)).toEqual([{ tag: "UnwatchedRead", entities: ["sensor.lux"] }]);
  });
});

describe("library heuristics as rules", () => {
  // occupancy-light in a few lines: on while any sensor is occupied (and it is dark),
  // off once every sensor has been vacant for offAfterMin.
  const occupancyRule = rule<OccupancyLightParams>(
    "occupancy-light-rule",
    ({ entity, held }, p) => {
      const occupied = () => p.occupancy.some((e) => entity(e).is("on"));
      const lux = p.darkness ? entity(p.darkness.sensor).value : undefined;
      const dark = p.darkness === undefined || typeof lux !== "number" || lux < p.darkness.below;
      const want = occupied()
        ? dark
          ? "on"
          : keep
        : held(() => !occupied(), minutes(p.offAfterMin))
          ? "off"
          : keep;
      return p.lights.map((l) => entity(l).to(want));
    },
    { watch: (p) => [...p.occupancy, ...(p.darkness ? [p.darkness.sensor] : [])], owns: (p) => p.lights },
  );

  const stairs: OccupancyLightParams = {
    occupancy: ["binary_sensor.stairs_a", "binary_sensor.stairs_b"],
    lights: ["light.stairs_1"],
    offAfterMin: 5,
  };
  const world = { "binary_sensor.stairs_a": "off", "binary_sensor.stairs_b": "off", "light.stairs_1": "off" };

  function script(sim: ReturnType<typeof simulate>) {
    sim.start().set("binary_sensor.stairs_a", "on").set("light.stairs_1", "on");
    sim.set("binary_sensor.stairs_b", "on").set("binary_sensor.stairs_a", "off").advance(minutes(10));
    sim.set("binary_sensor.stairs_b", "off").advance(minutes(3)).set("binary_sensor.stairs_a", "on").set("binary_sensor.stairs_a", "off");
    sim.advance(minutes(6)).set("light.stairs_1", "off");
    return sim;
  }

  it("occupancy-light: a few lines of rule make the library's calls at the same times", () => {
    const library = script(simulate(occupancyLight, stairs, world));
    const asRule = script(simulate(occupancyRule, stairs, world));
    expect(asRule.actions().map((a) => [a.at, a.action])).toEqual(library.actions().map((a) => [a.at, a.action]));
    expect(asRule.calls()).toEqual(["light.turn_on light.stairs_1", "light.turn_off light.stairs_1"]);
  });

  it("follow-with-run-on: one line, same calls at the same times", () => {
    const followRule = rule<FollowParams>("follow-rule", ({ entity, within }, p) =>
      entity(p.target).to(within(() => entity(p.demand).is("on"), minutes(p.runOnMin)) ? "on" : "off"),
    );
    const params: FollowParams = { demand: "binary_sensor.boiler", target: "switch.pump", runOnMin: 20 };
    const run = (def: typeof followRule) => {
      const sim = simulate(def, params, { "binary_sensor.boiler": "off", "switch.pump": "off" }).start();
      sim.set("binary_sensor.boiler", "on").set("switch.pump", "on").advance(minutes(30));
      sim.set("binary_sensor.boiler", "off").advance(minutes(10)).set("binary_sensor.boiler", "on").advance(minutes(1));
      sim.set("binary_sensor.boiler", "off").advance(minutes(25)).set("switch.pump", "off");
      return sim.actions().map((a) => `${(a.at - sim.journal[0]!.at) / 60_000} min ${a.action.kind === "call" ? a.action.service : ""}`);
    };
    expect(run(followRule)).toEqual(run(followWithRunOn));
    expect(run(followRule)).toEqual(["0 min switch.turn_on", "61 min switch.turn_off"]);
  });
});
