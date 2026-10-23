// ledger.ts — the arithmetic: Home Assistant's hourly statistics and the prices of each
// hour become hour rows, a day's ledger and a period's. Each hour is priced at its own
// price: the price entity's hourly mean, else a recorded past price, else (the entity
// was unavailable for a while) a neighbouring hour's within three hours, else (marked
// estimated) the price nearest in time. A counter that goes back (a reset, an
// integration added again) or jumps past what a house can use in an hour is not use:
// that hour counts 0 and the data band says so. The gas is split between hot water
// and heating by which of the boiler's states was on when the meter moved. Pure.
import { daysInYear } from "./calendar.js";
import { tariffOn, type EnergyFile, type Metered, type PriceSpec, type ResolvedSources } from "./config.js";
import type { DataFlag, DeviceUse, HeatLedger, HourRow, Ledger } from "./types.js";

/** statistics_during_period, by id: hour start → value. */
export interface HourlyStats {
  change: Map<string, Map<number, number>>;
  mean: Map<string, Map<number, number>>;
}

/** Prices known from elsewhere than HA's statistics. */
export interface PriceKnowledge {
  /** Hour start → all-in €/kWh, from the price history. */
  electricity: Map<number, number>;
  /** Market gas €/m³ (with VAT) per slot, oldest first: the price history's gas day. */
  gasMarket: Array<{ start: number; end: number; price: number }>;
  /** What the all-in gas price adds to the market price (taxes, markup), and whether it was configured or derived. */
  gasAdder?: { value: number; derived: boolean };
  /** Per price entity, a price to fall back on (the nearest known), marked estimated. */
  fallback: Map<string, number>;
}

export type Kind = "electricity" | "gas" | "water";

const HOUR = 3_600_000;
/** How far an hour without a price looks for a neighbour's. */
const CARRY_HOURS = 3;

export interface Priced {
  price: number;
  estimated: boolean;
}

/** The price of an hour for a spec. */
export function priceAt(spec: PriceSpec, kind: Kind, hour: number, stats: HourlyStats, known: PriceKnowledge): Priced | null {
  if ("fixed" in spec) return { price: spec.fixed, estimated: false };
  if ("none" in spec) return null;
  const means = stats.mean.get(spec.entity);
  const mean = means?.get(hour);
  if (mean !== undefined) return { price: mean, estimated: false };
  if (kind === "electricity") {
    const p = known.electricity.get(hour);
    if (p !== undefined) return { price: p, estimated: false };
  }
  // A price entity that was unavailable for an hour or two: the nearest hour's price, earlier first.
  for (let d = 1; d <= CARRY_HOURS && means !== undefined; d++) {
    const near = means.get(hour - d * HOUR) ?? means.get(hour + d * HOUR);
    if (near !== undefined) return { price: near, estimated: false };
  }
  if (kind === "gas" && known.gasAdder !== undefined) {
    const slot = known.gasMarket.find((s) => s.start <= hour && hour < s.end);
    if (slot !== undefined) return { price: slot.price + known.gasAdder.value, estimated: known.gasAdder.derived };
  }
  const fb = known.fallback.get(spec.entity);
  return fb === undefined ? null : { price: fb, estimated: true };
}

export interface DayInput {
  key: string;
  from: number;
  to: number;
  /** The hour starts of the day (23, 24 or 25; today: up to now). */
  hours: number[];
  stats: HourlyStats;
  sources: ResolvedSources;
  file: EnergyFile;
  known: PriceKnowledge;
  /** The shares of the day's gas that heated water and the house (0..1 each), when attributed. */
  gasShares?: { hotWater: number; heating: number };
  showers?: NonNullable<Ledger["showers"]>;
  /** Hot water per day, m³, for a day the boiler's states do not split (the heat pump route). */
  hotWaterM3?: number;
  complete: boolean;
}

