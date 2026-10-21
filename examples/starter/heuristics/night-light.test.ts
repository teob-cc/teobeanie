// Runs with the Studio's Test button: the rule on a scripted house and a virtual clock.
// simulate() starts on a Monday at 12:00 UTC.

import { minutes } from "teobeanie";
import { expect, simulate, test } from "teobeanie/test";
import nightLight from "./night-light";

test("dims the hallway at night and switches off after two minutes", () => {
  const sim = simulate(nightLight, {}, { "binary_sensor.hallway_motion": "off", "light.hallway_night": "off" }).start();
  sim.advance(minutes(11 * 60 + 30)); // 23:30
  sim.set("binary_sensor.hallway_motion", "on");
  expect(sim.calls()).toEqual(["light.turn_on light.hallway_night"]);
  sim.set("light.hallway_night", "on"); // the light follows
  sim.set("binary_sensor.hallway_motion", "off").advance(minutes(3));
  expect(sim.calls()).toEqual(["light.turn_on light.hallway_night", "light.turn_off light.hallway_night"]);
});

test("leaves the light alone in the daytime", () => {
  const sim = simulate(nightLight, {}, { "binary_sensor.hallway_motion": "off", "light.hallway_night": "off" }).start();
  sim.set("binary_sensor.hallway_motion", "on").advance(minutes(1));
  expect(sim.calls()).toEqual([]);
});
