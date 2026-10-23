// The Energy tab's arithmetic (panel/src/energy.ts): euros and quantities in en-GB, the
// money by carrier and by use, the bars' scale and stacks, the price marks, and the
// date ranges of the periods and of the same periods a year earlier.

import { describe, expect, it } from "vitest";
import type { Ledger, PricePoint } from "../src/energy/types.js";
import {
  addYears,
  bandChip,
  byCarrier,
  byUse,
  carrierStack,
  clock,
  earlierKey,
  fmtEur,
  fmtEurShort,
  fmtKwh,
  fmtM3,
  fmtPrice,
  localDate,
  mondayOf,
  niceMax,
  perDegreeDay,
  periodLabel,
  periodRange,
  periodTitle,
  priceMarks,
  priceNow,
  scaleFor,
  sumShowers,
  yearEarlierRange,
} from "../panel/src/energy.js";

/** A day's ledger; the total is the parts' sum unless given. */
function ledger(p: Partial<Ledger> = {}): Ledger {
  const l: Ledger = {
    key: "2026-10-23",
    from: 0,
    to: 86_400_000,
    days: 1,
    complete: false,
    electricity: { importKwh: 10, exportKwh: 4, importCost: 3, exportCredit: 1 },
    solar: { kWh: 6 },
    gas: { m3: 4, cost: 6 },
    water: { m3: 0.2, cost: 0.5 },
    devices: [],
    fixed: 1.5,
    total: 0,
    estimated: false,
    ...p,
  };
  if (p.total === undefined) l.total = l.electricity.importCost - l.electricity.exportCredit + l.gas.cost + l.water.cost + l.fixed;
  return l;
}

const sum = (rows: Array<{ value: number }>) => rows.reduce((a, r) => a + r.value, 0);

describe("formatting", () => {
  it("writes euros in en-GB with a true minus and whole euros from a thousand", () => {
    expect(fmtEur(1.234)).toBe("€1.23");
    expect(fmtEur(-0.4)).toBe("−€0.40");
    expect(fmtEur(-0.001)).toBe("€0.00");
    expect(fmtEur(1234.56)).toBe("€1,235");
    expect(fmtEurShort(12.345)).toBe("€12.35");
    expect(fmtEurShort(140.4)).toBe("€140");
  });

  it("writes prices to a tenth of a cent, and quantities to a sensible precision", () => {
    expect(fmtPrice(0.24123)).toBe("€0.241/kWh");
    expect(fmtPrice(-0.0123)).toBe("−€0.012/kWh");
    expect(fmtPrice(1.3, "m³")).toBe("€1.300/m³");
    expect(fmtKwh(1284.4)).toBe("1,284 kWh");
    expect(fmtKwh(12.34)).toBe("12.3 kWh");
    expect(fmtKwh(3.14159)).toBe("3.14 kWh");
    expect(fmtKwh(0)).toBe("0 kWh");
    expect(fmtM3(0.0421)).toBe("0.042 m³");
  });

  it("reads clock times and local dates in the house's time zone", () => {
    const at = Date.UTC(2026, 9, 22, 22, 30); // 00:30 the next day in Amsterdam (CEST)
    expect(clock(at, "Europe/Amsterdam")).toBe("00:30");
    expect(localDate(at, "Europe/Amsterdam")).toBe("2026-10-23");
    expect(localDate(at, "UTC")).toBe("2026-10-22");
  });
});

describe("the money split", () => {
  it("by carrier: electricity is the import less the export credit; the rows add up to the total", () => {
    const l = ledger();
    const rows = byCarrier(l);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ["electricity", 2],
      ["gas", 6],
      ["water", 0.5],
      ["fixed", 1.5],
    ]);
    expect(sum(rows)).toBeCloseTo(l.total);
  });

  it("by use: gas by its attributed m³, devices by their use, the rest of the electricity, and the same total", () => {
    const l = ledger({
      gas: { m3: 4, cost: 6, heatingM3: 3, hotWaterM3: 0.5 },
      devices: [
        { id: "sensor.heat_pump", name: "Heat pump", use: "heating", kWh: 3, cost: 0.9 },
        { id: "sensor.ventilation", name: "Ventilation", use: "ventilation", kWh: 0.5, cost: 0.15 },
        { id: "sensor.washer", name: "Washer", use: "other", kWh: 1, cost: 0.3 },
      ],
    });
    const rows = Object.fromEntries(byUse(l).map((r) => [r.key, r.value]));
    expect(rows["heating_gas"]).toBeCloseTo(4.5);
    expect(rows["hot_water_gas"]).toBeCloseTo(0.75);
    expect(rows["other_gas"]).toBeCloseTo(0.75);
    expect(rows["heat_pumps"]).toBeCloseTo(0.9);
    expect(rows["ventilation"]).toBeCloseTo(0.15);
    // The "other" device stays in the rest: net 2 − 0.9 − 0.15.
    expect(rows["rest"]).toBeCloseTo(0.95);
    expect(rows["hot_water_el"]).toBeUndefined(); // no such device: no empty row
    expect(sum(byUse(l))).toBeCloseTo(l.total);
  });

  it("by use without attribution: gas stays one row", () => {
    const keys = byUse(ledger()).map((r) => r.key);
    expect(keys).toContain("gas");
    expect(keys).not.toContain("heating_gas");
    expect(keys).not.toContain("heat_pumps");
  });

  it("by use: an attribution larger than the gas never makes a share above the gas cost", () => {
    const rows = Object.fromEntries(byUse(ledger({ gas: { m3: 1, cost: 2, heatingM3: 1.2, hotWaterM3: 0 } })).map((r) => [r.key, r.value]));
    expect(rows["heating_gas"]).toBeCloseTo(2);
    expect(rows["other_gas"]).toBeUndefined();
  });

  it("per degree day only where there were degree days", () => {
    expect(perDegreeDay(ledger({ total: 10, degreeDays: 4 }))).toBeCloseTo(2.5);
    expect(perDegreeDay(ledger({ total: 10, degreeDays: 0 }))).toBeNull();
    expect(perDegreeDay(ledger({ total: 10 }))).toBeNull();
  });
});

