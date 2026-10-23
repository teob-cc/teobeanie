// energy.ts — the Energy tab's arithmetic: euros and quantities in en-GB, the money
// split by carrier and by use, the bars' scale and stacks, the price curve's marks,
// and the date ranges of each period and of the same periods a year earlier. Pure:
// views/Energy.tsx and components/EnergyCharts.tsx draw it.

import type { EnergyOverview, Ledger, PricePoint } from "../../src/energy/types";

export type Period = "day" | "week" | "month" | "year";

// ---- formatting ------------------------------------------------------------------

const EUR = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EUR_WHOLE = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const MINUS = "−";

/** €1.23, −€0.40, €1,234 (whole euros from a thousand up); a rounding residue reads €0.00. */
export function fmtEur(v: number): string {
  const r = Math.abs(v) < 0.005 ? 0 : v;
  const s = Math.abs(r) >= 1000 ? EUR_WHOLE.format(r) : EUR.format(r);
  return s.replace(/^-/, MINUS);
}

/** A short € for an axis or a bar: €12.34 below €100, whole euros from there (€140, €0.50, −€3.20). */
export function fmtEurShort(v: number): string {
  return Math.abs(v) >= 100 ? fmtEur(Math.round(v)).replace(/\.00$/, "") : fmtEur(v);
}

/** A price: €0.241/kWh, −€0.012/kWh (three decimals: prices move in tenths of a cent). */
export function fmtPrice(v: number, unit: "kWh" | "m³" = "kWh"): string {
  const s = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(v);
  return `${s.replace(/^-/, MINUS)}/${unit}`;
}

/** A quantity: 1,284 / 12.3 / 3.14 / 0.042, then the unit. */
export function fmtQty(v: number, unit: string): string {
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 || a === 0 ? 2 : 3;
  const s = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v);
  return `${s.replace(/^-/, MINUS)} ${unit}`;
}

export const fmtKwh = (v: number): string => fmtQty(v, "kWh");
export const fmtM3 = (v: number): string => fmtQty(v, "m³");

/** "14:00" in the house's time zone. */
export function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);
}

/** "23 Oct, 14:00" in the house's time zone. */
export function fmtWhen(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);
}

