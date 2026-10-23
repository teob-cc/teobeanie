import { describe, expect, it, vi } from "vitest";
import { addDays, dayKey, dayStart, daysBetween, nextPeriodFirstDay, periodFirstDay, weekKey } from "../src/energy/calendar.js";
import { EMPTY_ENERGY_FILE, guessUse, parseEnergyFile, resolveSources, tariffOn, type EnergyPrefs } from "../src/energy/config.js";
import { computeDay, copAt, gasShares, heatOf, onSpans, priceBand, projectDay, sumLedgers, type HourlyStats, type PriceKnowledge } from "../src/energy/ledger.js";
import { DEFAULT_HEAT_PUMP } from "../src/energy/config.js";
import { createEnergyService } from "../src/energy/service.js";
import { ENERGY_CATEGORY, type EnergyEvent } from "../src/energy/journal.js";
import type { HourRow } from "../src/energy/types.js";

const TZ = "Europe/Amsterdam";
const HOUR = 3_600_000;

const PREFS: EnergyPrefs = {
  energy_sources: [
    { type: "grid", stat_energy_from: "sensor.import_t1", stat_energy_to: "sensor.export_t1", entity_energy_price: "sensor.price_now", entity_energy_price_export: "sensor.price_now" },
    { type: "grid", stat_energy_from: "sensor.import_t2", stat_energy_to: "sensor.export_t2", entity_energy_price: "sensor.price_now", entity_energy_price_export: "sensor.price_now" },
    { type: "solar", stat_energy_from: "sensor.solar_energy" },
    { type: "gas", stat_energy_from: "sensor.gas_meter", entity_energy_price: "sensor.gas_price" },
  ],
  device_consumption: [
    { stat_consumption: "sensor.heat_pump_heating_energy", name: "Heat pump heating" },
    { stat_consumption: "sensor.heat_pump_cooling_energy", name: "Heat pump cooling" },
  ],
};

const stats = (change: Record<string, Record<number, number>>, mean: Record<string, Record<number, number>> = {}): HourlyStats => ({
  change: new Map(Object.entries(change).map(([k, v]) => [k, new Map(Object.entries(v).map(([h, x]) => [Number(h), x]))])),
  mean: new Map(Object.entries(mean).map(([k, v]) => [k, new Map(Object.entries(v).map(([h, x]) => [Number(h), x]))])),
});
const noKnowledge = (): PriceKnowledge => ({ electricity: new Map(), gasMarket: [], fallback: new Map() });
const hoursOf = (key: string): number[] => {
  const out: number[] = [];
  for (let h = dayStart(key, TZ); h < dayStart(addDays(key, 1), TZ); h += HOUR) out.push(h);
  return out;
};