export interface DayResult {
  ledger: Ledger;
  hours: HourRow[];
  flags: DataFlag[];
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

/** One day: its hour rows, its ledger, and what was wrong with its data. */
export function computeDay(input: DayInput): DayResult {
  const { stats, sources, file, known } = input;
  const flags: DataFlag[] = [];
  const flagged = new Set<string>();
  const flag = (kind: DataFlag["kind"], id: string, at: number, text: string): void => {
    const k = `${kind}|${id}`;
    if (flagged.has(k)) return;
    flagged.add(k);
    flags.push({ kind, id, at, text });
  };
  const qty = (id: string, hour: number, unit: "kWh" | "m³"): number => {
    const v = stats.change.get(id)?.get(hour);
    if (v === undefined || !Number.isFinite(v)) return 0;
    if (v < 0) {
      flag("reset", id, hour, `${id} went back by ${round(-v, 3)} ${unit} (a reset or the integration added again): that hour counts 0`);
      return 0;
    }
    const max = unit === "kWh" ? file.limits.maxKwhPerHour : file.limits.maxM3PerHour;
    if (v > max) {
      flag("spike", id, hour, `${id} jumped ${round(v, 3)} ${unit} in an hour, more than ${max}: that hour counts 0`);
      return 0;
    }
    return v;
  };
  const tariff = tariffOn(file.tariffs, input.key);
  let estimated = false;
  let hourEstimated = false;
  const price = (spec: PriceSpec, kind: Kind, hour: number): number | null => {
    const p = priceAt(spec, kind, hour, stats, known);
    if (p?.estimated === true) estimated = hourEstimated = true;
    return p?.price ?? null;
  };
  const exportPriceOf = (m: Metered, hour: number, importPrice: number | null): number | null => {
    const rule = tariff.exportPrice;
    if (rule === undefined) return price(m.price, "electricity", hour);
    if (rule === "import") return importPrice;
    if (typeof rule === "number") return rule;
    return price({ entity: rule }, "electricity", hour);
  };

  const rows: HourRow[] = [];
  const devices = new Map<string, { kWh: number; cost: number }>();
  let importKwh = 0, exportKwh = 0, importCost = 0, exportCredit = 0, solarKwh = 0, gasM3 = 0, gasCost = 0, waterM3 = 0, waterCost = 0;
  const pricedNone = new Set<string>();
  const hourGas: number[] = [];
  const hourPrice: Array<number | null> = [];
  for (const hour of input.hours) {
    hourEstimated = false;
    let hImport = 0, hExport = 0, hImportCost = 0, hCredit = 0, hGas = 0, hGasCost = 0, hWater = 0, hWaterCost = 0;
    // The import is paid at the price and the supplier's markup; net metering credits the price alone.
    const markup = tariff.importMarkup ?? 0;
    const basePrice = sources.imports[0] === undefined ? null : price(sources.imports[0].price, "electricity", hour);
    const mainPrice = basePrice === null ? null : basePrice + markup;
    for (const m of sources.imports) {
      const q = qty(m.id, hour, "kWh");
      const base = m === sources.imports[0] ? basePrice : price(m.price, "electricity", hour);
      const p = base === null ? null : base + markup;
      if (p === null && q > 0) pricedNone.add(m.id);
      hImport += q;
      hImportCost += q * (p ?? 0);
    }
    let rowExportPrice: number | null = null;
    for (const m of sources.exports) {
      const q = qty(m.id, hour, "kWh");
      const p = exportPriceOf(m, hour, basePrice);
      rowExportPrice ??= p;
      hExport += q;
      hCredit += q * (p ?? 0);
    }
    let hSolar = 0;
    for (const id of sources.solar) hSolar += qty(id, hour, "kWh");
    let rowGasPrice: number | null = null;
    for (const m of sources.gas) {
      const q = qty(m.id, hour, "m³");
      const p = price(m.price, "gas", hour);
      if (p === null && q > 0) pricedNone.add(m.id);
      rowGasPrice ??= p;
      hGas += q;
      hGasCost += q * (p ?? 0);
    }
    for (const m of sources.water) {
      const q = qty(m.id, hour, "m³");
      const p = price(m.price, "water", hour);
      hWater += q;
      hWaterCost += q * (p ?? 0);
    }
    for (const d of sources.devices) {
      const q = qty(d.id, hour, "kWh");
      const acc = devices.get(d.id) ?? { kWh: 0, cost: 0 };
      acc.kWh += q;
      acc.cost += q * (mainPrice ?? 0);
      devices.set(d.id, acc);
    }
    hourGas.push(hGas);
    hourPrice.push(mainPrice);
    rows.push({
      start: hour,
      importKwh: round(hImport),
      exportKwh: round(hExport),
      solarKwh: round(hSolar),
      gasM3: round(hGas),
      waterM3: round(hWater),
      price: mainPrice,
      exportPrice: rowExportPrice,
      gasPrice: rowGasPrice,
      cost: round(hImportCost - hCredit + hGasCost + hWaterCost),
      estimated: hourEstimated,
    });
    importKwh += hImport;
    exportKwh += hExport;
    importCost += hImportCost;
    exportCredit += hCredit;
    solarKwh += hSolar;
    gasM3 += hGas;
    gasCost += hGasCost;
    waterM3 += hWater;
    waterCost += hWaterCost;
  }
  for (const id of pricedNone) flag("estimated_price", id, input.from, `${id}: no price for some hours of ${input.key}; they cost 0`);
  if (estimated) flags.push({ kind: "estimated_price", at: input.from, text: `${input.key}: some hours priced from the nearest known price` });

  const fixedDay = (tariff.fixedPerDay?.electricity ?? 0) + (tariff.fixedPerDay?.gas ?? 0) + (tariff.fixedPerDay?.water ?? 0);
  const fixed = fixedDay - (tariff.taxCreditPerYear ?? 0) / daysInYear(input.key);
  const gas: Ledger["gas"] = { m3: round(gasM3), cost: round(gasCost, 2) };
  if (input.gasShares !== undefined) {
    gas.hotWaterM3 = round(gasM3 * input.gasShares.hotWater);
    gas.heatingM3 = round(gasM3 * input.gasShares.heating);
  }
  const temps = sources.outdoorTemperature === undefined ? undefined : stats.mean.get(sources.outdoorTemperature);
  const degreeDays = degreeDaysOf(input.hours, temps, file.degreeDays.base);
  const heat =
    sources.gas.length === 0
      ? undefined
      : heatOf({ hours: input.hours, gas: hourGas, prices: hourPrice, temps, gasM3, gasCost, gasFixed: tariff.fixedPerDay?.gas ?? 0, shares: input.gasShares, hotWaterM3: input.hotWaterM3, pump: file.heatPump });
  const total = importCost - exportCredit + gasCost + waterCost + fixed;
  const ledger: Ledger = {
    key: input.key,
    from: input.from,
    to: input.to,
    days: 1,
    complete: input.complete,
    electricity: { importKwh: round(importKwh), exportKwh: round(exportKwh), importCost: round(importCost, 2), exportCredit: round(exportCredit, 2) },
    solar: { kWh: round(solarKwh) },
    gas,
    water: { m3: round(waterM3), cost: round(waterCost, 2) },
    devices: sources.devices.map((d) => ({ id: d.id, name: d.name, use: d.use, kWh: round(devices.get(d.id)?.kWh ?? 0), cost: round(devices.get(d.id)?.cost ?? 0, 2) })),
    ...(input.showers !== undefined ? { showers: input.showers } : {}),
    fixed: round(fixed, 2),
    total: round(total, 2),
    ...(degreeDays !== undefined ? { degreeDays: round(degreeDays, 2) } : {}),
    estimated,
    ...(heat !== undefined ? { heat } : {}),
  };
  return { ledger, hours: rows, flags };
}

/** The COP at an outdoor temperature: straight lines between the given points, flat beyond them. */
export function copAt(cop: Array<[number, number]>, t: number): number {
  const first = cop[0]!;
  const last = cop.at(-1)!;
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < cop.length; i++) {
    const [t1, c1] = cop[i]!;
    const [t0, c0] = cop[i - 1]!;
    if (t <= t1) return c0 + ((c1 - c0) * (t - t0)) / (t1 - t0);
  }
  return last[1];
}