/** The local date ("YYYY-MM-DD") of an instant in the house's time zone. */
export function localDate(at: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---- the money split ---------------------------------------------------------------

export interface MoneyRow {
  key: string;
  label: string;
  /** €; may be negative (an export credit larger than the import). */
  value: number;
  /** CSS color of the bar and swatch. */
  tone: string;
  /** What the row holds, for the tooltip. */
  detail?: string;
}

/** Electricity's import cost less the export credit. */
export const netElectricity = (l: Ledger): number => l.electricity.importCost - l.electricity.exportCredit;

export const TONE = {
  electricity: "var(--series-1)",
  gas: "var(--series-2)",
  water: "var(--series-3)",
  fixed: "var(--muted)",
} as const;

/** The day's (or period's) total by carrier; the rows add up to the ledger's total. */
export function byCarrier(l: Ledger): MoneyRow[] {
  return [
    {
      key: "electricity",
      label: "Electricity",
      value: netElectricity(l),
      tone: TONE.electricity,
      detail: `${fmtKwh(l.electricity.importKwh)} in for ${fmtEur(l.electricity.importCost)}, ${fmtKwh(l.electricity.exportKwh)} out for ${fmtEur(l.electricity.exportCredit)} back`,
    },
    { key: "gas", label: "Gas", value: l.gas.cost, tone: TONE.gas, detail: fmtM3(l.gas.m3) },
    { key: "water", label: "Water", value: l.water.cost, tone: TONE.water, detail: fmtM3(l.water.m3) },
    { key: "fixed", label: "Fixed charges", value: l.fixed, tone: TONE.fixed, detail: "standing charges less the energy tax credit" },
  ];
}

/**
 * The same total by what it was used for. Gas is divided by the attributed m³ (heating,
 * hot water, the rest); without attribution it stays one row. Devices count by their use;
 * the rest of the electricity is the net electricity less the devices. Water and the fixed
 * charges close it, so the rows add up to the total. Empty rows are left out.
 */
export function byUse(l: Ledger): MoneyRow[] {
  const rows: MoneyRow[] = [];
  const gas = l.gas;
  const attributed = gas.heatingM3 !== undefined || gas.hotWaterM3 !== undefined;
  const share = (m3: number | undefined) => (gas.m3 > 0 && m3 !== undefined ? Math.min(1, Math.max(0, m3 / gas.m3)) * gas.cost : 0);
  const devices = (uses: string[]) => l.devices.filter((d) => uses.includes(d.use));
  const sum = (ds: Ledger["devices"]) => ds.reduce((a, d) => a + d.cost, 0);
  const names = (ds: Ledger["devices"]) => ds.map((d) => d.name).join(", ");

  if (attributed) {
    const heating = share(gas.heatingM3);
    const hot = share(gas.hotWaterM3);
    rows.push({ key: "heating_gas", label: "Heating (gas)", value: heating, tone: TONE.gas, detail: fmtM3(gas.heatingM3 ?? 0) });
    rows.push({ key: "hot_water_gas", label: "Hot water (gas)", value: hot, tone: TONE.gas, detail: fmtM3(gas.hotWaterM3 ?? 0) });
    rows.push({ key: "other_gas", label: "Other gas", value: Math.max(0, gas.cost - heating - hot), tone: TONE.gas, detail: "cooking, or no boiler state known" });
  } else {
    rows.push({ key: "gas", label: "Gas", value: gas.cost, tone: TONE.gas, detail: `${fmtM3(gas.m3)}, not divided by use` });
  }
  const pumps = devices(["heating", "cooling"]);
  const hotDevices = devices(["hot_water"]);
  const vent = devices(["ventilation"]);
  rows.push({ key: "heat_pumps", label: "Heat pumps", value: sum(pumps), tone: TONE.electricity, detail: names(pumps) });
  rows.push({ key: "hot_water_el", label: "Hot water (electric)", value: sum(hotDevices), tone: TONE.electricity, detail: names(hotDevices) });
  rows.push({ key: "ventilation", label: "Ventilation", value: sum(vent), tone: TONE.electricity, detail: names(vent) });
  rows.push({
    key: "rest",
    label: "Rest of the electricity",
    value: netElectricity(l) - sum(pumps) - sum(hotDevices) - sum(vent),
    tone: TONE.electricity,
    detail: "everything else, less the export credit",
  });
  rows.push({ key: "water", label: "Water", value: l.water.cost, tone: TONE.water, detail: fmtM3(l.water.m3) });
  rows.push({ key: "fixed", label: "Fixed charges", value: l.fixed, tone: TONE.fixed });
  // Keep the total's two catch-alls (gas undivided, the rest) even at zero; drop empty device rows.
  return rows.filter((r) => Math.abs(r.value) >= 0.005 || r.key === "rest" || r.key === "gas");
}

/** € per heating degree day, when the period had any. */
export function perDegreeDay(l: Ledger): number | null {
  return l.degreeDays !== undefined && l.degreeDays > 0 ? l.total / l.degreeDays : null;
}

// ---- bars ------------------------------------------------------------------------

/** A round top for an axis: 1, 2 or 5 × 10ⁿ at or above v (0 stays 0). */
export function niceMax(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v - 1e-9 * p) return m * p;
  return 10 * p;
}

/** A value axis from lo to hi (lo ≤ 0 ≤ hi), mapped to pixels top..top+height. */
export interface Scale {
  lo: number;
  hi: number;
  /** Pixel y of a value. */
  y: (v: number) => number;
}

/** One scale for every value: rounded out to niceMax on both sides of zero. */
export function scaleFor(values: number[], top: number, height: number): Scale {
  const hi = niceMax(Math.max(0, ...values));
  const lo = -niceMax(Math.max(0, ...values.map((v) => -v)));
  const span = hi - lo || 1;
  return { lo, hi, y: (v) => top + ((hi - v) / span) * height };
}

