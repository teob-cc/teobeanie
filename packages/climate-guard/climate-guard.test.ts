// climate-guard: setpoints per mode, a longest run, a start below or above a room temperature; the waiver; the wish.

import { describe, expect, it, simulate } from "teobeanie/test";
import { hours, minutes, seconds } from "teobeanie";
import { climateGuard, type ClimateGuardParams, type ClimateGuardState } from "./climate-guard.ts";

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

// The wish: a command heats one room to a temperature for a while, then puts it back.

const warmBedroom: ClimateGuardParams = { ...bedroom, warm: { command: "warm", room: "bedroom" } };
// The house keeps heating setpoints between 17 and 22, after the code's own 15–27.
const house = {
  bounds: [
    { entityPrefix: "climate.", field: "temperature", min: 15, max: 27 },
    { entityPrefix: "climate.", field: "temperature", min: 17, max: 22 },
  ],
};
const at = { ...tz, house };
const offBed = (current = 18, temperature = 20) => ({ "climate.bedroom": { state: "off", attributes: { current_temperature: current, temperature } } });
/** The calls to the unit, with their data. */
const unitCalls = (sim: { actions(): Array<{ action: { kind: string; service?: string; data?: unknown } }> }) =>
  sim.actions().flatMap(({ action: a }) => (a.kind === "call" ? [`${a.service} ${JSON.stringify(a.data)}`] : []));
const replies = (sim: { calls(): string[] }) => sim.calls().filter((c) => c.startsWith("notify: ")).map((c) => c.slice(8));
const stateOf = (sim: { state: unknown }) => sim.state as ClimateGuardState;

