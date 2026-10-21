// climate-guard: setpoints per mode, a longest run, a start below or above a room temperature; the waiver.

import { describe, expect, it, simulate } from "teobeanie/test";
import { hours, minutes, seconds } from "teobeanie";
import { climateGuard, type ClimateGuardParams } from "./climate-guard.ts";

const den: ClimateGuardParams = {
  climate: "climate.den_unit",
  setpoints: { heat: 20, cool: 22 },
  maxRunMin: 180,
  startHeatBelow: 17,
  startCoolAbove: 25,
};
const off = (t: number, temperature = 21) => ({ "climate.den_unit": { state: "off", attributes: { current_temperature: t, temperature } } });
const unit = (state: string, attributes: Record<string, unknown>) => ["climate.den_unit", state, attributes] as const;

describe("climate-guard", () => {
  it("someone starts heating: the heating setpoint, and off after the longest run", () => {
    const sim = simulate(climateGuard, den, off(19)).start();
    sim.set(...unit("heat", { current_temperature: 19, temperature: 23 }), { user: "u-alex" });
    expect(sim.calls()).toEqual(["climate.set_temperature climate.den_unit"]);
    expect(sim.actions()[0]!.action).toMatchObject({ data: { temperature: 20 } });
    sim.set(...unit("heat", { current_temperature: 19.5, temperature: 20 }));
    sim.advance(hours(3) - minutes(1));
    expect(sim.calls()).toHaveLength(1);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["climate.set_temperature climate.den_unit", "climate.set_hvac_mode climate.den_unit"]);
    expect(sim.actions()[1]!.action).toMatchObject({ data: { hvac_mode: "off" } });
  });

  it("switched off, it starts heating only below the start temperature, and cooling only above", () => {
    const sim = simulate(climateGuard, den, off(18)).start();
    sim.set(...unit("off", { current_temperature: 17.2, temperature: 21 }));
    expect(sim.calls()).toEqual([]);
    sim.set(...unit("off", { current_temperature: 16.8, temperature: 21 }));
    expect(sim.calls()).toEqual(["climate.set_hvac_mode climate.den_unit", "climate.set_temperature climate.den_unit"]);
    expect(sim.actions().map((a) => a.action)).toMatchObject([{ data: { hvac_mode: "heat" } }, { data: { temperature: 20 } }]);

    const summer = simulate(climateGuard, den, off(24)).start();
    summer.set(...unit("off", { current_temperature: 25.4, temperature: 21 }));
    expect(summer.actions().map((a) => a.action)).toMatchObject([{ data: { hvac_mode: "cool" } }, { data: { temperature: 22 } }]);
  });

  it("after the longest run it stays off until the room is cold enough again", () => {
    const sim = simulate(climateGuard, den, { "climate.den_unit": { state: "heat", attributes: { current_temperature: 18, temperature: 20 } } }).start();
    sim.advance(hours(3));
    expect(sim.calls()).toEqual(["climate.set_hvac_mode climate.den_unit"]);
    sim.set(...unit("off", { current_temperature: 19, temperature: 20 })).advance(hours(2));
    sim.set(...unit("off", { current_temperature: 17.5, temperature: 20 }));
    expect(sim.calls()).toHaveLength(1);
    sim.set(...unit("off", { current_temperature: 16.9, temperature: 20 }));
    expect(sim.calls().slice(1)).toEqual(["climate.set_hvac_mode climate.den_unit", "climate.set_temperature climate.den_unit"]);
    // That run is limited too.
    sim.set(...unit("heat", { current_temperature: 17, temperature: 20 })).advance(hours(3));
    expect(sim.calls().at(-1)).toBe("climate.set_hvac_mode climate.den_unit");
  });

  it("a cloud unit still reporting the run just after the cap is not a new run", () => {
    const sim = simulate(climateGuard, den, { "climate.den_unit": { state: "heat", attributes: { current_temperature: 19, temperature: 20 } } }).start();
    sim.advance(hours(3));
    expect(sim.calls()).toEqual(["climate.set_hvac_mode climate.den_unit"]);
    // The integration shows off, then the cloud's stale "heat" a second later.
    sim.set(...unit("off", { current_temperature: 19, temperature: 20 })).advance(seconds(1));
    sim.set(...unit("heat", { current_temperature: 19, temperature: 20 }));
    expect(sim.calls()).toHaveLength(1); // no setpoint, no second off within the grace
    // Still "heat" after the grace: off once more, never a setpoint; then the cloud catches up.
    sim.advance(minutes(10)).set(...unit("off", { current_temperature: 19, temperature: 20 }));
    expect(sim.calls()).toEqual(["climate.set_hvac_mode climate.den_unit", "climate.set_hvac_mode climate.den_unit"]);
    // A start well after the cap is a new run again.
    sim.advance(minutes(30)).set(...unit("heat", { current_temperature: 18, temperature: 23 }));
    expect(sim.calls().slice(2)).toEqual(["climate.set_temperature climate.den_unit"]);
  });

  it("the unit's own setpoint drift is set back; a user's change stands until the next run", () => {
    const sim = simulate(climateGuard, den, { "climate.den_unit": { state: "heat", attributes: { current_temperature: 19, temperature: 20 } } }).start();
    sim.advance(minutes(10));
    sim.set(...unit("heat", { current_temperature: 19, temperature: 21 })); // the unit's own schedule
    expect(sim.calls()).toEqual(["climate.set_temperature climate.den_unit"]);
    sim.set(...unit("heat", { current_temperature: 19, temperature: 20 })).advance(minutes(10));
    sim.set(...unit("heat", { current_temperature: 19, temperature: 19.5 }), { user: "u-alex" });
    sim.set(...unit("heat", { current_temperature: 19.2, temperature: 19.5 })).advance(minutes(30));
    expect(sim.calls()).toHaveLength(1);
    expect(sim.whys().some((w) => w.includes("changed by a user"))).toBe(true);
    // Off, and heating again later: the setpoint is the heating one again.
    sim.set(...unit("off", { current_temperature: 19, temperature: 19.5 }), { user: "u-alex" }).advance(hours(1));
    sim.set(...unit("heat", { current_temperature: 18, temperature: 19.5 }), { user: "u-alex" });
    expect(sim.calls().slice(1)).toEqual(["climate.set_temperature climate.den_unit"]);
    expect(sim.actions().at(-1)!.action).toMatchObject({ data: { temperature: 20 } });
  });

  it("other modes and an unavailable unit are left alone", () => {
    const sim = simulate(climateGuard, den, { "climate.den_unit": { state: "dry", attributes: { current_temperature: 15 } } }).start();
    sim.advance(hours(5)).set(...unit("unavailable", {}));
    expect(sim.calls()).toEqual([]);
  });
});