/**
 * The day's gas as heat, and the same heat from a heat pump: each hour's gas is split as
 * the day's (by the boiler's states, else hot water at a fixed daily amount spread over the
 * gas hours), the space heat at the COP of the hour's outdoor temperature (the day's mean
 * when an hour has none), the hot water at its own COP, priced at the hour's import price.
 */
export function heatOf(i: {
  hours: number[];
  gas: number[];
  prices: Array<number | null>;
  temps: Map<number, number> | undefined;
  gasM3: number;
  gasCost: number;
  gasFixed: number;
  shares: { hotWater: number; heating: number } | undefined;
  hotWaterM3: number | undefined;
  pump: EnergyFile["heatPump"];
}): HeatLedger {
  const hotShare = i.shares !== undefined ? i.shares.hotWater : i.gasM3 > 0 && i.hotWaterM3 !== undefined ? Math.min(1, i.hotWaterM3 / i.gasM3) : 0;
  const known = i.hours.map((h) => i.temps?.get(h)).filter((v): v is number => v !== undefined);
  const dayMean = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 7;
  const lastPrice = [...i.prices].reverse().find((p): p is number => p !== null) ?? 0;
  let space = 0, hot = 0, kWh = 0, cost = 0;
  i.hours.forEach((h, k) => {
    const g = i.gas[k] ?? 0;
    if (g <= 0) return;
    const hw = g * hotShare * i.pump.kWhPerM3;
    const sp = g * (1 - hotShare) * i.pump.kWhPerM3;
    const e = sp / copAt(i.pump.cop, i.temps?.get(h) ?? dayMean) + hw / i.pump.hotWaterCop;
    space += sp;
    hot += hw;
    kWh += e;
    cost += e * (i.prices[k] ?? lastPrice);
  });
  const saving = i.gasCost + i.gasFixed - cost;
  return {
    spaceKwh: round(space, 2),
    hotWaterKwh: round(hot, 2),
    split: i.shares !== undefined ? "measured" : "assumed",
    gasCost: round(i.gasCost, 2),
    gasFixed: round(i.gasFixed, 2),
    heatPumpKwh: round(kWh, 2),
    heatPumpCost: round(cost, 2),
    saving: round(saving, 2),
  };
}