/** A stacked bar's segment, in value space. */
export interface Segment {
  key: string;
  tone: string;
  from: number;
  to: number;
}

/**
 * A ledger's bar stacked by carrier: the positive parts up from zero, a negative part
 * (electricity, when the export credit beat the import) down from zero, so the stack's
 * top less its bottom is the total.
 */
export function carrierStack(l: Ledger): Segment[] {
  let up = 0;
  let down = 0;
  const out: Segment[] = [];
  for (const r of byCarrier(l)) {
    if (r.value > 0) {
      out.push({ key: r.key, tone: r.tone, from: up, to: up + r.value });
      up += r.value;
    } else if (r.value < 0) {
      out.push({ key: r.key, tone: r.tone, from: down + r.value, to: down });
      down += r.value;
    }
  }
  return out;
}

/** Every value a stack reaches, for the scale. */
export function stackExtent(ls: Ledger[]): number[] {
  return ls.flatMap((l) => carrierStack(l).flatMap((s) => [s.from, s.to]));
}

// ---- prices ----------------------------------------------------------------------

export interface PriceMarks {
  /** Index of the slot now, the cheapest and the most expensive (−1: none). */
  now: number;
  min: number;
  max: number;
}

/** Where now, the cheapest and the dearest slots sit; the first of equal prices wins. */
export function priceMarks(points: PricePoint[], at: number): PriceMarks {
  let min = -1;
  let max = -1;
  points.forEach((p, i) => {
    if (min < 0 || p.price < points[min]!.price) min = i;
    if (max < 0 || p.price > points[max]!.price) max = i;
  });
  return { now: points.findIndex((p) => p.start <= at && at < p.end), min, max };
}

/** The price now: what the overview says, else the slot holding the instant. */
export function priceNow(o: Pick<EnergyOverview, "prices">, at: number): number | null {
  if (o.prices.now !== undefined) return o.prices.now;
  const p = o.prices.electricity.find((x) => x.start <= at && at < x.end);
  return p?.price ?? null;
}

/** The price band's chip: its words and its tone. */
export function bandChip(band: "cheap" | "normal" | "expensive" | undefined): { text: string; className: string } | null {
  switch (band) {
    case "cheap":
      return { text: "cheap now", className: "chip chip-ok" };
    case "normal":
      return { text: "normal", className: "chip chip-off" };
    case "expensive":
      return { text: "expensive now", className: "chip chip-warn" };
    default:
      return null;
  }
}

// ---- periods ---------------------------------------------------------------------

export interface PeriodChoice {
  period: Period;
  label: string;
  /** How many periods the chart shows, today's among them. */
  count: number;
}