describe("climate-guard wish", () => {
  it("heats a unit that is off for the wish, then switches it off again", () => {
    const sim = simulate(climateGuard, warmBedroom, offBed(), at).start();
    sim.command("warm", ["bedroom", "21", "2h"], alex);
    expect(replies(sim)).toEqual(["bedroom heats to 21° until 09:00."]);
    expect(unitCalls(sim)).toEqual(['climate.set_hvac_mode {"hvac_mode":"heat"}', 'climate.set_temperature {"temperature":21}']);
    expect(sim.journal.map((e) => e.event)).toContainEqual({ tag: "Wished", by: "alex", target: 21, until: sim.now + hours(2), untilText: "09:00", before: { mode: "off", temperature: 20 }, at: sim.now });
    expect(sim.card().card?.fields.at(-1)).toEqual({ label: "Wish", value: "21° until 09:00", tone: "warn" });
    expect(sim.card().card?.buttons).toEqual([{ label: "End the wish", command: "warm", args: ["bedroom", "off"] }]);
    sim.set(...bed("heat", { current_temperature: 18, temperature: 21 })).advance(hours(2) - minutes(1));
    expect(unitCalls(sim)).toHaveLength(2);
    sim.advance(minutes(1));
    expect(replies(sim).at(-1)).toBe("bedroom is back as it was before the wish.");
    expect(unitCalls(sim).at(-1)).toBe('climate.set_hvac_mode {"hvac_mode":"off"}');
    expect(stateOf(sim).wish).toBeUndefined();
    // Back off, and not cold enough for the guard's own start.
    sim.set(...bed("off", { current_temperature: 19, temperature: 21 })).advance(hours(1));
    expect(unitCalls(sim)).toHaveLength(3);
  });

  it("a running unit: no longest run during the wish; then the guard's setpoint and a run counted from the wish's end", () => {
    const sim = simulate(climateGuard, warmBedroom, heating(), at).start();
    sim.advance(hours(1)).command("warm", ["bedroom", "22"], alex);
    // The default 3 h.
    expect(replies(sim)).toEqual(["bedroom heats to 22° until 11:00."]);
    expect(unitCalls(sim)).toEqual(['climate.set_temperature {"temperature":22}']);
    sim.set(...bed("heat", { current_temperature: 19, temperature: 22 }));
    // The run passes the guard's 3 h: not switched off.
    sim.advance(hours(3) - minutes(1));
    expect(unitCalls(sim)).toHaveLength(1);
    sim.advance(minutes(1));
    expect(unitCalls(sim).slice(1)).toEqual(['climate.set_temperature {"temperature":20}']);
    sim.set(...bed("heat", { current_temperature: 21, temperature: 20 })).advance(hours(3) - minutes(1));
    expect(unitCalls(sim)).toHaveLength(2);
    sim.advance(minutes(1));
    expect(unitCalls(sim).at(-1)).toBe('climate.set_hvac_mode {"hvac_mode":"off"}');
  });

  it("a thermostat the guard holds nothing for: the wish's setpoint, then the one it had", () => {
    const thermostat: ClimateGuardParams = { climate: "climate.study", setpoints: {}, warm: { command: "warm", room: "study" } };
    const sim = simulate(climateGuard, thermostat, { "climate.study": { state: "heat", attributes: { current_temperature: 19, temperature: 19 } } }, at).start();
    sim.advance(hours(5));
    expect(unitCalls(sim)).toEqual([]);
    sim.command("warm", ["Study", "21", "2"], alex);
    expect(replies(sim)).toEqual(["study heats to 21° until 14:00."]);
    expect(unitCalls(sim)).toEqual(['climate.set_temperature {"temperature":21}']);
    // Its drift is set back, once the grace has passed since the send.
    sim.set("climate.study", "heat", { current_temperature: 19.5, temperature: 19 });
    expect(unitCalls(sim)).toHaveLength(1);
    sim.advance(minutes(5));
    expect(unitCalls(sim)).toEqual(['climate.set_temperature {"temperature":21}', 'climate.set_temperature {"temperature":21}']);
    sim.set("climate.study", "heat", { current_temperature: 20, temperature: 21 }).advance(hours(2));
    expect(unitCalls(sim).at(-1)).toBe('climate.set_temperature {"temperature":19}');
    sim.set("climate.study", "heat", { current_temperature: 21, temperature: 19 }).advance(hours(5));
    expect(unitCalls(sim)).toHaveLength(3);
  });

  it("a person's change through HA becomes the wish's", () => {
    const sim = simulate(climateGuard, warmBedroom, heating(), at).start();
    sim.command("warm", ["bedroom", "21"], alex);
    sim.set(...bed("heat", { current_temperature: 19, temperature: 21 })).advance(minutes(20));
    sim.set(...bed("heat", { current_temperature: 19, temperature: 21.5 }), { user: "u-alex" }).advance(minutes(20));
    expect(stateOf(sim).wish?.target).toBe(21.5);
    expect(unitCalls(sim)).toHaveLength(1);
  });

  it("refuses what the house's bounds do not allow, a wish too long, and what is not a temperature", () => {
    const sim = simulate(climateGuard, warmBedroom, heating(), at).start();
    sim.command("warm", ["bedroom", "23"], alex).command("warm", ["bedroom", "16.5"], alex);
    sim.command("warm", ["bedroom", "21", "13h"], alex).command("warm", ["bedroom", "warm"], alex).command("warm", ["bedroom"], alex);
    expect(replies(sim)).toEqual([
      "bedroom can be set between 17° and 22°, not 23°.",
      "bedroom can be set between 17° and 22°, not 16.5°.",
      "A wish lasts at most 12 h.",
      "/warm bedroom 21 heats bedroom to 21° for 3 h; add a duration (2h, 90m) for another; /warm bedroom off ends it.",
      "/warm bedroom 21 heats bedroom to 21° for 3 h; add a duration (2h, 90m) for another; /warm bedroom off ends it.",
    ]);
    expect(unitCalls(sim)).toEqual([]);
    // Commas and degrees are read; half degrees kept.
    sim.command("warm", ["bedroom", "21,5°", "90m"], alex);
    expect(replies(sim).at(-1)).toBe("bedroom heats to 21.5° until 08:30.");
  });

  it("off ends it early and puts the unit back; off without a wish says so", () => {
    const sim = simulate(climateGuard, warmBedroom, offBed(), at).start();
    sim.command("warm", ["bedroom", "off"], alex);
    expect(replies(sim)).toEqual(["No wish runs for bedroom, nothing to end."]);
    sim.command("warm", ["bedroom", "21"], alex);
    sim.set(...bed("heat", { current_temperature: 18, temperature: 21 })).advance(minutes(30));
    sim.command("warm", ["bedroom", "off"], { channel: "voice", user: "sam" });
    expect(replies(sim).at(-1)).toBe("bedroom is back as it was before the wish.");
    expect(sim.actions().filter((a) => a.action.kind === "notify").at(-1)!.action).not.toHaveProperty("info");
    expect(unitCalls(sim).at(-1)).toBe('climate.set_hvac_mode {"hvac_mode":"off"}');
    expect(sim.whys().at(-1)).toMatch(/^wish for bedroom ended early by sam: back to off at 20°/);
    expect(sim.timers["wish"]).toBeUndefined();
  });

  it("stop switches the heating off now, a wish or not, and it stays off until it is cold", () => {
    const daikin = (state: string, current: number, temperature = 20) => bed(state, { hvac_modes: ["off", "heat", "cool"], current_temperature: current, temperature });
    const sim = simulate(climateGuard, warmBedroom, Object.fromEntries([daikin("heat", 20)].map(([e, st, at]) => [e, { state: st, attributes: at }])), at).start();
    sim.command("warm", ["bedroom", "stop"], { channel: "voice", user: "sam" });
    expect(replies(sim)).toEqual(["bedroom: heating switched off."]);
    expect(unitCalls(sim)).toEqual(['climate.set_hvac_mode {"hvac_mode":"off"}']);
    sim.set(...daikin("off", 20)).advance(hours(4));
    expect(unitCalls(sim)).toHaveLength(1);
    sim.command("warm", ["bedroom", "stop"], alex);
    expect(replies(sim).at(-1)).toBe("bedroom is off already.");
    // A wish under way ends, and the unit does not go back to heating.
    sim.command("warm", ["bedroom", "21"], alex);
    sim.set(...daikin("heat", 19, 21)).advance(minutes(30));
    sim.command("warm", ["bedroom", "stop"], alex);
    expect(unitCalls(sim).at(-1)).toBe('climate.set_hvac_mode {"hvac_mode":"off"}');
    expect(stateOf(sim).wish).toBeUndefined();
    expect(sim.timers["wish"]).toBeUndefined();
    sim.set(...daikin("off", 19, 21)).advance(hours(4));
    expect(unitCalls(sim).filter((c) => c.includes('"heat"'))).toHaveLength(1);
    // Colder than the guard's start: it heats again, as it would have anyway.
    sim.set(...daikin("off", 16.5, 21)).advance(minutes(1));
    expect(unitCalls(sim).slice(-2)).toEqual(["climate.set_hvac_mode {\"hvac_mode\":\"heat\"}", "climate.set_temperature {\"temperature\":20}"]);
  });

  it("stop on a unit that has no off says so, with the lowest setpoint", () => {
    const thermostat: ClimateGuardParams = { climate: "climate.study", setpoints: {}, warm: { command: "warm", room: "study" } };
    const sim = simulate(climateGuard, thermostat, { "climate.study": { state: "heat", attributes: { hvac_modes: ["heat"], current_temperature: 19, temperature: 19 } } }, at).start();
    sim.command("warm", ["study", "stop"], alex);
    expect(replies(sim)).toEqual(["study cannot be switched off from here; set it to 17° instead."]);
    expect(unitCalls(sim)).toEqual([]);
  });

  it("someone switching the unit off ends the wish, and it stays off", () => {
    const sim = simulate(climateGuard, warmBedroom, heating(), at).start();
    sim.command("warm", ["bedroom", "21"], alex);
    sim.set(...bed("heat", { current_temperature: 19, temperature: 21 })).advance(minutes(30));
    sim.set(...bed("off", { current_temperature: 20, temperature: 21 }), { user: "u-alex" });
    expect(replies(sim).at(-1)).toBe("The wish for bedroom has ended: the unit was switched off.");
    expect(sim.whys().at(-1)).toMatch(/^wish for bedroom the unit was switched off by user u-alex/);
    expect(unitCalls(sim)).toEqual(['climate.set_temperature {"temperature":21}']);
    expect(stateOf(sim).wish).toBeUndefined();
    sim.advance(hours(4));
    expect(unitCalls(sim)).toHaveLength(1);
  });

  it("a wish ends a waiver, and a waiver ends a wish, leaving the unit as it is", () => {
    const sim = simulate(climateGuard, warmBedroom, heating(), at).start();
    sim.command("climate_waive", ["bedroom"], alex);
    sim.command("warm", ["bedroom", "21"], alex);
    expect(replies(sim).at(-1)).toBe("bedroom heats to 21° until 10:00. The waiver for bedroom has ended.");
    expect(stateOf(sim).waiver).toBeUndefined();
    expect(sim.timers["waiver"]).toBeUndefined();
    sim.set(...bed("heat", { current_temperature: 19, temperature: 21 }));
    sim.command("climate_waive", ["bedroom"], alex);
    expect(replies(sim).at(-1)).toBe("Climate guard lifted for bedroom until 10:00. The wish for bedroom has ended.");
    expect(stateOf(sim).wish).toBeUndefined();
    expect(sim.timers["wish"]).toBeUndefined();
    // Nothing is put back: the waiver leaves the unit alone.
    expect(unitCalls(sim)).toEqual(['climate.set_temperature {"temperature":21}']);
  });

  it("rooms share the command; the schema keeps to the house's bounds", () => {
    const study: ClimateGuardParams = { ...bedroom, climate: "climate.study", warm: { command: "warm", room: "study", maxHours: 6 } };
    const a = simulate(climateGuard, warmBedroom, heating(), at).start();
    const b = simulate(climateGuard, study, { "climate.study": { state: "heat", attributes: { current_temperature: 19, temperature: 20 } } }, at).start();
    for (const s of [a, b]) s.command("warm", ["kitchen", "21"], alex, ["bedroom", "study"]);
    expect(replies(a)).toEqual(['No room "kitchen". Rooms: /warm bedroom, /warm study.']);
    expect(replies(b)).toEqual([]);
    expect(climateGuard.commands!(study)).toEqual(["climate_waive", "warm"]);
    expect(climateGuard.commandSchema!(study, house)["warm"]).toEqual({
      doc: 'Heat a room to a temperature for a while (default 3 h), then put it back as it was. Instead of a temperature: "off" ends that early (back as it was); "stop" switches the room\'s heating off now.',
      args: [
        { name: "room", kind: "choice", choices: ["study"] },
        { name: "temperature", kind: "number", min: 17, max: 22, step: 0.5, unit: "°C", or: ["off", "stop"], doc: "The setpoint; off: end the wish, back as it was; stop: switch the heating off now." },
        { name: "duration", kind: "duration", maxMin: 360, defaultMin: 180, optional: true },
      ],
    });
    expect(climateGuard.commandSchema!(study, house)["climate_waive"]?.args.map((x) => x.name)).toEqual(["room", "action"]);
    // Without the house's bounds, the SafeActuator's own.
    expect(climateGuard.commandSchema!(study, {})["warm"]?.args[1]).toMatchObject({ min: 15, max: 27 });
  });

  it("a setpoint outside the house's bounds is refused anyway, whoever decides it", () => {
    const hot: ClimateGuardParams = { ...bedroom, setpoints: { heat: 25 } };
    const sim = simulate(climateGuard, hot, heating(), at).start();
    expect(sim.actions()).toMatchObject([{ disposition: "refused", reason: "temperature=25 outside 17–22 for climate.bedroom" }]);
  });
});
