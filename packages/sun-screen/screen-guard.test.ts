// screen-guard: the dark and the wind close the screen at once; rain is announced, then
// closes it; a close that does not arrive is sent once more, then alerted.

import { describe, expect, it, simulate } from "teobeanie/test";
import { minutes } from "teobeanie";
import { isOpen, screenGuard, type ScreenGuardParams } from "./screen-guard.ts";

const house = { outdoor: { weather: "weather.home" } };
const p: ScreenGuardParams = { covers: ["cover.screen"], sunBelow: 0, windAbove: 25, rain: { closeAfterMin: 10 } };
const weather = (condition: string, wind: number) => ({ state: condition, attributes: { wind_speed: wind } });
const sun = (elevation: number) => ({ state: elevation < 0 ? "below_horizon" : "above_horizon", attributes: { elevation } });
const screen = (position: number, state = position > 0 ? "open" : "closed") => ({ state, attributes: { current_position: position } });
const day = { "cover.screen": screen(100), "weather.home": weather("sunny", 10), "sun.sun": sun(30) };
const run = (world: Record<string, { state: string; attributes?: Record<string, unknown> }> = day, params = p) => simulate(screenGuard, params, world, { house });
const CLOSE = "cover.close_cover cover.screen";

describe("screen-guard", () => {
  it("watches the covers and the sun, their attributes too; operates the covers another instance owns and shares; reads the outdoor conditions", () => {
    expect(screenGuard.watch(p)).toEqual(["cover.screen", "sun.sun"]);
    expect(screenGuard.watchAttributes!(p)).toEqual(["cover.screen", "sun.sun"]);
    expect(screenGuard.actuates(p)).toEqual([]);
    expect(screenGuard.uses!(p)).toEqual(["cover.screen"]);
    expect(screenGuard.usesOutdoor).toBe(true);
    expect(screenGuard.watch({ covers: ["cover.a"] })).toEqual(["cover.a"]); // no sun rule: the sun is not watched
  });

  it("a fine day: the screen stays out", () => {
    const sim = run().start();
    sim.set("weather.home", "sunny", { wind_speed: 20 }).set("sun.sun", "above_horizon", { elevation: 5 }).advance(minutes(60));
    expect(sim.calls()).toEqual([]);
  });

  it("sundown closes it at once and says so, as a report, not an alert", () => {
    const sim = run().start();
    sim.set("sun.sun", "below_horizon", { elevation: -0.5 });
    expect(sim.calls()).toEqual([CLOSE, "notify: Sun screen closed: the sun is down."]);
    expect(sim.actions().at(-1)!.action).toMatchObject({ info: true });
    expect(sim.whys().at(-1)).toBe("the sun is down (-0.5°): closing");
  });

  it("wind above the threshold closes it at once; at the threshold it does not", () => {
    const sim = run().start();
    sim.set("weather.home", "sunny", { wind_speed: 25 });
    expect(sim.calls()).toEqual([]);
    sim.set("weather.home", "sunny", { wind_speed: 25.5 });
    expect(sim.calls()).toEqual([CLOSE, "notify: Sun screen closed: wind 25.5 km/h."]);
  });

  it("rain: an alert, then the screen comes in 10 min later", () => {
    const sim = run().start();
    sim.set("weather.home", "rainy", { wind_speed: 10 });
    expect(sim.calls()).toEqual(["notify: Rain is coming (rainy): closing the sun screen in 10 min."]);
    expect(sim.actions()[0]!.action).not.toMatchObject({ info: true });
    sim.advance(minutes(9)).set("weather.home", "rainy", { wind_speed: 12 }); // still raining: one alert
    expect(sim.calls()).toHaveLength(1);
    sim.advance(minutes(1));
    expect(sim.calls().slice(1)).toEqual([CLOSE, "notify: Sun screen closed: rain."]);
    expect(sim.actions().at(-1)!.action).toMatchObject({ info: true });
  });

  it("the countdown runs out after the rain passed: closed all the same, it was announced", () => {
    const sim = run().start();
    sim.set("weather.home", "rainy", { wind_speed: 10 }).advance(minutes(5)).set("weather.home", "partlycloudy", { wind_speed: 10 }).advance(minutes(5));
    expect(sim.calls().slice(1)).toEqual([CLOSE, "notify: Sun screen closed: rain."]);
  });

  it("closed by hand during the countdown: nothing more; opened again in the rain: a new countdown", () => {
    const sim = run().start();
    sim.set("weather.home", "rainy", { wind_speed: 10 }).advance(minutes(5));
    sim.set("cover.screen", "closed", { current_position: 0 }).advance(minutes(30));
    expect(sim.calls()).toHaveLength(1);
    expect(sim.timers).toEqual({});
    sim.set("cover.screen", "opening", { current_position: 0 });
    expect(sim.calls().at(-1)).toBe("notify: Rain is coming (rainy): closing the sun screen in 10 min.");
  });

  it("wind during the countdown closes it at once and ends the countdown", () => {
    const sim = run().start();
    sim.set("weather.home", "rainy", { wind_speed: 10 }).advance(minutes(5)).set("weather.home", "rainy", { wind_speed: 40 });
    expect(sim.calls().slice(1)).toEqual([CLOSE, "notify: Sun screen closed: wind 40 km/h."]);
    sim.set("cover.screen", "closed", { current_position: 0 }).advance(minutes(10));
    expect(sim.calls()).toHaveLength(3);
  });

  it("opened while it is dark: closed again, and told why", () => {
    const sim = run({ ...day, "cover.screen": screen(0), "sun.sun": sun(-10) }).start();
    expect(sim.calls()).toEqual([]);
    sim.set("cover.screen", "opening", { current_position: 0 });
    expect(sim.calls()).toEqual([CLOSE, "notify: Sun screen closed: the sun is down."]);
  });

  it("at start, open after dark: closed", () => {
    const sim = run({ ...day, "sun.sun": sun(-5) }).start();
    expect(sim.calls()[0]).toBe(CLOSE);
  });

  it("a close has settleMin to arrive; still open, once more; then the alert, and it is left alone until it reads closed", () => {
    const sim = run().start();
    sim.set("sun.sun", "below_horizon", { elevation: -1 });
    expect(sim.calls()).toHaveLength(2);
    sim.set("cover.screen", "closing", { current_position: 80 }).set("cover.screen", "closing", { current_position: 60 }).advance(minutes(2));
    expect(sim.calls()).toHaveLength(2);
    sim.advance(minutes(1)); // settleMin: still at 60
    expect(sim.calls().at(-1)).toBe(CLOSE);
    expect(sim.whys().at(-1)).toBe("still open 3 min after the close: closing again");
    sim.advance(minutes(3));
    expect(sim.calls().at(-1)).toBe("notify: Sun screen still open after 2 closes, please check it.");
    expect(sim.actions().at(-1)!.action).not.toMatchObject({ info: true });
    sim.advance(minutes(60)).set("sun.sun", "below_horizon", { elevation: -20 });
    expect(sim.calls()).toHaveLength(4);
    expect(sim.card().card?.fields.at(-1)).toEqual({ label: "Closing", value: "did not arrive, check the screen", tone: "bad" });
    sim.set("cover.screen", "closed", { current_position: 0 }); // it got there after all
    expect(sim.whys().at(-1)).toBe("the screen is closed");
    sim.set("cover.screen", "open", { current_position: 100 });
    expect(sim.calls().at(-1)).toBe("notify: Sun screen closed: the sun is down.");
  });

  it("a Fibaro module reporting 'closing' with the position at closed reads as closed", () => {
    expect(isOpen({ state: "closing", value: null, since: 0, attributes: { current_position: 0 } }, 0)).toBe(false);
    expect(isOpen({ state: "closing", value: null, since: 0, attributes: { current_position: 40 } }, 0)).toBe(true);
    expect(isOpen({ state: "opening", value: null, since: 0, attributes: { current_position: 0 } }, 0)).toBe(true);
    expect(isOpen({ state: "open", value: true, since: 0, attributes: {} }, 0)).toBe(true);
    expect(isOpen({ state: "unavailable", value: null, since: 0, attributes: {} }, 0)).toBe(false);
    const sim = run({ ...day, "cover.screen": { state: "closing", attributes: { current_position: 0 } }, "sun.sun": sun(-10) }).start();
    expect(sim.calls()).toEqual([]);
  });

  it("no reading never closes: an unavailable screen, no sun entity, no outdoor sources", () => {
    const down = simulate(screenGuard, p, { "cover.screen": "unavailable", "weather.home": weather("rainy", 50) }, { house }).start();
    down.set("weather.home", "pouring", { wind_speed: 60 });
    expect(down.calls()).toEqual([]);
    const blind = simulate(screenGuard, p, { "cover.screen": screen(100) }).start();
    expect(blind.calls()).toEqual([]);
  });

  it("another closed position, and a screen wired the other way round", () => {
    const partly = run({ ...day, "cover.screen": screen(60), "sun.sun": sun(-5) }, { ...p, closedPosition: 20 }).start();
    expect(partly.calls()[0]).toBe("cover.set_cover_position cover.screen");
    expect(partly.actions()[0]!.action).toMatchObject({ data: { position: 20 } });
    const at20 = run({ ...day, "cover.screen": screen(15, "open"), "sun.sun": sun(-5) }, { ...p, closedPosition: 20 }).start();
    expect(at20.calls()).toEqual([]);
    const inverted = run({ ...day, "cover.screen": screen(0), "sun.sun": sun(-5) }, { ...p, closedPosition: 100 }).start();
    expect(inverted.calls()[0]).toBe("cover.open_cover cover.screen");
  });

  it("only the rules an instance sets apply", () => {
    const windOnly = run({ ...day, "sun.sun": sun(-5), "weather.home": weather("rainy", 10) }, { covers: ["cover.screen"], windAbove: 30 }).start();
    windOnly.advance(minutes(30));
    expect(windOnly.calls()).toEqual([]);
    windOnly.set("weather.home", "rainy", { wind_speed: 31 });
    expect(windOnly.calls()).toEqual([CLOSE, "notify: Sun screen closed: wind 31 km/h."]);
  });

  it("an overridden text is used, the others stay", () => {
    const sim = run(day, { ...p, texts: { sunClosed: "Zonwering dicht: de zon is onder." } }).start();
    sim.set("sun.sun", "below_horizon", { elevation: -1 });
    expect(sim.calls().at(-1)).toBe("notify: Zonwering dicht: de zon is onder.");
    sim.set("sun.sun", "above_horizon", { elevation: 5 }).set("cover.screen", "closed", { current_position: 0 }).set("cover.screen", "open", { current_position: 100 });
    sim.set("weather.home", "rainy", { wind_speed: 10 });
    expect(sim.calls().at(-1)).toBe("notify: Rain is coming (rainy): closing the sun screen in 10 min.");
  });

  it("the card: the screen, and what is under way", () => {
    const sim = run().start();
    expect(sim.card().card).toMatchObject({ title: "Sun screen", fields: [{ label: "Screen", value: "open" }] });
    sim.set("weather.home", "rainy", { wind_speed: 10 });
    expect(sim.card().card?.fields[1]).toMatchObject({ label: "Rain", value: "alerted, closing soon", tone: "warn" });
    sim.advance(minutes(10));
    expect(sim.card().card?.fields[1]).toMatchObject({ label: "Closing", value: "rain, close 1", tone: "warn" });
  });
});
