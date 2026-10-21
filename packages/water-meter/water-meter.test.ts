import { describe, expect, it, simulate } from "teobeanie/test";
import { minutes, seconds } from "teobeanie";
import { nightLeak, showerSummary, type NightLeakParams, type ShowerSummaryParams } from "./water-meter.ts";

const zone = { timeZone: "Europe/Amsterdam" };
// 2026-01-06 01:00 in Amsterdam (UTC+1).
const night = Date.UTC(2026, 0, 6, 0, 0, 0);
// 2026-01-06 08:00 in Amsterdam.
const morning = Date.UTC(2026, 0, 6, 7, 0, 0);

describe("night-leak", () => {
  const p: NightLeakParams = { meter: "sensor.water_total" };
  const world = { "sensor.water_total": "1000" };

  /** One litre every `everyMin` minutes, `n` times. */
  const drip = (sim: ReturnType<typeof simulate>, from: number, n: number, everyMin: number): number => {
    let v = from;
    for (let i = 0; i < n; i++) {
      sim.advance(minutes(everyMin));
      sim.set("sensor.water_total", String(++v));
    }
    return v;
  };

  it("water counted for an hour without a break is one notice", () => {
    const sim = simulate(nightLeak, p, world, { t0: night, ...zone }).start();
    drip(sim, 1000, 10, 10); // 10 L over 100 min
    expect(sim.calls()).toEqual(["notify: Water keeps running at night: 6 L in 60 min (6.0 L/h). A leaking tap or toilet?"]);
  });

  it("a flush now and then is not a leak", () => {
    const sim = simulate(nightLeak, p, world, { t0: night, ...zone }).start();
    let v = 1000;
    for (let i = 0; i < 4; i++) {
      sim.set("sensor.water_total", String((v += 6)));
      sim.advance(minutes(25));
    }
    expect(sim.calls()).toEqual([]);
    expect((sim.state as { run?: unknown }).run).toBeNull();
  });

  it("a meter that writes the same total again (force_update) does not hold a run open", () => {
    const sim = simulate(nightLeak, p, world, { t0: night, ...zone }).start();
    let v = 1000;
    for (let i = 0; i < 3; i++) {
      sim.set("sensor.water_total", String((v += 6))); // a flush
      for (let s = 0; s < 40 * 6; s++) sim.advance(seconds(10)).set("sensor.water_total", String(v), {}, { force: true });
    }
    expect(sim.calls()).toEqual([]);
    expect((sim.state as { run?: unknown }).run).toBeNull();
  });

  it("is quiet during the day", () => {
    const sim = simulate(nightLeak, p, world, { t0: morning, ...zone }).start();
    drip(sim, 1000, 12, 10);
    expect(sim.calls()).toEqual([]);
  });

  it("a counter correction is not water used", () => {
    const sim = simulate(nightLeak, p, world, { t0: night, ...zone }).start();
    sim.set("sensor.water_total", "1001");
    sim.advance(minutes(5)).set("sensor.water_total", "25000");
    drip(sim, 25000, 3, 10);
    expect(sim.calls()).toEqual([]);
    expect((sim.state as { run?: { startL: number } }).run?.startL).toBe(25000);
  });
});