/** max(0, base − the day's mean outdoor temperature), from at least half the day's hourly means. */
export function degreeDaysOf(hours: number[], means: Map<number, number> | undefined, base: number): number | undefined {
  if (means === undefined) return undefined;
  const vs = hours.map((h) => means.get(h)).filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (vs.length < Math.max(1, hours.length / 2)) return undefined;
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  return Math.max(0, base - mean);
}

/** Several days (or periods) as one: sums, devices merged by id, complete when all are. */
export function sumLedgers(key: string, from: number, to: number, parts: Ledger[]): Ledger {
  const devices = new Map<string, { id: string; name: string; use: DeviceUse; kWh: number; cost: number }>();
  let showers: Ledger["showers"];
  let hot = 0, heating = 0, attributed = false, dd = 0, ddKnown = false;
  let heat: HeatLedger | undefined;
  const splits = new Set<HeatLedger["split"]>();
  const out: Ledger = {
    key,
    from,
    to,
    days: 0,
    complete: parts.length > 0,
    electricity: { importKwh: 0, exportKwh: 0, importCost: 0, exportCredit: 0 },
    solar: { kWh: 0 },
    gas: { m3: 0, cost: 0 },
    water: { m3: 0, cost: 0 },
    devices: [],
    fixed: 0,
    total: 0,
    estimated: false,
  };
  for (const p of parts) {
    out.days += p.days;
    out.complete &&= p.complete;
    out.electricity.importKwh += p.electricity.importKwh;
    out.electricity.exportKwh += p.electricity.exportKwh;
    out.electricity.importCost += p.electricity.importCost;
    out.electricity.exportCredit += p.electricity.exportCredit;
    out.solar.kWh += p.solar.kWh;
    out.gas.m3 += p.gas.m3;
    out.gas.cost += p.gas.cost;
    if (p.gas.hotWaterM3 !== undefined || p.gas.heatingM3 !== undefined) {
      attributed = true;
      hot += p.gas.hotWaterM3 ?? 0;
      heating += p.gas.heatingM3 ?? 0;
    }
    out.water.m3 += p.water.m3;
    out.water.cost += p.water.cost;
    for (const d of p.devices) {
      const acc = devices.get(d.id) ?? { ...d, kWh: 0, cost: 0 };
      acc.kWh += d.kWh;
      acc.cost += d.cost;
      devices.set(d.id, acc);
    }
    if (p.showers !== undefined) {
      showers ??= { count: 0, litres: 0, gasM3: 0, cost: 0 };
      showers.count += p.showers.count;
      showers.litres += p.showers.litres;
      showers.gasM3 += p.showers.gasM3;
      showers.cost += p.showers.cost;
    }
    out.fixed += p.fixed;
    out.total += p.total;
    if (p.degreeDays !== undefined) {
      ddKnown = true;
      dd += p.degreeDays;
    }
    out.estimated ||= p.estimated;
    if (p.heat !== undefined) {
      heat ??= { spaceKwh: 0, hotWaterKwh: 0, split: p.heat.split, gasCost: 0, gasFixed: 0, heatPumpKwh: 0, heatPumpCost: 0, saving: 0 };
      splits.add(p.heat.split);
      heat.spaceKwh += p.heat.spaceKwh;
      heat.hotWaterKwh += p.heat.hotWaterKwh;
      heat.gasCost += p.heat.gasCost;
      heat.gasFixed += p.heat.gasFixed;
      heat.heatPumpKwh += p.heat.heatPumpKwh;
      heat.heatPumpCost += p.heat.heatPumpCost;
      heat.saving += p.heat.saving;
    }
  }
  const r2 = (n: number) => round(n, 2);
  const r4 = (n: number) => round(n);
  out.electricity = { importKwh: r4(out.electricity.importKwh), exportKwh: r4(out.electricity.exportKwh), importCost: r2(out.electricity.importCost), exportCredit: r2(out.electricity.exportCredit) };
  out.solar.kWh = r4(out.solar.kWh);
  out.gas = { m3: r4(out.gas.m3), cost: r2(out.gas.cost), ...(attributed ? { hotWaterM3: r4(hot), heatingM3: r4(heating) } : {}) };
  out.water = { m3: r4(out.water.m3), cost: r2(out.water.cost) };
  out.devices = [...devices.values()].map((d) => ({ ...d, kWh: r4(d.kWh), cost: r2(d.cost) }));
  if (showers !== undefined) out.showers = { count: showers.count, litres: Math.round(showers.litres), gasM3: r4(showers.gasM3), cost: r2(showers.cost) };
  out.fixed = r2(out.fixed);
  out.total = r2(out.total);
  if (ddKnown) out.degreeDays = r2(dd);
  if (heat !== undefined) {
    out.heat = {
      spaceKwh: r2(heat.spaceKwh),
      hotWaterKwh: r2(heat.hotWaterKwh),
      split: splits.size > 1 ? "mixed" : heat.split,
      gasCost: r2(heat.gasCost),
      gasFixed: r2(heat.gasFixed),
      heatPumpKwh: r2(heat.heatPumpKwh),
      heatPumpCost: r2(heat.heatPumpCost),
      saving: r2(heat.saving),
    };
  }
  return out;
}

