// sensor-light: lights follow presence sensors, people win in between.

import { describe, expect, it, simulate } from "teobeanie/test";
import { hours, minutes } from "teobeanie";
import { sensorLight, type SensorLightParams } from "./sensor-light.ts";

const hall: SensorLightParams = {
  sensors: ["binary_sensor.hall_upper_motion", "binary_sensor.hall_lower_motion"],
  lights: ["light.hall_upper", "light.hall_lower"],
  offAfterMin: 5,
};
const quiet = { "binary_sensor.hall_upper_motion": "off", "binary_sensor.hall_lower_motion": "off", "light.hall_upper": "off", "light.hall_lower": "off" };

/** Reports the lights as HA would after Teobeanie's calls (the simulator does not). */
const lightsAre = (sim: ReturnType<typeof simulate>, state: "on" | "off", lights = hall.lights) => {
  for (const l of lights) sim.set(l, state);
  return sim;
};

describe("sensor-light", () => {
  it("on when any sensor sees someone, off once every sensor has been quiet for the run-on", () => {
    const sim = simulate(sensorLight, hall, quiet).start();
    sim.set("binary_sensor.hall_upper_motion", "on");
    expect(sim.calls()).toEqual(["light.turn_on light.hall_upper", "light.turn_on light.hall_lower"]);
    lightsAre(sim, "on");
    sim.set("binary_sensor.hall_lower_motion", "on").set("binary_sensor.hall_upper_motion", "off").advance(minutes(10));
    expect(sim.calls()).toHaveLength(2); // someone is still downstairs
    sim.set("binary_sensor.hall_lower_motion", "off").advance(minutes(4));
    expect(sim.calls()).toHaveLength(2);
    sim.advance(minutes(1));
    expect(sim.calls().slice(2)).toEqual(["light.turn_off light.hall_upper", "light.turn_off light.hall_lower"]);
    expect(sim.whys().at(-1)).toContain("hall_upper_motion is not on & hall_lower_motion is not on & hall_upper is on for 5 min");
  });

  it("a light switched off by hand while someone is there stays off until the room has been empty for the run-on", () => {
    const sim = simulate(sensorLight, hall, quiet).start();
    sim.set("binary_sensor.hall_upper_motion", "on");
    lightsAre(sim, "on");
    lightsAre(sim, "off"); // a person switches them off
    // The sensor drops out and comes back within the run-on: still the same visit.
    sim.set("binary_sensor.hall_upper_motion", "off").advance(minutes(2)).set("binary_sensor.hall_upper_motion", "on");
    expect(sim.calls()).toHaveLength(2);
    sim.set("binary_sensor.hall_upper_motion", "off").advance(minutes(5)).set("binary_sensor.hall_upper_motion", "on");
    expect(sim.calls().slice(2)).toEqual(["light.turn_on light.hall_upper", "light.turn_on light.hall_lower"]);
  });

  it("a light switched off in an already empty room comes on again at the next visit, run-on or not", () => {
    const sim = simulate(sensorLight, { ...hall, offAfterMin: 15 }, quiet).start();
    sim.set("binary_sensor.hall_upper_motion", "on");
    lightsAre(sim, "on");
    sim.advance(minutes(1)).set("binary_sensor.hall_upper_motion", "off"); // everyone leaves
    sim.advance(minutes(3));
    lightsAre(sim, "off"); // something else switches them off, 3 min into the run-on
    sim.advance(minutes(10)).set("binary_sensor.hall_upper_motion", "on"); // back after 13 min, < 15
    expect(sim.calls().slice(2)).toEqual(["light.turn_on light.hall_upper", "light.turn_on light.hall_lower"]);
  });

  it("a light someone already switched on keeps its brightness, and still goes off after the visit", () => {
    const sim = simulate(sensorLight, { ...hall, level: { brightnessPct: 100 } }, quiet).start();
    sim.set("light.hall_upper", "on", { brightness: 40 }); // by hand, dimmed
    sim.set("binary_sensor.hall_upper_motion", "on");
    expect(sim.calls()).toEqual(["light.turn_on light.hall_lower"]);
    expect(sim.whys().at(-1)).toContain("hall_upper already");
    sim.set("light.hall_lower", "on").set("binary_sensor.hall_upper_motion", "off").advance(minutes(5));
    expect(sim.calls().slice(1)).toEqual(["light.turn_off light.hall_upper", "light.turn_off light.hall_lower"]);
  });

  it("a light switched on by hand in an empty room goes off after the run-on", () => {
    const sim = simulate(sensorLight, hall, quiet).start().advance(hours(1));
    sim.set("light.hall_lower", "on");
    sim.advance(minutes(4));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["light.turn_off light.hall_lower"]);
    // And again later, after Teobeanie switched it off once already.
    sim.set("light.hall_lower", "off").advance(minutes(30)).set("light.hall_lower", "on").advance(minutes(5));
    expect(sim.calls()).toEqual(["light.turn_off light.hall_lower", "light.turn_off light.hall_lower"]);
  });

  it("at start, a light left on in a room empty for longer than the run-on goes off; one in an occupied room is left alone", () => {
    const empty = simulate(sensorLight, hall, { ...quiet, "light.hall_upper": "on" }, { t0: Date.UTC(2026, 0, 5, 12) });
    empty.advance(hours(1)).start();
    expect(empty.calls()).toEqual(["light.turn_off light.hall_upper"]);
    const busy = simulate(sensorLight, hall, { ...quiet, "binary_sensor.hall_lower_motion": "on", "light.hall_upper": "on", "light.hall_lower": "on" }).start();
    expect(busy.calls()).toEqual([]);
  });

  it("an unavailable sensor is no evidence of an empty room", () => {
    const sim = simulate(sensorLight, { ...hall, sensors: ["binary_sensor.hall_upper_motion"] }, quiet).start();
    sim.set("binary_sensor.hall_upper_motion", "on");
    lightsAre(sim, "on");
    sim.set("binary_sensor.hall_upper_motion", "unavailable").advance(hours(2));
    expect(sim.calls()).toHaveLength(2);
    // Back and quiet: the run-on counts from then.
    sim.set("binary_sensor.hall_upper_motion", "off").advance(minutes(5));
    expect(sim.calls()).toHaveLength(4);
  });

  it("dark: an illuminance threshold gates switching on, never off", () => {
    const porch = { sensors: ["binary_sensor.porch_motion"], lights: ["switch.porch"], offAfterMin: 5, dark: { illuminance: "sensor.porch_lux", below: 300 } };
    const sim = simulate(sensorLight, porch, { "binary_sensor.porch_motion": "off", "switch.porch": "off", "sensor.porch_lux": "800" }).start();
    sim.set("binary_sensor.porch_motion", "on");
    expect(sim.calls()).toEqual([]);
    sim.set("sensor.porch_lux", "120"); // dusk, still someone there
    expect(sim.calls()).toEqual(["switch.turn_on switch.porch"]);
    sim.set("switch.porch", "on").set("sensor.porch_lux", "900").set("binary_sensor.porch_motion", "off").advance(minutes(5));
    expect(sim.calls()).toEqual(["switch.turn_on switch.porch", "switch.turn_off switch.porch"]);
  });

  it("dark: a too-bright flag, or the sun's elevation", () => {
    const flag = simulate(sensorLight, { ...hall, dark: { tooBright: "binary_sensor.hall_bright" } }, { ...quiet, "binary_sensor.hall_bright": "on" }).start();
    flag.set("binary_sensor.hall_upper_motion", "on");
    expect(flag.calls()).toEqual([]);
    flag.set("binary_sensor.hall_bright", "off");
    expect(flag.calls()).toHaveLength(2);

    const sun = { ...hall, dark: { sunBelow: 3 } };
    expect(sensorLight.watchAttributes!(sun)).toEqual(["sun.sun"]);
    const evening = simulate(sensorLight, sun, { ...quiet, "sun.sun": { state: "above_horizon", attributes: { elevation: 10 } } }).start();
    evening.set("binary_sensor.hall_upper_motion", "on");
    expect(evening.calls()).toEqual([]);
    evening.set("sun.sun", "above_horizon", { elevation: 2 }); // an attribute-only change
    expect(evening.calls()).toHaveLength(2);
  });

  it("levels by time of day apply when switching on, not to a light that is already on", () => {
    // t0 = 13:00 in Lagos (UTC+1).
    const night = { ...hall, lights: ["light.hall_upper"], level: { brightnessPct: 100 }, levels: [{ from: "23:00", to: "06:30", brightnessPct: 15, colorTempK: 2200 }] };
    const sim = simulate(sensorLight, night, quiet, { timeZone: "Africa/Lagos" }).start();
    sim.set("binary_sensor.hall_upper_motion", "on");
    expect(sim.actions()[0]!.action).toMatchObject({ data: { brightness_pct: 100 } });
    sim.set("light.hall_upper", "on").advance(hours(10)).set("binary_sensor.hall_upper_motion", "off"); // 23:00 passes while lit
    expect(sim.calls()).toHaveLength(1);
    sim.advance(minutes(5)).set("light.hall_upper", "off").set("binary_sensor.hall_upper_motion", "on");
    expect(sim.actions().at(-1)!.action).toMatchObject({ service: "light.turn_on", data: { brightness_pct: 15, color_temp_kelvin: 2200 } });
  });

  it("keepOnWhile holds the lights on without switching them on", () => {
    const bath = { sensors: ["binary_sensor.bath_motion"], lights: ["light.bath"], offAfterMin: 5, keepOnWhile: { entities: ["binary_sensor.bath_door"], states: ["off"] } };
    const sim = simulate(sensorLight, bath, { "binary_sensor.bath_motion": "off", "binary_sensor.bath_door": "on", "light.bath": "off" }).start();
    sim.set("binary_sensor.bath_door", "off");
    expect(sim.calls()).toEqual([]);
    sim.set("binary_sensor.bath_motion", "on").set("light.bath", "on").set("binary_sensor.bath_motion", "off").advance(minutes(30));
    expect(sim.calls()).toEqual(["light.turn_on light.bath"]); // door closed: someone is still in
    sim.set("binary_sensor.bath_door", "on").advance(minutes(5));
    expect(sim.calls()).toEqual(["light.turn_on light.bath", "light.turn_off light.bath"]);
  });
});