describe("bars", () => {
  it("rounds an axis up to 1, 2 or 5 × 10ⁿ", () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(3.4)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(42)).toBe(50);
  });

  it("puts every value on one scale, zero inside it", () => {
    const s = scaleFor([3.4, -0.6], 0, 100);
    expect(s.hi).toBe(5);
    expect(s.lo).toBe(-1);
    expect(s.y(5)).toBe(0);
    expect(s.y(-1)).toBe(100);
    expect(s.y(0)).toBeCloseTo(100 * (5 / 6));
  });

  it("stacks the carriers up from zero, and a net export down from it", () => {
    const l = ledger({ electricity: { importKwh: 2, exportKwh: 10, importCost: 0.5, exportCredit: 2 } });
    const stack = carrierStack(l);
    expect(stack.find((s) => s.key === "electricity")).toEqual(expect.objectContaining({ from: -1.5, to: 0 }));
    const up = stack.filter((s) => s.to > 0);
    expect(up.map((s) => [s.key, s.from, s.to])).toEqual([
      ["gas", 0, 6],
      ["water", 6, 6.5],
      ["fixed", 6.5, 8],
    ]);
    // Top less bottom is the total.
    expect(Math.max(...stack.map((s) => s.to)) + Math.min(...stack.map((s) => s.from))).toBeCloseTo(l.total);
  });
});

describe("prices", () => {
  const h = 3_600_000;
  const pts: PricePoint[] = [0.3, 0.1, 0.25, 0.4, 0.1].map((price, i) => ({ start: i * h, end: (i + 1) * h, price }));

  it("finds now, the cheapest (the first of equals) and the most expensive slot", () => {
    expect(priceMarks(pts, 2.5 * h)).toEqual({ now: 2, min: 1, max: 3 });
    expect(priceMarks(pts, 9 * h).now).toBe(-1);
    expect(priceMarks([], 0)).toEqual({ now: -1, min: -1, max: -1 });
  });

  it("takes the price now from the overview, else from the slot holding the instant", () => {
    expect(priceNow({ prices: { electricity: pts, gas: [], now: 0.2 } }, 0)).toBe(0.2);
    expect(priceNow({ prices: { electricity: pts, gas: [] } }, 3.2 * h)).toBe(0.4);
    expect(priceNow({ prices: { electricity: [], gas: [] } }, 0)).toBeNull();
  });

  it("labels the price band", () => {
    expect(bandChip("cheap")).toEqual({ text: "cheap now", className: "chip chip-ok" });
    expect(bandChip("expensive")?.className).toBe("chip chip-warn");
    expect(bandChip(undefined)).toBeNull();
  });
});

describe("periods", () => {
  const today = "2026-10-23"; // a Friday, ISO week 43

  it("ends each chart's range today", () => {
    expect(periodRange("day", today)).toEqual({ from: "2026-10-17", to: today });
    expect(mondayOf(today)).toBe("2026-10-19");
    expect(periodRange("week", today)).toEqual({ from: "2026-08-03", to: today });
    expect(periodRange("month", today)).toEqual({ from: "2025-11-01", to: today });
    expect(periodRange("year", today)).toEqual({ from: "2022-01-01", to: today });
  });

  it("shifts the range a year back; weeks start on a Monday; years have no comparison", () => {
    expect(yearEarlierRange("day", today)).toEqual({ from: "2025-10-17", to: "2025-10-23" });
    const w = yearEarlierRange("week", today)!;
    expect(new Date(`${w.from}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(w).toEqual({ from: "2025-07-28", to: "2025-10-23" });
    expect(yearEarlierRange("month", today)).toEqual({ from: "2024-11-01", to: "2025-10-23" });
    expect(yearEarlierRange("year", today)).toBeNull();
  });

  it("maps a key to its key a year back, 29 February to the 28th", () => {
    expect(earlierKey("2026-10-23")).toBe("2025-10-23");
    expect(earlierKey("2028-02-29")).toBe("2027-02-28");
    expect(earlierKey("2026-W43")).toBe("2025-W43");
    expect(earlierKey("2026-10")).toBe("2025-10");
    expect(earlierKey("2026")).toBe("2025");
    expect(addYears("2027-02-28", 1)).toBe("2028-02-28");
  });

  it("labels bars and names periods", () => {
    expect(periodLabel("day", today)).toBe("Fri 23");
    expect(periodLabel("week", "2026-W43")).toBe("W43");
    expect(periodLabel("month", "2026-10")).toBe("Oct");
    expect(periodTitle("day", today)).toBe("Friday 23 October 2026");
    expect(periodTitle("week", "2026-W07")).toBe("week 7 of 2026");
    expect(periodTitle("month", "2026-10")).toBe("October 2026");
  });
});

describe("showers", () => {
  it("adds up the days that reported showers, and is null when none did", () => {
    const s = { count: 2, litres: 80, gasM3: 0.4, cost: 0.6 };
    expect(sumShowers([ledger({ showers: s }), ledger(), ledger({ showers: s })])).toEqual({ count: 4, litres: 160, gasM3: 0.8, cost: 1.2 });
    expect(sumShowers([ledger(), ledger()])).toBeNull();
  });
});
