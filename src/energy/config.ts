// config.ts — what the energy ledger reads and how it prices it. The sources come from
// Home Assistant's energy preferences (energy/get_prefs: the grid with its tariffs and
// prices, solar, gas, water, the individual devices); energy.json in the config folder
// adds what HA's preferences cannot say: the fixed charges and the tax credit over
// time, the export price from a date on (when net metering ends), where to fetch past
// prices, which boiler states split the gas, a water meter HA does not list, and what
// each device's electricity is used for. Pure.

import type { DeviceUse, EnergySources } from "./types.js";
import { isDayKey } from "./calendar.js";

/** How an hour of a statistic is priced: an entity's hourly mean, a fixed price, or not at all. */
export type PriceSpec = { entity: string } | { fixed: number } | { none: true };

export interface Metered {
  id: string;
  price: PriceSpec;
}

/** The sources, resolved: HA's preferences with energy.json's additions. */
export interface ResolvedSources {
  imports: Metered[];
  exports: Metered[];
  solar: string[];
  gas: Metered[];
  water: Metered[];
  devices: Array<{ id: string; name: string; use: DeviceUse }>;
  outdoorTemperature?: string;
  attribution?: { gas: string; hotWater?: string; heating?: string; lagMs: number };
}

/** A tariff period: from its date on, until the next one. Fields a later period leaves out carry over. */
export interface Tariff {
  from: string;
  fixedPerDay?: { electricity?: number; gas?: number; water?: number };
  taxCreditPerYear?: number;
  /** The export price from this date: "import" (net metering), a fixed €/kWh, or a price entity. Default: HA's export price. */
  exportPrice?: "import" | number | string;
}

export interface EnergyFile {
  tariffs: Tariff[];
  /** Past prices for hours HA's statistics have no price for. */
  priceHistory?: { source: "energyzero"; configEntry?: string; gasAdder?: number };
  water?: { stat: string; price?: string | number };
  gas?: { stat?: string; price?: string | number };
  /** Per statistic id or pattern (`*` any run of characters): its use and name; an exact id HA does not list adds a device. */
  devices: Record<string, { use?: DeviceUse; name?: string; hidden?: boolean }>;
  attribution?: { gas?: string; hotWater?: string; heating?: string; lagMin?: number };
  degreeDays: { base: number; temperature?: string };
  /** An hour above these is a counter's artefact, not use. */
  limits: { maxKwhPerHour: number; maxM3PerHour: number };
}

export const EMPTY_ENERGY_FILE: EnergyFile = {
  tariffs: [],
  devices: {},
  degreeDays: { base: 18 },
  limits: { maxKwhPerHour: 25, maxM3PerHour: 10 },
};