// The waiver: a command lifts the guard for one room for a while.

const bedroom: ClimateGuardParams = {
  climate: "climate.bedroom",
  setpoints: { heat: 20, cool: 22 },
  maxRunMin: 180,
  startHeatBelow: 17,
  waive: { command: "climate_waive", room: "bedroom" },
};
const heating = (temperature = 20, current = 19) => ({ "climate.bedroom": { state: "heat", attributes: { current_temperature: current, temperature } } });
const bed = (state: string, attributes: Record<string, unknown>) => ["climate.bedroom", state, attributes] as const;
const alex = { channel: "telegram", user: "alex" };
// t0 is noon UTC: 07:00 in New York.
const tz = { timeZone: "America/New_York" };

describe("climate-guard waiver", () => {
  it("lifts the guard for the waiver: no setpoint reset, no cap; then setpoint back and a fresh longest run", () => {
    const sim = simulate(climateGuard, bedroom, heating(), tz).start();
    sim.advance(hours(1)).command("climate_waive", ["bedroom"], alex);
    expect(sim.calls()).toEqual(["notify: Climate guard lifted for bedroom until 11:00."]);
    expect(sim.journal.map((e) => e.event)).toContainEqual({ tag: "Waived", by: "alex", until: sim.now + hours(3) });
    expect(sim.whys().at(-1)).toContain("climate_waive by alex");
    // The remote sets 26: not set back; the run passes the 3 h cap: not switched off.
    sim.set(...bed("heat", { current_temperature: 19, temperature: 26 }));
    sim.advance(hours(3) - minutes(1));
    expect(sim.calls()).toHaveLength(1);
    // The waiver ends: the heating setpoint again, and a run counted from now.
    sim.advance(minutes(1));
    expect(sim.calls().slice(1)).toEqual(["notify: Climate guard is back on for bedroom.", "climate.set_temperature climate.bedroom"]);
    expect(sim.actions().at(-1)!.action).toMatchObject({ data: { temperature: 20 } });
    expect(sim.whys().at(-1)).toMatch(/^waiver for bedroom ran out, guard back on/);
    sim.set(...bed("heat", { current_temperature: 21, temperature: 20 })).advance(hours(3) - minutes(1));
    expect(sim.calls()).toHaveLength(3);
    sim.advance(minutes(1));
    expect(sim.calls().at(-1)).toBe("climate.set_hvac_mode climate.bedroom");
  });

  it("leaves a unit that is off alone too, and starts it as usual afterwards", () => {
    const sim = simulate(climateGuard, bedroom, { "climate.bedroom": { state: "off", attributes: { current_temperature: 18, temperature: 20 } } }, tz).start();
    sim.command("climate_waive", ["Bedroom"], alex);
    sim.set(...bed("off", { current_temperature: 16, temperature: 20 }));
    expect(sim.calls()).toEqual(["notify: Climate guard lifted for bedroom until 10:00."]);
    sim.advance(hours(3));
    expect(sim.calls().slice(1)).toEqual([
      "notify: Climate guard is back on for bedroom.",
      "climate.set_hvac_mode climate.bedroom",
      "climate.set_temperature climate.bedroom",
    ]);
  });

  it("off ends it early; off without a waiver says so; a second waive renews it", () => {
    const sim = simulate(climateGuard, bedroom, heating(), tz).start();
    sim.command("climate_waive", ["bedroom", "off"], alex);
    expect(sim.calls()).toEqual(["notify: The climate guard is on for bedroom, nothing to end."]);
    sim.command("climate_waive", ["bedroom"], alex).advance(hours(2));
    sim.command("climate_waive", ["bedroom"], { channel: "telegram", user: "sam" });
    expect(sim.calls().at(-1)).toBe("notify: Climate guard lifted for bedroom until 12:00.");
    sim.set(...bed("heat", { current_temperature: 19, temperature: 25 })).advance(hours(1));
    sim.command("climate_waive", ["bedroom", "OFF"], { channel: "telegram", user: "sam" });
    expect(sim.calls().slice(-2)).toEqual(["notify: Climate guard is back on for bedroom.", "climate.set_temperature climate.bedroom"]);
    expect(sim.journal.map((e) => e.event)).toContainEqual({ tag: "WaiverEnded", reason: "ended early by sam", by: "sam" });
    expect(sim.timers["waiver"]).toBeUndefined();
    expect((sim.state as { waiver?: unknown }).waiver).toBeUndefined();
    // Nothing when the renewed waiver would have run out.
    const n = sim.calls().length;
    sim.set(...bed("heat", { current_temperature: 19, temperature: 20 })).advance(hours(2) + minutes(1));
    expect(sim.calls()).toHaveLength(n);
  });

  it("several rooms share the command: the others stay silent, an unknown room gets one reply", () => {
    const study: ClimateGuardParams = { ...bedroom, climate: "climate.study", waive: { command: "climate_waive", room: "study", hours: 2 } };
    const rooms = ["bedroom", "study"];
    const a = simulate(climateGuard, bedroom, heating(), tz).start();
    const b = simulate(climateGuard, study, { "climate.study": { state: "heat", attributes: { current_temperature: 19, temperature: 20 } } }, tz).start();
    const both = (args: string[]) => [a, b].forEach((s) => s.command("climate_waive", args, alex, rooms));
    both(["kitchen"]);
    expect(a.calls()).toEqual(['notify: No room "kitchen". Rooms: /climate_waive bedroom, /climate_waive study.']);
    expect(b.calls()).toEqual([]);
    both([]);
    expect(a.calls().at(-1)).toBe("notify: Which room? /climate_waive bedroom, /climate_waive study (add off to end it early).");
    expect(b.calls()).toEqual([]);
    both(["study"]);
    expect(a.calls()).toHaveLength(2);
    expect(b.calls()).toEqual(["notify: Climate guard lifted for study until 09:00."]);
    both(["study", "later"]);
    expect(b.calls().at(-1)).toBe("notify: /climate_waive study lifts the climate guard there for 2 h; /climate_waive study off ends it.");
    expect(a.calls()).toHaveLength(2);
  });

  it("texts are parameters; without waive there is no command", () => {
    const sim = simulate(climateGuard, { ...bedroom, texts: { waived: "{room}: free until {until}" } }, heating(), tz).start();
    sim.command("climate_waive", ["bedroom"], alex);
    expect(sim.calls()).toEqual(["notify: bedroom: free until 10:00"]);
    expect(climateGuard.commands!(den)).toEqual([]);
    expect(climateGuard.commands!(bedroom)).toEqual(["climate_waive"]);
  });

});
