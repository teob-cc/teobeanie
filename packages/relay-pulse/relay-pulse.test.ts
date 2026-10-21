// relay-pulse: a latching relay is released after a press, whoever pressed it.

import { describe, expect, it, simulate } from "teobeanie/test";
import { seconds } from "teobeanie";
import { relayPulse } from "./relay-pulse.ts";

describe("relay-pulse (garage step button)", () => {
  const params = { relays: ["switch.garage_l1", "switch.garage_l2"], pressMs: 1000, recheckMs: 5000 };

  it("releases after the press and once more if still latched", () => {
    const sim = simulate(relayPulse, params, { "switch.garage_l1": "off", "switch.garage_l2": "off" });
    sim.set("switch.garage_l1", "on").advance(seconds(1));
    expect(sim.calls()).toEqual(["switch.turn_off switch.garage_l1"]);
    sim.advance(seconds(5)); // the release did not land
    expect(sim.calls()).toEqual(["switch.turn_off switch.garage_l1", "switch.turn_off switch.garage_l1"]);
  });

  it("does nothing more when the release lands", () => {
    const sim = simulate(relayPulse, params, { "switch.garage_l1": "off", "switch.garage_l2": "off" });
    sim.set("switch.garage_l2", "on").advance(seconds(1)).set("switch.garage_l2", "off").advance(seconds(10));
    expect(sim.calls()).toEqual(["switch.turn_off switch.garage_l2"]);
  });
});

describe("shadow mode", () => {
  it("decides and journals the same, but suppresses every action", () => {
    const params = { relays: ["switch.r"], pressMs: 1000, recheckMs: 5000 };
    const sim = simulate(relayPulse, params, { "switch.r": "off" }, { mode: "shadow" });
    sim.set("switch.r", "on").advance(seconds(1));
    expect(sim.actions().map((a) => a.disposition)).toEqual(["suppressed"]);
    expect(sim.journal.some((j) => j.event.tag === "ActionCompleted")).toBe(false);
  });
});