describe("calendar", () => {
  it("keys local days and knows a DST day has 25 hours", () => {
    expect(dayKey(Date.parse("2026-10-22T22:30:00Z"), TZ)).toBe("2026-10-23");
    expect(dayStart("2026-10-23", TZ)).toBe(Date.parse("2026-10-22T22:00:00Z"));
    expect(hoursOf("2026-10-25")).toHaveLength(25);
    expect(hoursOf("2026-03-29")).toHaveLength(23);
    expect(daysBetween("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("numbers ISO weeks across year ends", () => {
    expect(weekKey("2026-10-23")).toBe("2026-W43");
    expect(weekKey("2026-01-01")).toBe("2026-W01");
    expect(weekKey("2027-01-01")).toBe("2026-W53");
    expect(weekKey("2024-12-30")).toBe("2025-W01");
    expect(periodFirstDay("2026-10-23", "week")).toBe("2026-10-19");
    expect(nextPeriodFirstDay("2026-10-23", "week")).toBe("2026-10-26");
    expect(nextPeriodFirstDay("2026-12-15", "month")).toBe("2027-01-01");
    expect(nextPeriodFirstDay("2026-12-15", "year")).toBe("2027-01-01");
  });
});

describe("energy.json", () => {
  it("defaults without a file and sorts the tariffs", () => {
    expect(parseEnergyFile(undefined)).toEqual(EMPTY_ENERGY_FILE);
    const f = parseEnergyFile({
      tariffs: [
        { from: "2027-01-01", exportPrice: 0.05 },
        { from: "2026-01-01", fixedPerDay: { electricity: 1.1, gas: 0.8 }, taxCreditPerYear: 365, exportPrice: "import" },
      ],
      priceHistory: { source: "energyzero" },
      water: { stat: "sensor.water_meter", price: 1.5 },
      devices: { "sensor.*_cooling_*": { use: "cooling" }, "sensor.ventilation_energy": { use: "ventilation", name: "Ventilation" } },
      attribution: { hotWater: "binary_sensor.boiler_hot_water", heating: "binary_sensor.boiler_heating" },
    });
    expect(f.tariffs.map((t) => t.from)).toEqual(["2026-01-01", "2027-01-01"]);
    expect(tariffOn(f.tariffs, "2026-06-01")).toEqual({ fixedPerDay: { electricity: 1.1, gas: 0.8 }, taxCreditPerYear: 365, exportPrice: "import" });
    // A later period overrides what it names and carries the rest over.
    expect(tariffOn(f.tariffs, "2027-02-01")).toEqual({ fixedPerDay: { electricity: 1.1, gas: 0.8 }, taxCreditPerYear: 365, exportPrice: 0.05 });
    expect(tariffOn(f.tariffs, "2025-12-31")).toEqual({});
  });

  it("names the field at fault", () => {
    expect(() => parseEnergyFile({ tariffs: [{ from: "2026-13-01" }] })).toThrow(/tariffs\[0\]\.from/);
    expect(() => parseEnergyFile({ devices: { "sensor.x": { use: "sauna" } } })).toThrow(/devices\["sensor.x"\].use/);
    expect(() => parseEnergyFile({ attribution: { gas: "sensor.gas_meter" } })).toThrow(/hotWater or heating/);
    expect(() => parseEnergyFile({ priceHistory: { source: "elsewhere" } })).toThrow(/energyzero/);
  });
});

describe("sources", () => {
  it("reads HA's preferences with energy.json's additions", () => {
    const file = parseEnergyFile({
      water: { stat: "sensor.water_meter", price: "sensor.water_price" },
      devices: { "sensor.heat_pump_cooling_energy": { hidden: true }, "sensor.ventilation_energy": { name: "Ventilation" } },
      attribution: { hotWater: "binary_sensor.boiler_hot_water" },
    });
    const s = resolveSources(PREFS, file, "sensor.outdoor_temperature");
    expect(s.imports).toEqual([
      { id: "sensor.import_t1", price: { entity: "sensor.price_now" } },
      { id: "sensor.import_t2", price: { entity: "sensor.price_now" } },
    ]);
    expect(s.exports.map((e) => e.id)).toEqual(["sensor.export_t1", "sensor.export_t2"]);
    expect(s.water).toEqual([{ id: "sensor.water_meter", price: { entity: "sensor.water_price" } }]);
    expect(s.devices).toEqual([
      { id: "sensor.heat_pump_heating_energy", name: "Heat pump heating", use: "heating" },
      { id: "sensor.ventilation_energy", name: "Ventilation", use: "ventilation" },
    ]);
    expect(s.outdoorTemperature).toBe("sensor.outdoor_temperature");
    expect(s.attribution).toEqual({ gas: "sensor.gas_meter", hotWater: "binary_sensor.boiler_hot_water", lagMs: 300_000 });
  });

  it("guesses a use from a name", () => {
    expect(guessUse("Living room AC cooling")).toBe("cooling");
    expect(guessUse("Heat pump")).toBe("heating");
    expect(guessUse("Electric water heater")).toBe("hot_water");
    expect(guessUse("Ventilation unit")).toBe("ventilation");
    expect(guessUse("Dishwasher")).toBe("other");
  });
});

describe("computeDay", () => {
  const key = "2026-10-23";
  const [h0, h1, h2] = hoursOf(key);

  it("prices each hour at its own price, credits the export and adds the fixed charges", () => {
    const file = parseEnergyFile({ tariffs: [{ from: "2026-01-01", fixedPerDay: { electricity: 1, gas: 0.5 }, taxCreditPerYear: 365 }] });
    const s = resolveSources(PREFS, file);
    const r = computeDay({
      key,
      from: dayStart(key, TZ),
      to: dayStart(addDays(key, 1), TZ),
      hours: [h0!, h1!],
      stats: stats(
        { "sensor.import_t1": { [h0!]: 1 }, "sensor.import_t2": { [h1!]: 2 }, "sensor.export_t2": { [h1!]: 0.5 }, "sensor.gas_meter": { [h0!]: 0.2, [h1!]: 0.3 }, "sensor.heat_pump_heating_energy": { [h1!]: 1.5 } },
        { "sensor.price_now": { [h0!]: 0.2, [h1!]: 0.3 }, "sensor.gas_price": { [h0!]: 1.8, [h1!]: 1.8 } },
      ),
      sources: s,
      file,
      known: noKnowledge(),
      complete: true,
    });
    expect(r.ledger.electricity).toEqual({ importKwh: 3, exportKwh: 0.5, importCost: 0.8, exportCredit: 0.15 });
    expect(r.ledger.gas).toEqual({ m3: 0.5, cost: 0.9 });
    // 1 + 0.5 a day, less 365 / 365 of the tax credit.
    expect(r.ledger.fixed).toBe(0.5);
    expect(r.ledger.total).toBe(Math.round((0.8 - 0.15 + 0.9 + 0.5) * 100) / 100);
    expect(r.ledger.devices.find((d) => d.id === "sensor.heat_pump_heating_energy")).toMatchObject({ kWh: 1.5, cost: 0.45, use: "heating" });
    expect(r.hours[1]).toMatchObject({ importKwh: 2, exportKwh: 0.5, price: 0.3, exportPrice: 0.3, gasPrice: 1.8, estimated: false });
    expect(r.ledger.estimated).toBe(false);
    expect(r.flags).toEqual([]);
  });

  it("counts a counter that goes back, or jumps past a house's use, as nothing and says so", () => {
    const s = resolveSources(PREFS, EMPTY_ENERGY_FILE);
    const r = computeDay({
      key,
      from: dayStart(key, TZ),
      to: dayStart(addDays(key, 1), TZ),
      hours: [h0!, h1!, h2!],
      stats: stats({ "sensor.heat_pump_heating_energy": { [h0!]: 0.4, [h1!]: -858.8, [h2!]: 0.3 }, "sensor.import_t1": { [h2!]: 400 } }, { "sensor.price_now": { [h0!]: 0.2, [h1!]: 0.2, [h2!]: 0.2 } }),
      sources: s,
      file: EMPTY_ENERGY_FILE,
      known: noKnowledge(),
      complete: true,
    });
    expect(r.ledger.devices[0]!.kWh).toBe(0.7);
    expect(r.ledger.electricity.importKwh).toBe(0);
    expect(r.flags.map((f) => [f.kind, f.id])).toEqual([
      ["reset", "sensor.heat_pump_heating_energy"],
      ["spike", "sensor.import_t1"],
    ]);
  });

  it("follows the export price of the tariff in effect: the import price, then a feed-in price", () => {
    const file = parseEnergyFile({ tariffs: [{ from: "2026-01-01", exportPrice: "import" }, { from: "2027-01-01", exportPrice: 0.05 }] });
    const s = resolveSources({ energy_sources: [{ type: "grid", stat_energy_from: "sensor.import_t1", stat_energy_to: "sensor.export_t1", entity_energy_price: "sensor.price_now" }] }, file);
    const day = (k: string) => {
      const h = hoursOf(k)[12]!;
      return computeDay({ key: k, from: dayStart(k, TZ), to: dayStart(addDays(k, 1), TZ), hours: [h], stats: stats({ "sensor.export_t1": { [h]: 2 } }, { "sensor.price_now": { [h]: 0.25 } }), sources: s, file, known: noKnowledge(), complete: true }).ledger;
    };
    expect(day("2026-12-31").electricity.exportCredit).toBe(0.5);
    expect(day("2027-01-01").electricity.exportCredit).toBe(0.1);
  });

  it("prices hours without statistics from the price history, else from the nearest price, marked estimated", () => {
    const s = resolveSources(PREFS, EMPTY_ENERGY_FILE);
    const known: PriceKnowledge = {
      electricity: new Map([[h0!, 0.3]]),
      gasMarket: [{ start: h0! - 6 * HOUR, end: h0! + 18 * HOUR, price: 1.0 }],
      gasAdder: { value: 0.8, derived: false },
      fallback: new Map([["sensor.price_now", 0.25]]),
    };
    const r = computeDay({
      key,
      from: dayStart(key, TZ),
      to: dayStart(addDays(key, 1), TZ),
      hours: [h0!, h1!],
      stats: stats({ "sensor.import_t1": { [h0!]: 1, [h1!]: 1 }, "sensor.gas_meter": { [h0!]: 1 } }),
      sources: s,
      file: EMPTY_ENERGY_FILE,
      known,
      complete: true,
    });
    expect(r.hours[0]).toMatchObject({ price: 0.3, gasPrice: 1.8, estimated: false });
    expect(r.hours[1]).toMatchObject({ price: 0.25, estimated: true });
    expect(r.ledger.electricity.importCost).toBe(0.55);
    expect(r.ledger.gas.cost).toBe(1.8);
    expect(r.ledger.estimated).toBe(true);
  });

  it("carries a neighbouring hour's price over an hour or two the price entity was unavailable", () => {
    const s = resolveSources(PREFS, EMPTY_ENERGY_FILE);
    const r = computeDay({
      key,
      from: dayStart(key, TZ),
      to: dayStart(addDays(key, 1), TZ),
      hours: [h0!, h1!, h2!],
      stats: stats({ "sensor.gas_meter": { [h0!]: 1, [h1!]: 1, [h2!]: 1 } }, { "sensor.gas_price": { [h0!]: 1.8 } }),
      sources: s,
      file: EMPTY_ENERGY_FILE,
      known: noKnowledge(),
      complete: true,
    });
    expect(r.hours.map((h) => h.gasPrice)).toEqual([1.8, 1.8, 1.8]);
    expect(r.ledger.estimated).toBe(false);
  });

  it("splits the gas by the shares given, and the degree days from the outdoor means", () => {
    const s = resolveSources(PREFS, EMPTY_ENERGY_FILE, "sensor.outdoor_temperature");
    const hours = hoursOf(key);
    const temps = Object.fromEntries(hours.map((h) => [h, 10]));
    const r = computeDay({
      key,
      from: dayStart(key, TZ),
      to: dayStart(addDays(key, 1), TZ),
      hours,
      stats: stats({ "sensor.gas_meter": { [h0!]: 2 } }, { "sensor.outdoor_temperature": temps }),
      sources: s,
      file: EMPTY_ENERGY_FILE,
      known: noKnowledge(),
      gasShares: { hotWater: 0.25, heating: 0.5 },
      complete: true,
    });
    expect(r.ledger.gas).toMatchObject({ m3: 2, hotWaterM3: 0.5, heatingM3: 1 });
    expect(r.ledger.degreeDays).toBe(8);
  });
});

describe("the heat pump route", () => {
  it("reads a COP between the given points, flat beyond them", () => {
    const cop: Array<[number, number]> = [[-7, 2.6], [2, 3.4], [7, 4.3]];
    expect(copAt(cop, -20)).toBe(2.6);
    expect(copAt(cop, 2)).toBe(3.4);
    expect(copAt(cop, 4.5)).toBeCloseTo(3.85);
    expect(copAt(cop, 30)).toBe(4.3);
  });

  it("makes the gas's heat with a heat pump, hour by hour, and counts the gas connection's fixed charges as saved", () => {
    const pump = { ...DEFAULT_HEAT_PUMP, kWhPerM3: 10, cop: [[0, 2], [10, 4]] as Array<[number, number]>, hotWaterCop: 2.5 };
    const h = heatOf({
      hours: [0, HOUR],
      gas: [1, 1],
      prices: [0.3, 0.2],
      temps: new Map([[0, 0], [HOUR, 10]]),
      gasM3: 2,
      gasCost: 3.6,
      gasFixed: 1,
      shares: { hotWater: 0.5, heating: 0.5 },
      hotWaterM3: undefined,
      pump,
    });
    // Per hour 5 kWh space heat and 5 kWh hot water: 5/2 + 5/2.5 = 4.5 kWh at 0.3, then 5/4 + 2 = 3.25 kWh at 0.2.
    expect(h).toEqual({ spaceKwh: 10, hotWaterKwh: 10, split: "measured", gasCost: 3.6, gasFixed: 1, heatPumpKwh: 7.75, heatPumpCost: 2, saving: 2.6 });
  });

  it("takes hot water at the summer's daily gas when the day is not split", () => {
    const h = heatOf({ hours: [0], gas: [2], prices: [0.25], temps: undefined, gasM3: 2, gasCost: 3.7, gasFixed: 0, shares: undefined, hotWaterM3: 0.5, pump: { ...DEFAULT_HEAT_PUMP, kWhPerM3: 8 } });
    expect(h.split).toBe("assumed");
    expect(h.hotWaterKwh).toBe(4);
    expect(h.spaceKwh).toBe(12);
  });

  it("adds the supplier's markup to the import, and credits the export without it", () => {
    const file = parseEnergyFile({ tariffs: [{ from: "2026-01-01", importMarkup: 0.02, exportPrice: "import", fixedPerDay: { gas: 1.05 } }] });
    const s = resolveSources(
      { energy_sources: [{ type: "grid", stat_energy_from: "sensor.import_t1", stat_energy_to: "sensor.export_t1", entity_energy_price: "sensor.price_now" }, { type: "gas", stat_energy_from: "sensor.gas_meter", entity_energy_price: "sensor.gas_price" }] },
      file,
    );
    const key = "2026-10-23";
    const h = hoursOf(key)[12]!;
    const r = computeDay({ key, from: dayStart(key, TZ), to: dayStart(addDays(key, 1), TZ), hours: [h], stats: stats({ "sensor.import_t1": { [h]: 2 }, "sensor.export_t1": { [h]: 1 }, "sensor.gas_meter": { [h]: 1 } }, { "sensor.price_now": { [h]: 0.25 }, "sensor.gas_price": { [h]: 1.8 } }), sources: s, file, known: noKnowledge(), hotWaterM3: 0, complete: true });
    expect(r.ledger.electricity).toMatchObject({ importCost: 0.54, exportCredit: 0.25 });
    expect(r.hours[0]!.price).toBeCloseTo(0.27);
    expect(r.ledger.heat).toMatchObject({ gasCost: 1.8, gasFixed: 1.05, split: "assumed" });
    expect(r.ledger.heat!.heatPumpCost).toBeCloseTo(r.ledger.heat!.heatPumpKwh * 0.27, 2);
  });

  it("checks energy.json's heat pump", () => {
    expect(parseEnergyFile({ heatPump: { cop: [[7, 4], [-7, 2.5]], hotWaterM3PerDay: 0.3 } }).heatPump).toMatchObject({ cop: [[-7, 2.5], [7, 4]], hotWaterM3PerDay: 0.3, kWhPerM3: 8.8 });
    expect(() => parseEnergyFile({ heatPump: { cop: [[7, 0]] } })).toThrow(/above 0/);
  });
});

describe("gasShares", () => {
  it("counts each meter step for the boiler state that was on before it, the meter's lag included", () => {
    const t = Date.parse("2026-10-23T06:00:00Z");
    const min = 60_000;
    const readings = [
      { at: t, value: 100 },
      { at: t + 5 * min, value: 100.1 }, // hot water on 2–3 min
      { at: t + 10 * min, value: 100.3 }, // heating on 6–20 min
      { at: t + 15 * min, value: 100.4 }, // heating
      { at: t + 20 * min, value: 100.5 }, // heating
      { at: t + 60 * min, value: 100.6 }, // neither: cooking
    ];
    const hot = onSpans([{ at: t + 2 * min, on: true }, { at: t + 3 * min, on: false }], t - 5 * min, t + 60 * min);
    const heat = onSpans([{ at: t - 60 * min, on: false }, { at: t + 6 * min, on: true }, { at: t + 20 * min, on: false }], t - 5 * min, t + 60 * min);
    expect(hot).toEqual([[t + 2 * min, t + 3 * min]]);
    expect(heat).toEqual([[t + 6 * min, t + 20 * min]]);
    const shares = gasShares(readings, hot, heat, 0)!;
    expect(shares.hotWater).toBeCloseTo(0.1 / 0.6);
    expect(shares.heating).toBeCloseTo(0.4 / 0.6);
  });

  it("is unknown when the meter did not move", () => {
    expect(gasShares([{ at: 0, value: 5 }, { at: 1, value: 5 }], [], [], 0)).toBeUndefined();
  });

  it("keeps a state that was on before the window on from its start", () => {
    expect(onSpans([{ at: 0, on: true }, { at: 50, on: false }], 10, 100)).toEqual([[10, 50]]);
    expect(onSpans([{ at: 0, on: true }], 10, 100)).toEqual([[10, 100]]);
  });
});

describe("sums, the projection and the price band", () => {
  it("sums days into a period", () => {
    const s = resolveSources(PREFS, EMPTY_ENERGY_FILE);
    const day = (k: string, kWh: number) => {
      const h = hoursOf(k)[10]!;
      return computeDay({ key: k, from: dayStart(k, TZ), to: dayStart(addDays(k, 1), TZ), hours: [h], stats: stats({ "sensor.import_t1": { [h]: kWh } }, { "sensor.price_now": { [h]: 0.5 } }), sources: s, file: EMPTY_ENERGY_FILE, known: noKnowledge(), complete: true }).ledger;
    };
    const m = sumLedgers("2026-10", dayStart("2026-10-01", TZ), dayStart("2026-11-01", TZ), [day("2026-10-01", 1), day("2026-10-02", 3)]);
    expect(m).toMatchObject({ key: "2026-10", days: 2, complete: true, total: 2, electricity: { importKwh: 4, importCost: 2 } });
  });

  it("projects the rest of the day at the last days' hourly use and today's prices", () => {
    const start = dayStart("2026-10-23", TZ);
    const row = (h: number, importKwh: number): HourRow => ({ start: start + h * HOUR, importKwh, exportKwh: 0, solarKwh: 0, gasM3: 0.1, waterM3: 0, price: 0.2, exportPrice: 0.2, gasPrice: 2, cost: 0, estimated: false });
    const past = [Array.from({ length: 24 }, (_, h) => row(h, 1)), Array.from({ length: 24 }, (_, h) => row(h, 3))];
    const today = { electricity: { importKwh: 0, exportKwh: 0, importCost: 1, exportCredit: 0 }, gas: { m3: 0, cost: 0.5 }, water: { m3: 0, cost: 0 }, fixed: 0.25 } as Parameters<typeof projectDay>[0];
    const p = projectDay(today, [row(0, 0)], [start + 22 * HOUR, start + 23 * HOUR], past, start, () => ({ price: 0.5, exportPrice: null, gasPrice: null }), null);
    // Two hours at 2 kWh × 0.5 and 0.1 m³ × the last gas price 2.
    expect(p).toEqual({ electricity: 3, gas: 0.9, water: 0, total: 4.15 });
  });

  it("places a price among the next day's", () => {
    const ahead = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    expect(priceBand(0.1, ahead)).toBe("cheap");
    expect(priceBand(0.35, ahead)).toBe("normal");
    expect(priceBand(0.6, ahead)).toBe("expensive");
    expect(priceBand(0.3, [0.3])).toBeUndefined();
  });
});

// ---- the service, against a fake Home Assistant ----

const NOW = Date.parse("2026-10-23T10:30:00Z"); // 12:30 in the house
const FIRST = dayStart("2026-10-20", TZ);

/** One kWh an hour on tariff 1, 0.1 m³ of gas, the price 0.2 until the 22nd, then 0.3; no price statistics before the 21st. */
function fakeHa(opts: { history?: boolean } = {}) {
  const changeOf = (id: string, h: number): number | undefined => {
    if (h < FIRST || h >= NOW) return undefined;
    if (id === "sensor.import_t1") return 1;
    if (id === "sensor.gas_meter") return 0.1;
    if (id === "sensor.heat_pump_heating_energy") return h === FIRST + 5 * HOUR ? -500 : 0.2;
    return 0;
  };
  const meanOf = (id: string, h: number): number | undefined => {
    if (id === "sensor.price_now") return h < dayStart("2026-10-21", TZ) ? undefined : h < dayStart("2026-10-22", TZ) ? 0.2 : 0.3;
    if (id === "sensor.gas_price") return h < dayStart("2026-10-21", TZ) ? undefined : 1.9;
    return undefined;
  };
  const statisticsDuringPeriod = vi.fn(async (req: { statisticIds: string[]; startTime: string; endTime?: string; period: string; types: string[] }) => {
    const from = Date.parse(req.startTime);
    const to = req.endTime !== undefined ? Date.parse(req.endTime) : NOW;
    const out: Record<string, Array<{ start: number; end: number; change?: number; mean?: number }>> = {};
    const step = req.period === "5minute" ? 5 * 60_000 : HOUR;
    for (const id of req.statisticIds) {
      const rows: Array<{ start: number; end: number; change?: number; mean?: number }> = [];
      if (req.period === "hour" || req.period === "5minute") {
        for (let t = Math.ceil(from / step) * step; t < to; t += step) {
          const h = Math.floor(t / HOUR) * HOUR;
          // An hour's row exists once the hour is over; 5-minute rows as they go.
          if (req.period === "hour" && h + HOUR > NOW) continue;
          const c = changeOf(id, h);
          const m = meanOf(id, h);
          if (c === undefined && m === undefined) continue;
          rows.push({ start: t, end: t + step, ...(c !== undefined ? { change: req.period === "5minute" ? c / 12 : c } : {}), ...(m !== undefined ? { mean: m } : {}) });
        }
      } else {
        // month or day: one row from the first hour with data.
        let first: number | undefined;
        for (let h = Math.max(from, FIRST); h < Math.min(to, NOW); h += HOUR) if (changeOf(id, h) !== undefined || meanOf(id, h) !== undefined) { first = h; break; }
        if (first !== undefined) rows.push({ start: first, end: first + HOUR, change: 1, ...(meanOf(id, NOW - HOUR) !== undefined ? { mean: meanOf(id, NOW - HOUR)! } : {}) });
      }
      if (rows.length > 0) out[id] = rows;
    }
    return out;
  });
  const callService = vi.fn(async (req: { service: string; serviceData?: Record<string, unknown> }) => {
    if (!opts.history) throw new Error("no such service");
    const start = String(req.serviceData!["start"]).slice(0, 10);
    const end = String(req.serviceData!["end"]).slice(0, 10);
    const prices: Array<{ start: string; end: string; price: number }> = [];
    for (const d of daysBetween(start, end)) {
      if (req.service === "get_gas_prices") {
        const s = dayStart(d, TZ) + 6 * HOUR;
        prices.push({ start: new Date(s).toISOString(), end: new Date(s + 24 * HOUR).toISOString(), price: 1.1 });
      } else {
        for (let h = dayStart(d, TZ); h < dayStart(addDays(d, 1), TZ); h += HOUR) prices.push({ start: new Date(h).toISOString(), end: new Date(h + HOUR).toISOString(), price: 0.4 });
      }
    }
    return { context: { id: "x", parent_id: null, user_id: null }, response: { prices } };
  });
  const send = vi.fn(async (m: { type: string }) => {
    if (m.type === "energy/get_prefs") return PREFS;
    if (m.type === "config_entries/get") return [{ entry_id: "entry1", state: "loaded" }];
    throw new Error(`unexpected ${m.type}`);
  });
  return { send, statisticsDuringPeriod, callService };
}

function fakeJournal() {
  const rows: Array<{ globalSeq: number; category: string; entityId: string; payload: unknown; ts: number }> = [];
  return {
    rows,
    append(category: string, entityId: string, payload: unknown, at = NOW) {
      rows.push({ globalSeq: rows.length + 1, category, entityId, payload, ts: Math.floor(at / 1000) });
    },
    queryEvents(q: { category?: string; entityId?: string; cursor?: number; sinceMs?: number; limit?: number }) {
      return rows
        .filter((r) => (q.category === undefined || r.category === q.category) && (q.entityId === undefined || r.entityId === q.entityId) && (q.cursor === undefined || r.globalSeq > q.cursor) && (q.sinceMs === undefined || r.ts * 1000 >= q.sinceMs))
        .slice(0, q.limit ?? 100)
        .map((r) => ({ ...r, sequenceNr: 0, manifest: "", envelope: null }));
    },
  };
}

function service(opts: { history?: boolean; file?: unknown } = {}) {
  const ha = fakeHa(opts);
  const journal = fakeJournal();
  const record = vi.fn(async (events: EnergyEvent[]) => {
    for (const e of events) journal.append(ENERGY_CATEGORY, e.tag === "DayClosed" ? "ledger" : "prices", e);
  });
  const make = (signals?: unknown) =>
    createEnergyService({
      ha: ha as never,
      journal: journal as never,
      record,
      ...(signals !== undefined ? { signals: signals as never } : {}),
      state: (id) => (id === "sensor.price_now" ? { state: "0.3", attributes: {} } : id === "sensor.gas_price" ? { state: "1.9", attributes: {} } : undefined),
      timeZone: () => TZ,
      file: parseEnergyFile(opts.file),
      log: () => {},
      now: () => NOW,
      chunkPauseMs: 0,
      tickMs: 0,
    });
  return { ha, journal, record, make };
}

describe("createEnergyService", () => {
  it("closes the past days once, priced from the statistics or the nearest month", async () => {
    const { make, record, ha } = service();
    const svc = make();
    svc.start();
    await svc.catchUp();
    const days = record.mock.calls.flatMap((c) => c[0]).filter((e): e is Extract<EnergyEvent, { tag: "DayClosed" }> => e.tag === "DayClosed");
    expect(days.map((d) => d.ledger.key).sort()).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    const d21 = days.find((d) => d.ledger.key === "2026-10-21")!.ledger;
    expect(d21).toMatchObject({ complete: true, estimated: false, electricity: { importKwh: 24, importCost: 4.8 } });
    // The 20th has no price statistics: the nearest month's mean, marked.
    const d20 = days.find((d) => d.ledger.key === "2026-10-20")!;
    expect(d20.ledger.estimated).toBe(true);
    // The heat pump's counter went back on the 20th: that hour counts nothing.
    expect(d20.ledger.devices.find((d) => d.id === "sensor.heat_pump_heating_energy")!.kWh).toBe(4.6);
    expect(d20.flags.map((f) => f.kind)).toContain("reset");
    expect(ha.callService).not.toHaveBeenCalled();

    // A second run closes nothing more; a new start folds the closed days from the journal.
    const before = record.mock.calls.length;
    await svc.catchUp();
    expect(record.mock.calls.length).toBe(before);
    const again = make();
    again.start();
    await again.catchUp();
    expect(record.mock.calls.length).toBe(before);
    const o = await again.overview();
    expect(o.days.map((d) => d.key)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(o.backfill).toMatchObject({ closedDays: 3, pendingDays: 0, running: false });
  });

  it("fetches past prices where the statistics have none, and derives the gas adder from the overlap", async () => {
    const { make, record, ha } = service({ history: true, file: { priceHistory: { source: "energyzero" } } });
    const svc = make();
    svc.start();
    await svc.catchUp();
    const events = record.mock.calls.flatMap((c) => c[0]);
    const prices = events.filter((e) => e.tag === "PricesRecorded");
    expect(prices.map((p) => p.kind).sort()).toEqual(["electricity", "gas"]);
    // Electricity history only for the day without price statistics.
    const elec = ha.callService.mock.calls.find((c) => c[0].service === "get_energy_prices")![0];
    expect(elec.serviceData).toMatchObject({ config_entry: "entry1", price_type: "all_in", incl_vat: true, start: "2026-10-20 00:00:00", end: "2026-10-20 23:59:00" });
    const d20 = events.find((e) => e.tag === "DayClosed" && e.ledger.key === "2026-10-20")!;
    expect(d20.tag === "DayClosed" && d20.ledger.electricity.importCost).toBe(9.6);
    // Gas on the 20th: market 1.1 plus the adder 1.9 − 1.1 the overlap days show, marked as derived.
    expect(d20.tag === "DayClosed" && d20.ledger.gas.cost).toBe(Math.round(2.4 * 1.9 * 100) / 100);
    expect(d20.tag === "DayClosed" && d20.ledger.estimated).toBe(true);
  });

  it("serves today so far with the running hour, a projection, and the periods", async () => {
    const { make } = service();
    const svc = make();
    svc.start();
    await svc.catchUp();
    const o = await svc.overview();
    expect(o.available).toBe(true);
    expect(o.today.key).toBe("2026-10-23");
    expect(o.today.complete).toBe(false);
    // 00:00–12:00 hourly, and half of the 12:00 hour from the 5-minute rows.
    expect(o.today.electricity.importKwh).toBeCloseTo(12.5);
    expect(o.projected!.total).toBeGreaterThan(o.today.total);
    expect(o.sources.gridImport).toEqual(["sensor.import_t1", "sensor.import_t2"]);

    const weeks = await svc.periods("week", "2026-10-19", "2026-10-25");
    expect(weeks.rows).toHaveLength(1);
    expect(weeks.rows[0]).toMatchObject({ key: "2026-W43", days: 4, complete: false });
    expect(weeks.rows[0]!.electricity.importKwh).toBeCloseTo(72 + 12.5);

    const h = await svc.hours("2026-10-21");
    expect(h.hours).toHaveLength(24);
    expect(h.hours[0]).toMatchObject({ importKwh: 1, price: 0.2 });
  });

  it("counts the showers shower-summary reported", async () => {
    const { make, journal } = service();
    journal.append("shower-summary", "main", { tag: "ShowerReported", litres: 40, gasM3: 0.3, cost: 0.62 }, dayStart("2026-10-23", TZ) + 7 * HOUR);
    journal.append("shower-summary", "main", { tag: "ShowerReported", litres: 35, gasM3: null, cost: null }, dayStart("2026-10-23", TZ) + 8 * HOUR);
    const svc = make();
    svc.start();
    const o = await svc.overview();
    expect(o.today.showers).toEqual({ count: 2, litres: 75, gasM3: 0.3, cost: 0.62 });
  });

  it("closes the days again when energy.json changes, keeping a gas split the signals no longer hold", async () => {
    const { make, record, journal } = service();
    // The 22nd was closed before, with a split and another configuration.
    journal.append(ENERGY_CATEGORY, "ledger", {
      tag: "DayClosed",
      at: NOW - 24 * HOUR,
      ledger: { key: "2026-10-22", gas: { m3: 2.4, cost: 0, hotWaterM3: 0.6, heatingM3: 1.2 } },
      flags: [],
      fingerprint: "an-older-one",
    });
    const file = { attribution: { hotWater: "binary_sensor.boiler_hot_water" } };
    // The signals were purged up to today: the 22nd's boiler states are gone.
    const svc = make({ query: () => [{ at: dayStart("2026-10-23", TZ), normalized: { value: 1, unit: null } }] });
    svc.configure(parseEnergyFile(file));
    svc.start();
    await svc.catchUp();
    const closedNow = () => record.mock.calls.flatMap((c) => c[0]).filter((e): e is Extract<EnergyEvent, { tag: "DayClosed" }> => e.tag === "DayClosed");
    expect(closedNow().map((e) => e.ledger.key).sort()).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(closedNow().find((e) => e.ledger.key === "2026-10-22")!.ledger.gas).toMatchObject({ m3: 2.4, hotWaterM3: 0.6, heatingM3: 1.2 });
    // Nothing changed: nothing closes again.
    await svc.catchUp();
    expect(closedNow()).toHaveLength(3);
    // A water meter added: every day again, the split kept.
    svc.configure(parseEnergyFile({ ...file, water: { stat: "sensor.water_meter", price: 1 } }));
    await svc.catchUp();
    expect(closedNow()).toHaveLength(6);
    expect(closedNow().at(-1)!.fingerprint).not.toBe(closedNow()[0]!.fingerprint);
    expect(closedNow().filter((e) => e.ledger.key === "2026-10-22").at(-1)!.ledger.gas.hotWaterM3).toBe(0.6);
  });

  it("splits a day's gas only when the signals cover it from before midnight", async () => {
    const day = dayStart("2026-10-22", TZ);
    const rows: Array<{ entityId: string; at: number; value: number | boolean }> = [];
    const meter = (at: number, value: number) => rows.push({ entityId: "sensor.gas_meter", at, value });
    const hot = (at: number, on: boolean) => rows.push({ entityId: "binary_sensor.boiler_hot_water", at, value: on });
    // The signals begin at 22:00 on the 21st: the 22nd is covered, the 21st is not.
    meter(day - 2 * HOUR, 100);
    for (let h = 0; h < 24; h++) meter(day + h * HOUR + 30 * 60_000, 100 + 0.1 * (h + 1));
    hot(day - 2 * HOUR, false);
    hot(day + 7 * HOUR, true);
    hot(day + 7 * HOUR + 40 * 60_000, false);
    const signals = {
      query: (q: { entityId: string; sinceMs?: number; untilMs?: number }) =>
        rows
          .filter((r) => r.entityId === q.entityId && r.at >= (q.sinceMs ?? 0) && r.at < (q.untilMs ?? Infinity))
          .sort((a, b) => a.at - b.at)
          .map((r) => ({ at: r.at, normalized: { value: r.value, unit: null } })),
    };
    const { ha, journal, record } = service();
    // The 21st was closed before with the shares of its last hours: closed again, it is not split.
    journal.append(ENERGY_CATEGORY, "ledger", { tag: "DayClosed", at: NOW, ledger: { key: "2026-10-21", gas: { m3: 2.4, cost: 0, hotWaterM3: 1.8, heatingM3: 0.6 } }, flags: [], fingerprint: "an-older-one" });
    const svc = createEnergyService({
      ha: ha as never,
      journal: journal as never,
      record,
      signals: signals as never,
      timeZone: () => TZ,
      file: parseEnergyFile({ attribution: { hotWater: "binary_sensor.boiler_hot_water" } }),
      log: () => {},
      now: () => NOW,
      chunkPauseMs: 0,
      tickMs: 0,
    });
    svc.start();
    await svc.catchUp();
    const closed = record.mock.calls.flatMap((c) => c[0]).filter((e): e is Extract<EnergyEvent, { tag: "DayClosed" }> => e.tag === "DayClosed");
    const gasOf = (k: string) => closed.find((e) => e.ledger.key === k)!.ledger.gas;
    // The hot-water spell 07:00–07:40 reaches the steps read at 07:30 and (with the meter's lag) 08:30: 2 of 24.
    expect(gasOf("2026-10-22").hotWaterM3).toBeCloseTo((2.4 * 2) / 24, 3);
    expect(gasOf("2026-10-21").hotWaterM3).toBeUndefined();
  });

  it("sums the heating seasons, October to April, with the heat pump route", async () => {
    const { make } = service();
    const svc = make();
    svc.start();
    await svc.catchUp();
    const res = await svc.seasons();
    expect(res.seasons.map((x) => x.key)).toEqual(["2026–27"]);
    const season = res.seasons[0]!;
    expect(season).toMatchObject({ from: "2026-10-01", to: "2027-04-30" });
    expect(season.ledger.days).toBe(4);
    expect(season.ledger.heat!.heatPumpKwh).toBeGreaterThan(0);
    expect(season.ledger.heat!.saving).toBeCloseTo(season.ledger.heat!.gasCost + season.ledger.heat!.gasFixed - season.ledger.heat!.heatPumpCost, 1);
    expect(res.assumptions.kWhPerM3).toBe(8.8);
    // The closed days of the last 365: the 20th to the 22nd.
    expect(res.year).toMatchObject({ from: "2025-10-23", to: "2026-10-22" });
    expect(res.year!.ledger.days).toBe(3);
  });

  it("says there is nothing to show without sources", async () => {
    const { make, ha } = service();
    ha.send.mockImplementation(async () => ({}));
    const svc = make();
    svc.start();
    await svc.catchUp();
    expect((await svc.overview()).available).toBe(false);
  });
});