describe("shower-summary", () => {
  const p: ShowerSummaryParams = {
    water: "sensor.water_total",
    gas: "sensor.gas_total",
    hotWater: "binary_sensor.boiler_hot_water",
    waterPricePerM3: 1.76,
    gasPrice: "sensor.gas_price",
  };
  const world = {
    "sensor.water_total": "1000",
    "sensor.gas_total": "500.000",
    "binary_sensor.boiler_hot_water": "off",
    "sensor.gas_price": "1.04",
  };

  /** Water at 8 L/min, a reading every 10 s, for `min` minutes. */
  const flow = (sim: ReturnType<typeof simulate>, from: number, min: number): number => {
    let v = from;
    for (let s = 10; s <= min * 60; s += 10) {
      sim.advance(seconds(10));
      v += 8 / 6;
      sim.set("sensor.water_total", String(Math.round(v)));
    }
    return Math.round(v);
  };

  it("a hot use is summed up once the gas meter has read after it", () => {
    const sim = simulate(showerSummary, p, world, { t0: morning, ...zone }).start();
    sim.set("binary_sensor.boiler_hot_water", "on");
    flow(sim, 1000, 8); // 64 L
    sim.set("binary_sensor.boiler_hot_water", "off");
    sim.advance(minutes(3)); // quiet: waiting for the gas meter
    expect(sim.calls()).toEqual([]);
    sim.set("sensor.gas_total", "500.200");
    expect(sim.calls()).toEqual([
      "notify: Shower over: 64 L water and 0.200 m³ gas in 8 min, €0.32 (water €0.11 at €1.76/m³, gas €0.21 at €1.04/m³)",
    ]);
  });

  it("a cold use is no shower", () => {
    const sim = simulate(showerSummary, p, world, { t0: morning, ...zone }).start();
    flow(sim, 1000, 8);
    sim.advance(minutes(3)).set("sensor.gas_total", "500.300"); // the heating, not the tap
    expect(sim.calls()).toEqual([]);
    expect(sim.whys()).toContain("no hot water during 64 L");
  });

  it("without a hot-water sensor, gas used with the water makes it hot", () => {
    const { hotWater: _, ...noSensor } = p;
    const sim = simulate(showerSummary, noSensor, world, { t0: morning, ...zone }).start();
    flow(sim, 1000, 8);
    sim.advance(minutes(3)).set("sensor.gas_total", "500.150");
    expect(sim.calls()).toHaveLength(1);
    sim.advance(minutes(30));
    flow(sim, 1064, 8);
    sim.advance(minutes(3)).set("sensor.gas_total", "500.160"); // 0.01 m³: cold
    expect(sim.calls()).toHaveLength(1);
  });

  it("a small hot use, and a counter correction, are not reported", () => {
    const sim = simulate(showerSummary, p, world, { t0: morning, ...zone }).start();
    sim.set("binary_sensor.boiler_hot_water", "on");
    flow(sim, 1000, 1); // 8 L
    sim.advance(minutes(3));
    flow(sim, 1008, 1);
    sim.set("sensor.water_total", "25000"); // the meter set by hand during a use
    sim.advance(minutes(3));
    expect(sim.calls()).toEqual([]);
    expect(sim.whys()).toEqual(expect.arrayContaining(["8 L: a small use", "23992 L: a counter correction"]));
  });

  it("a meter that writes the same total again (force_update) still ends the use", () => {
    const sim = simulate(showerSummary, p, world, { t0: morning, ...zone }).start();
    sim.set("binary_sensor.boiler_hot_water", "on");
    const v = flow(sim, 1000, 8);
    sim.set("binary_sensor.boiler_hot_water", "off");
    for (let s = 0; s < 18; s++) sim.advance(seconds(10)).set("sensor.water_total", String(v), {}, { force: true });
    sim.set("sensor.gas_total", "500.200");
    expect(sim.calls()).toEqual([
      "notify: Shower over: 64 L water and 0.200 m³ gas in 8 min, €0.32 (water €0.11 at €1.76/m³, gas €0.21 at €1.04/m³)",
    ]);
  });

  it("water drawn a little at a time is separate small uses, and a use over maxMin is no shower", () => {
    const sim = simulate(showerSummary, { ...p, maxMin: 20 }, world, { t0: morning, ...zone }).start();
    sim.set("binary_sensor.boiler_hot_water", "on");
    flow(sim, 1000, 2); // 16 L
    sim.advance(minutes(10));
    flow(sim, 1016, 2);
    sim.advance(minutes(3));
    expect(sim.whys().filter((w) => w.endsWith("a small use"))).toEqual(["16 L: a small use", "16 L: a small use"]);
    flow(sim, 1032, 25); // 200 L without a break
    sim.advance(minutes(3));
    expect(sim.calls()).toEqual([]);
    expect(sim.whys()).toContain("200 L over 25 min: too long for a shower");
  });

  it("without a new gas reading, sums up after gasWaitMin with the gas so far", () => {
    const sim = simulate(showerSummary, { ...p, gasPrice: undefined, gasPricePerM3: 1.2 }, world, { t0: morning, ...zone }).start();
    sim.set("binary_sensor.boiler_hot_water", "on");
    const v = flow(sim, 1000, 3);
    sim.set("sensor.gas_total", "500.050"); // a reading during the use
    flow(sim, v, 2);
    sim.advance(minutes(2 + 6));
    expect(sim.calls()).toEqual([
      "notify: Shower over: 40 L water and 0.050 m³ gas in 5 min, €0.13 (water €0.07 at €1.76/m³, gas €0.06 at €1.20/m³)",
    ]);
  });
});