const USES: DeviceUse[] = ["heating", "cooling", "hot_water", "ventilation", "other"];
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, where: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where} must be a number`);
  return v;
};
const entity = (v: unknown, where: string): string => {
  if (typeof v !== "string" || !ENTITY.test(v)) throw new Error(`${where} must be an entity id`);
  return v;
};
const priceOf = (v: unknown, where: string): string | number => (typeof v === "number" ? num(v, where) : entity(v, where));

/** energy.json, checked; the defaults for what it leaves out. Throws with the field at fault. */
export function parseEnergyFile(raw: unknown, path = "energy.json"): EnergyFile {
  if (raw === undefined) return EMPTY_ENERGY_FILE;
  if (!isObj(raw)) throw new Error(`${path}: expected an object`);
  const out: EnergyFile = { ...EMPTY_ENERGY_FILE, tariffs: [], devices: {}, degreeDays: { ...EMPTY_ENERGY_FILE.degreeDays }, limits: { ...EMPTY_ENERGY_FILE.limits } };
  if (raw.tariffs !== undefined) {
    if (!Array.isArray(raw.tariffs)) throw new Error(`${path}: tariffs must be an array`);
    out.tariffs = raw.tariffs.map((t, i) => {
      const w = `${path}: tariffs[${i}]`;
      if (!isObj(t) || !isDayKey(t.from)) throw new Error(`${w}.from must be a date YYYY-MM-DD`);
      const tariff: Tariff = { from: t.from };
      if (t.fixedPerDay !== undefined) {
        if (!isObj(t.fixedPerDay)) throw new Error(`${w}.fixedPerDay must be an object`);
        const f: NonNullable<Tariff["fixedPerDay"]> = {};
        for (const k of ["electricity", "gas", "water"] as const) if (t.fixedPerDay[k] !== undefined) f[k] = num(t.fixedPerDay[k], `${w}.fixedPerDay.${k}`);
        tariff.fixedPerDay = f;
      }
      if (t.taxCreditPerYear !== undefined) tariff.taxCreditPerYear = num(t.taxCreditPerYear, `${w}.taxCreditPerYear`);
      if (t.exportPrice !== undefined) tariff.exportPrice = t.exportPrice === "import" ? "import" : priceOf(t.exportPrice, `${w}.exportPrice`);
      return tariff;
    });
    out.tariffs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }
  if (raw.priceHistory !== undefined) {
    const p = raw.priceHistory;
    if (!isObj(p) || p.source !== "energyzero") throw new Error(`${path}: priceHistory.source must be "energyzero"`);
    out.priceHistory = { source: "energyzero" };
    if (p.configEntry !== undefined) {
      if (typeof p.configEntry !== "string") throw new Error(`${path}: priceHistory.configEntry must be a string`);
      out.priceHistory.configEntry = p.configEntry;
    }
    if (p.gasAdder !== undefined) out.priceHistory.gasAdder = num(p.gasAdder, `${path}: priceHistory.gasAdder`);
  }
  if (raw.water !== undefined) {
    if (!isObj(raw.water)) throw new Error(`${path}: water must be an object`);
    out.water = { stat: entity(raw.water.stat, `${path}: water.stat`), ...(raw.water.price !== undefined ? { price: priceOf(raw.water.price, `${path}: water.price`) } : {}) };
  }
  if (raw.gas !== undefined) {
    if (!isObj(raw.gas)) throw new Error(`${path}: gas must be an object`);
    out.gas = {
      ...(raw.gas.stat !== undefined ? { stat: entity(raw.gas.stat, `${path}: gas.stat`) } : {}),
      ...(raw.gas.price !== undefined ? { price: priceOf(raw.gas.price, `${path}: gas.price`) } : {}),
    };
  }
  if (raw.devices !== undefined) {
    if (!isObj(raw.devices)) throw new Error(`${path}: devices must be an object of statistic id or pattern → { use, name, hidden }`);
    for (const [k, v] of Object.entries(raw.devices)) {
      const w = `${path}: devices["${k}"]`;
      if (!isObj(v)) throw new Error(`${w} must be an object`);
      if (v.use !== undefined && !USES.includes(v.use as DeviceUse)) throw new Error(`${w}.use must be one of ${USES.join(", ")}`);
      if (v.name !== undefined && typeof v.name !== "string") throw new Error(`${w}.name must be a string`);
      if (v.hidden !== undefined && typeof v.hidden !== "boolean") throw new Error(`${w}.hidden must be true or false`);
      out.devices[k] = { ...(v.use !== undefined ? { use: v.use as DeviceUse } : {}), ...(v.name !== undefined ? { name: v.name } : {}), ...(v.hidden !== undefined ? { hidden: v.hidden } : {}) };
    }
  }
  if (raw.attribution !== undefined) {
    const a = raw.attribution;
    if (!isObj(a)) throw new Error(`${path}: attribution must be an object`);
    out.attribution = {
      ...(a.gas !== undefined ? { gas: entity(a.gas, `${path}: attribution.gas`) } : {}),
      ...(a.hotWater !== undefined ? { hotWater: entity(a.hotWater, `${path}: attribution.hotWater`) } : {}),
      ...(a.heating !== undefined ? { heating: entity(a.heating, `${path}: attribution.heating`) } : {}),
      ...(a.lagMin !== undefined ? { lagMin: num(a.lagMin, `${path}: attribution.lagMin`) } : {}),
    };
    if (out.attribution.hotWater === undefined && out.attribution.heating === undefined) throw new Error(`${path}: attribution needs hotWater or heating (a binary sensor that is on while the boiler does it)`);
  }
  if (raw.degreeDays !== undefined) {
    const d = raw.degreeDays;
    if (!isObj(d)) throw new Error(`${path}: degreeDays must be an object`);
    if (d.base !== undefined) out.degreeDays.base = num(d.base, `${path}: degreeDays.base`);
    if (d.temperature !== undefined) out.degreeDays.temperature = entity(d.temperature, `${path}: degreeDays.temperature`);
  }
  if (raw.limits !== undefined) {
    const l = raw.limits;
    if (!isObj(l)) throw new Error(`${path}: limits must be an object`);
    if (l.maxKwhPerHour !== undefined) out.limits.maxKwhPerHour = num(l.maxKwhPerHour, `${path}: limits.maxKwhPerHour`);
    if (l.maxM3PerHour !== undefined) out.limits.maxM3PerHour = num(l.maxM3PerHour, `${path}: limits.maxM3PerHour`);
  }
  return out;
}

// ---- Home Assistant's energy preferences ----

/** energy/get_prefs, the fields the ledger reads. */
export interface EnergyPrefs {
  energy_sources?: Array<{
    type: string;
    stat_energy_from?: string | null;
    stat_energy_to?: string | null;
    entity_energy_price?: string | null;
    number_energy_price?: number | null;
    entity_energy_price_export?: string | null;
    number_energy_price_export?: number | null;
    /** Before HA 2024: the grid's tariffs as lists. */
    flow_from?: Array<{ stat_energy_from?: string; entity_energy_price?: string | null; number_energy_price?: number | null }>;
    flow_to?: Array<{ stat_energy_to?: string; entity_energy_price?: string | null; number_energy_price?: number | null }>;
  }>;
  device_consumption?: Array<{ stat_consumption: string; name?: string | null }>;
}

const spec = (entityId: string | null | undefined, fixed: number | null | undefined): PriceSpec =>
  typeof entityId === "string" && entityId !== "" ? { entity: entityId } : typeof fixed === "number" ? { fixed } : { none: true };
const specOf = (p: string | number | undefined, fallback: PriceSpec): PriceSpec => (p === undefined ? fallback : typeof p === "number" ? { fixed: p } : { entity: p });

/** A use from a device's name or id, for devices energy.json says nothing about. */
export function guessUse(text: string): DeviceUse {
  const t = text.toLowerCase();
  if (/cool/.test(t)) return "cooling";
  if (/water heater|boiler|hot water|dhw/.test(t)) return "hot_water";
  if (/heat/.test(t)) return "heating";
  if (/vent|air handling|mvhr|recuperat/.test(t)) return "ventilation";
  return "other";
}

const patternRe = (p: string): RegExp => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** HA's preferences and energy.json, as the ledger reads them. */
export function resolveSources(prefs: EnergyPrefs, file: EnergyFile, outdoorTemperature?: string): ResolvedSources {
  const out: ResolvedSources = { imports: [], exports: [], solar: [], gas: [], water: [], devices: [] };
  for (const s of prefs.energy_sources ?? []) {
    if (s.type === "grid") {
      if (s.stat_energy_from) out.imports.push({ id: s.stat_energy_from, price: spec(s.entity_energy_price, s.number_energy_price) });
      if (s.stat_energy_to) out.exports.push({ id: s.stat_energy_to, price: spec(s.entity_energy_price_export, s.number_energy_price_export) });
      for (const f of s.flow_from ?? []) if (f.stat_energy_from) out.imports.push({ id: f.stat_energy_from, price: spec(f.entity_energy_price, f.number_energy_price) });
      for (const f of s.flow_to ?? []) if (f.stat_energy_to) out.exports.push({ id: f.stat_energy_to, price: spec(f.entity_energy_price, f.number_energy_price) });
    } else if (s.type === "solar" && s.stat_energy_from) {
      out.solar.push(s.stat_energy_from);
    } else if ((s.type === "gas" || s.type === "water") && s.stat_energy_from) {
      out[s.type].push({ id: s.stat_energy_from, price: spec(s.entity_energy_price, s.number_energy_price) });
    }
  }
  if (file.gas !== undefined) {
    const fallback = out.gas[0]?.price ?? { none: true };
    if (file.gas.stat !== undefined) out.gas = [{ id: file.gas.stat, price: specOf(file.gas.price, fallback) }];
    else out.gas = out.gas.map((g) => ({ ...g, price: specOf(file.gas!.price, g.price) }));
  }
  if (file.water !== undefined) {
    const known = out.water.find((w) => w.id === file.water!.stat);
    out.water = [...out.water.filter((w) => w.id !== file.water!.stat), { id: file.water.stat, price: specOf(file.water.price, known?.price ?? { none: true }) }];
  }
  // Devices: HA's, with energy.json's uses and names (an exact id wins over a pattern), then energy.json's own.
  const patterns = Object.entries(file.devices).filter(([k]) => k.includes("*")).map(([k, v]) => [patternRe(k), v] as const);
  const settingsOf = (id: string) => file.devices[id] ?? patterns.find(([re]) => re.test(id))?.[1];
  const seen = new Set<string>();
  const add = (id: string, name: string | undefined): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const s = settingsOf(id);
    if (s?.hidden === true) return;
    const label = s?.name ?? name ?? id;
    out.devices.push({ id, name: label, use: s?.use ?? guessUse(`${label} ${id}`) });
  };
  for (const d of prefs.device_consumption ?? []) add(d.stat_consumption, d.name ?? undefined);
  for (const id of Object.keys(file.devices)) if (!id.includes("*") && ENTITY.test(id)) add(id, undefined);
  const temperature = file.degreeDays.temperature ?? outdoorTemperature;
  if (temperature !== undefined) out.outdoorTemperature = temperature;
  const a = file.attribution;
  const gas = a?.gas ?? out.gas[0]?.id;
  if (a !== undefined && gas !== undefined) {
    out.attribution = { gas, ...(a.hotWater !== undefined ? { hotWater: a.hotWater } : {}), ...(a.heating !== undefined ? { heating: a.heating } : {}), lagMs: (a.lagMin ?? 5) * 60_000 };
  }
  return out;
}

/** The sources as the panel lists them. */
export function sourcesView(s: ResolvedSources): EnergySources {
  const name = (p: PriceSpec | undefined): string | undefined => (p === undefined ? undefined : "entity" in p ? p.entity : "fixed" in p ? `fixed ${p.fixed}` : undefined);
  const prices: EnergySources["prices"] = {};
  const e = name(s.imports[0]?.price);
  if (e !== undefined) prices.electricity = e;
  const x = name(s.exports[0]?.price);
  if (x !== undefined) prices.export = x;
  const g = name(s.gas[0]?.price);
  if (g !== undefined) prices.gas = g;
  const w = name(s.water[0]?.price);
  if (w !== undefined) prices.water = w;
  return {
    gridImport: s.imports.map((m) => m.id),
    gridExport: s.exports.map((m) => m.id),
    solar: s.solar,
    gas: s.gas.map((m) => m.id),
    water: s.water.map((m) => m.id),
    devices: s.devices,
    prices,
    ...(s.outdoorTemperature !== undefined ? { outdoorTemperature: s.outdoorTemperature } : {}),
    ...(s.attribution !== undefined
      ? { attribution: { gas: s.attribution.gas, ...(s.attribution.hotWater !== undefined ? { hotWater: s.attribution.hotWater } : {}), ...(s.attribution.heating !== undefined ? { heating: s.attribution.heating } : {}) } }
      : {}),
  };
}

/** Whether there is anything to keep a ledger of. */
export const hasSources = (s: ResolvedSources): boolean => s.imports.length + s.exports.length + s.solar.length + s.gas.length + s.water.length + s.devices.length > 0;

/** The tariff in effect on a day: the periods up to it, folded. */
export function tariffOn(tariffs: Tariff[], day: string): Omit<Tariff, "from"> {
  const t: Omit<Tariff, "from"> = {};
  for (const p of tariffs) {
    if (p.from > day) break;
    if (p.fixedPerDay !== undefined) t.fixedPerDay = { ...t.fixedPerDay, ...p.fixedPerDay };
    if (p.taxCreditPerYear !== undefined) t.taxCreditPerYear = p.taxCreditPerYear;
    if (p.exportPrice !== undefined) t.exportPrice = p.exportPrice;
  }
  return t;
}