// ---- splitting the gas: hot water against heating ----

export interface BinaryRow {
  at: number;
  on: boolean;
}

/** The spans a binary state was on within [from, to); `rows` sorted, including the last one before `from`. */
export function onSpans(rows: BinaryRow[], from: number, to: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let on = false;
  let since = from;
  for (const r of rows) {
    if (r.at <= from) {
      on = r.on;
      continue;
    }
    if (r.at >= to) break;
    if (r.on && !on) since = r.at;
    if (!r.on && on) spans.push([since, r.at]);
    on = r.on;
  }
  if (on) spans.push([since, to]);
  return spans;
}

const overlap = (a: number, b: number, spans: Array<[number, number]>): number => spans.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);

/**
 * The shares of a day's gas that went to hot water and to heating. Each step of the
 * meter counts for the state that was on between its previous reading (less the meter's
 * lag) and it, split by how long each was on; a step while neither was on stays
 * unattributed (cooking, or no state known). Undefined when the meter did not move.
 */
export function gasShares(
  readings: Array<{ at: number; value: number }>,
  hotWater: Array<[number, number]>,
  heating: Array<[number, number]>,
  lagMs: number,
): { hotWater: number; heating: number } | undefined {
  let total = 0, hot = 0, heat = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1]!;
    const b = readings[i]!;
    const step = b.value - a.value;
    if (!(step > 0)) continue;
    total += step;
    const h = overlap(a.at - lagMs, b.at, hotWater);
    const c = overlap(a.at - lagMs, b.at, heating);
    if (h + c === 0) continue;
    hot += (step * h) / (h + c);
    heat += (step * c) / (h + c);
  }
  if (total <= 0) return undefined;
  return { hotWater: hot / total, heating: heat / total };
}

