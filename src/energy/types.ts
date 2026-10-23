// types.ts — what the energy ledger serves: the house's euros and quantities per hour,
// day and period, today's so far and projected, the price curve, and what is wrong
// with the data. Pure: the panel imports these types. Times are ms epoch; days are
// local dates ("YYYY-MM-DD") in the house's time zone.

/** What a consumer's electricity is used for, for the money by use. */
export type DeviceUse = "heating" | "cooling" | "hot_water" | "ventilation" | "other";

/** A day's, a week's, a month's or a year's money and quantities. */
export interface Ledger {
  /** "2026-10-23", "2026-W43" (ISO week), "2026-10" or "2026". */
  key: string;
  /** The period's first instant (local midnight) and the instant after it. */
  from: number;
  to: number;
  /** Days in the ledger: 1 for a day; for a period, the days it holds so far. */
  days: number;
  /** A closed day, or a period whose days are all closed. Today is never complete. */
  complete: boolean;
  electricity: {
    importKwh: number;
    exportKwh: number;
    /** € for the import, each hour at its price. */
    importCost: number;
    /** € credited for the export (net metering: the import price; later, the feed-in price). */
    exportCredit: number;
  };
  solar: { kWh: number };
  gas: {
    m3: number;
    cost: number;
    /** The gas that heated water and the gas that heated the house (the rest: cooking, or no boiler state known). Absent when not attributed. */
    hotWaterM3?: number;
    heatingM3?: number;
  };
  water: { m3: number; cost: number };
  /** The individual consumers (HA's device consumption and energy.json's devices). */
  devices: Array<{ id: string; name: string; use: DeviceUse; kWh: number; cost: number }>;
  /** Hot water uses reported by shower-summary instances. */
  showers?: { count: number; litres: number; gasM3: number; cost: number };
  /** Fixed charges for the days, less the share of the energy tax credit, €. */
  fixed: number;
  /** importCost − exportCredit + gas.cost + water.cost + fixed, €. */
  total: number;
  /** Heating degree days (base 18 °C unless energy.json says otherwise), from the outdoor temperature's hourly means. */
  degreeDays?: number;
  /** Some hour was priced from an estimate (no price known for it). */
  estimated: boolean;
}

/** One hour: quantities, the prices it was priced at, and the cost. */
export interface HourRow {
  start: number;
  importKwh: number;
  exportKwh: number;
  solarKwh: number;
  gasM3: number;
  waterM3: number;
  /** €/kWh, €/m³; null: no price known. */
  price: number | null;
  exportPrice: number | null;
  gasPrice: number | null;
  /** importCost − exportCredit + gas + water, € (no fixed charges). */
  cost: number;
  estimated: boolean;
}

/** One price slot (an hour, or a quarter). */
export interface PricePoint {
  start: number;
  end: number;
  /** €/kWh (electricity) or €/m³ (gas). */
  price: number;
}

/** Something wrong with the data, for the Data band. */
export interface DataFlag {
  kind: "reset" | "spike" | "no_statistics" | "estimated_price" | "no_price_history" | "unattributed";
  /** The statistic or entity concerned. */
  id?: string;
  /** When (the hour, or the day's start). */
  at?: number;
  text: string;
}

/** What the ledger reads: each statistic id with the name the panel shows. */
export interface EnergySources {
  gridImport: string[];
  gridExport: string[];
  solar: string[];
  gas: string[];
  water: string[];
  devices: Array<{ id: string; name: string; use: DeviceUse }>;
  /** The price entities (or "fixed" prices) in use. */
  prices: { electricity?: string; export?: string; gas?: string; water?: string };
  /** The outdoor temperature the degree days come from. */
  outdoorTemperature?: string;
  /** The entities the gas is attributed with. */
  attribution?: { gas: string; hotWater?: string; heating?: string };
}

/** GET api/energy: the Energy tab's first load. */
export interface EnergyOverview {
  at: number;
  timeZone: string;
  /** False when Home Assistant has no energy preferences and energy.json names no source: there is nothing to show. */
  available: boolean;
  sources: EnergySources;
  /** Today so far (complete: false). */
  today: Ledger;
  /** Today by its end: so far plus the rest of the day at the last 7 days' hourly use, priced on today's curve. */
  projected?: { total: number; electricity: number; gas: number; water: number };
  /** The last 7 closed days, oldest first. */
  days: Ledger[];
  /** Today's and (once published) tomorrow's prices. */
  prices: {
    electricity: PricePoint[];
    gas: PricePoint[];
    /** The price now, €/kWh, and where it sits in the next 24 h. */
    now?: number;
    band?: "cheap" | "normal" | "expensive";
  };
  flags: DataFlag[];
  /** Closing past days from Home Assistant's statistics (once, at the first start; then each night). */
  backfill: { closedDays: number; firstDay?: string; lastDay?: string; pendingDays: number; running: boolean; error?: string };
}

/** GET api/energy/periods?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD */
export interface EnergyPeriods {
  period: "day" | "week" | "month" | "year";
  /** Oldest first; the current period includes today so far. */
  rows: Ledger[];
}

/** GET api/energy/hours?date=YYYY-MM-DD */
export interface EnergyHours {
  date: string;
  hours: HourRow[];
}