export const PERIODS: PeriodChoice[] = [
  { period: "day", label: "7 days", count: 7 },
  { period: "week", label: "12 weeks", count: 12 },
  { period: "month", label: "12 months", count: 12 },
  { period: "year", label: "Years", count: 5 },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (day: string) => new Date(`${day}T00:00:00Z`);

/** A local date plus n days. */
export function addDays(day: string, n: number): string {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** A local date plus n years; 29 February falls back to the 28th. */
export function addYears(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${String(y + n).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The Monday of a date's ISO week. */
export function mondayOf(day: string): string {
  const wd = (parse(day).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return addDays(day, -wd);
}

/** The from and to (both local dates, to inclusive) of the chart's periods, ending today. */
export function periodRange(period: Period, today: string, count = PERIODS.find((p) => p.period === period)!.count): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  switch (period) {
    case "day":
      return { from: addDays(today, -(count - 1)), to: today };
    case "week":
      return { from: addDays(mondayOf(today), -7 * (count - 1)), to: today };
    case "month": {
      const first = new Date(Date.UTC(y, m - 1 - (count - 1), 1));
      return { from: iso(first), to: today };
    }
    case "year":
      return { from: `${y - (count - 1)}-01-01`, to: today };
  }
}

/** The same periods one year earlier; null for years (the bar to the left is the year before). */
export function yearEarlierRange(period: Period, today: string): { from: string; to: string } | null {
  if (period === "year") return null;
  const r = periodRange(period, today);
  const from = period === "week" ? mondayOf(addYears(r.from, -1)) : addYears(r.from, -1);
  return { from, to: addYears(r.to, -1) };
}

/** A period key one year earlier: "2026-10-23" → "2025-10-23", "2026-W43" → "2025-W43", "2026-10" → "2025-10". */
export function earlierKey(key: string): string {
  const m = /^(\d{4})(.*)$/.exec(key);
  if (m === null) return key;
  const prev = `${Number(m[1]) - 1}${m[2]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? addYears(key, -1) : prev;
}

/** The bar's label: "Mon 20", "W43", "Oct", "2026". */
export function periodLabel(period: Period, key: string): string {
  switch (period) {
    case "day":
      // ICU versions differ on the comma after the weekday: none, the same everywhere.
      return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(parse(key)).replace(",", "");
    case "week":
      return key.replace(/^\d{4}-/, "");
    case "month":
      return new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(parse(`${key}-01`));
    case "year":
      return key;
  }
}

/** The period's name in a sentence: "Friday 23 October", "week 43 of 2026", "October 2026", "2026". */
export function periodTitle(period: Period, key: string): string {
  switch (period) {
    case "day":
      return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(parse(key)).replace(",", "");
    case "week": {
      const m = /^(\d{4})-W(\d+)$/.exec(key);
      return m ? `week ${Number(m[2])} of ${m[1]}` : key;
    }
    case "month":
      return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(parse(`${key}-01`));
    case "year":
      return key;
  }
}

// ---- showers ---------------------------------------------------------------------

export type Showers = NonNullable<Ledger["showers"]>;

/** The showers of several days together; null when none reported any. */
export function sumShowers(ls: Ledger[]): Showers | null {
  const with_ = ls.filter((l) => l.showers !== undefined);
  if (with_.length === 0) return null;
  return with_.reduce<Showers>(
    (a, l) => ({ count: a.count + l.showers!.count, litres: a.litres + l.showers!.litres, gasM3: a.gasM3 + l.showers!.gasM3, cost: a.cost + l.showers!.cost }),
    { count: 0, litres: 0, gasM3: 0, cost: 0 },
  );
}

// ---- data ------------------------------------------------------------------------

/** A data flag's chip text. */
export function flagLabel(kind: string): string {
  const LABEL: Record<string, string> = {
    reset: "meter reset",
    spike: "spike",
    no_statistics: "no statistics",
    estimated_price: "estimated price",
    no_price_history: "no price history",
    unattributed: "not attributed",
  };
  return LABEL[kind] ?? kind.replace(/_/g, " ");
}

// ---- heat pump instead of gas ----

/** A season's verdict: the gas route (gas for heat and hot water, the gas connection) against a heat pump, and per degree day. */
export function seasonVerdict(l: Ledger): { gasRoute: number; heatPump: number; saving: number; perDegreeDay: number | null; heatKwh: number } | null {
  const h = l.heat;
  if (h === undefined) return null;
  const gasRoute = h.gasCost + h.gasFixed;
  return {
    gasRoute,
    heatPump: h.heatPumpCost,
    saving: h.saving,
    perDegreeDay: l.degreeDays !== undefined && l.degreeDays > 0 ? h.saving / l.degreeDays : null,
    heatKwh: h.spaceKwh + h.hotWaterKwh,
  };
}

/** "COP 2.6 at −7 °C to 5.5 at 20 °C" */
export function copLine(cop: Array<[number, number]>): string {
  const first = cop[0];
  const last = cop.at(-1);
  if (first === undefined || last === undefined) return "";
  const t = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v)} °C`;
  return first === last ? `COP ${first[1]}` : `COP ${first[1]} at ${t(first[0])} to ${last[1]} at ${t(last[0])}`;
}