// ---- today by its end ----

/**
 * The rest of today at the last days' use per hour of the day, priced on today's prices:
 * `priceOf(hour)` gives the prices for an hour to come (null: the last known).
 */
export function projectDay(
  today: Ledger,
  todayRows: HourRow[],
  remaining: number[],
  pastDays: HourRow[][],
  dayStartAt: number,
  priceOf: (hour: number) => { price: number | null; exportPrice: number | null; gasPrice: number | null },
  waterPrice: number | null,
): { total: number; electricity: number; gas: number; water: number } {
  const last = todayRows.at(-1);
  let elec = today.electricity.importCost - today.electricity.exportCredit;
  let gas = today.gas.cost;
  let water = today.water.cost;
  for (const hour of remaining) {
    const offset = Math.round((hour - dayStartAt) / 3_600_000);
    const same = pastDays.map((d) => d[offset]).filter((r): r is HourRow => r !== undefined);
    if (same.length === 0) continue;
    const avg = (f: (r: HourRow) => number) => same.reduce((s, r) => s + f(r), 0) / same.length;
    const p = priceOf(hour);
    const price = p.price ?? last?.price ?? 0;
    const exportPrice = p.exportPrice ?? last?.exportPrice ?? 0;
    const gasPrice = p.gasPrice ?? last?.gasPrice ?? 0;
    elec += avg((r) => r.importKwh) * price - avg((r) => r.exportKwh) * exportPrice;
    gas += avg((r) => r.gasM3) * gasPrice;
    water += avg((r) => r.waterM3) * (waterPrice ?? 0);
  }
  const r2 = (n: number) => round(n, 2);
  return { total: r2(elec + gas + water + today.fixed), electricity: r2(elec), gas: r2(gas), water: r2(water) };
}

/** Where a price sits among the next day's: the cheapest third, the dearest third, or between. */
export function priceBand(now: number, ahead: number[]): "cheap" | "normal" | "expensive" | undefined {
  if (ahead.length < 3) return undefined;
  const sorted = [...ahead].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
  if (now <= q(1 / 3)) return "cheap";
  if (now >= q(2 / 3)) return "expensive";
  return "normal";
}
