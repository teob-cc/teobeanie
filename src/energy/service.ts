// service.ts — the energy ledger: today from Home Assistant's statistics as it goes,
// the past from the days it closed. At the first start it closes every past day the
// statistics hold (up to five years, newest first, a month at a time), fetching past
// prices where the statistics have none; then it closes each day after midnight. A day
// closes with the gas split between hot water and heating while the signals still hold
// the boiler's states, and with the showers the shower-summary instances reported.
// Read-only towards Home Assistant: energy/get_prefs, statistics, config entries, and
// the price history's service calls that only return data.

import type { HaClient } from "@lambda-house/teob-ts/ha";
import type { JournalReader } from "@lambda-house/teob-ts/core";
import type { SignalStore } from "@lambda-house/teob-ts/ha";
import { addDays, dayKey, dayStart, daysBetween, isDayKey, nextPeriodFirstDay, periodFirstDay, periodKey, type Period } from "./calendar.js";
import { hasSources, resolveSources, sourcesView, type EnergyFile, type EnergyPrefs, type PriceSpec, type ResolvedSources } from "./config.js";
import { LEDGER_ENTITY, PRICES_ENTITY, readStream, type DayClosed, type EnergyEvent, type PricesRecorded } from "./journal.js";
import { computeDay, gasShares, onSpans, priceBand, projectDay, sumLedgers, type BinaryRow, type HourlyStats, type PriceKnowledge } from "./ledger.js";
import type { DataFlag, EnergyHours, EnergyOverview, EnergyPeriods, HourRow, Ledger, PricePoint } from "./types.js";

export interface EnergyService {
  overview(): Promise<EnergyOverview>;
  periods(period: Period, from: string, to: string): Promise<EnergyPeriods>;
  hours(date: string): Promise<EnergyHours>;
  /** energy.json changed (a reload). */
  configure(file: EnergyFile): void;
  /** Fold the journal and start closing days. */
  start(): void;
  /** Close the past days not closed yet (the start and the nightly run call it). */
  catchUp(): Promise<void>;
  stop(): void;
}

export interface EnergyServiceDeps {
  ha: Pick<HaClient, "send" | "statisticsDuringPeriod" | "callService">;
  journal: Pick<JournalReader, "queryEvents">;
  record: (events: EnergyEvent[]) => Promise<void>;
  /** The signal store: the boiler's states and the gas meter's readings, for the gas split. */
  signals?: Pick<SignalStore, "query">;
  /** An entity's live state (the bridge's cache): price entities now, a price curve in their attributes. */
  state?: (entityId: string) => { state: string; attributes: Record<string, unknown> } | undefined;
  timeZone: () => string;
  /** The house's outdoor temperature (allowlist.json "outdoor"), for the degree days. */
  outdoorTemperature?: () => string | undefined;
  file: EnergyFile;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
  /** How far back the first start closes days. Default 5 years. */
  maxBackfillDays?: number;
  /** The pause between two months of the backfill. Default 2 s. */
  chunkPauseMs?: number;
  /** How often the nightly run looks for a day to close. Default 10 min; 0: never on its own. */
  tickMs?: number;
}

const HOUR = 3_600_000;
const PREFS_TTL_MS = 10 * 60_000;
const TODAY_TTL_MS = 60_000;
const CURVE_TTL_MS = 30 * 60_000;
/** A day closes this long after its end, when HA has compiled its last hour. */
const CLOSE_AFTER_MS = 20 * 60_000;
const UNITS = { energy: "kWh", volume: "m³" };
const SHOWER_CATEGORY = "shower-summary";

const emptyStats = (): HourlyStats => ({ change: new Map(), mean: new Map() });
const entityOf = (p: PriceSpec): string | undefined => ("entity" in p ? p.entity : undefined);
const parseTime = (s: unknown): number => (typeof s === "number" ? s : typeof s === "string" ? Date.parse(s.replace(" ", "T")) : NaN);

export function createEnergyService(deps: EnergyServiceDeps): EnergyService {
  const now = deps.now ?? Date.now;
  let file = deps.file;
  const zone = (): string => deps.timeZone();
  const closed = new Map<string, DayClosed>();
  const known: PriceKnowledge = { electricity: new Map(), gasMarket: [], fallback: new Map() };
  const status: EnergyOverview["backfill"] = { closedDays: 0, pendingDays: 0, running: false };
  let firstDay: string | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let kickoff: ReturnType<typeof setTimeout> | undefined;

  const fold = (e: EnergyEvent): void => {
    if (e.tag === "DayClosed") {
      closed.set(e.ledger.key, e);
    } else if (e.kind === "electricity") {
      for (const [s, end, p] of e.slots) {
        // Quarter prices are averaged into their hour.
        if (end - s >= HOUR) known.electricity.set(s, p);
        else {
          const h = Math.floor(s / HOUR) * HOUR;
          const prev = known.electricity.get(h);
          known.electricity.set(h, prev === undefined ? p : (prev + p) / 2);
        }
      }
    } else {
      for (const [start, end, price] of e.slots) known.gasMarket.push({ start, end, price });
      known.gasMarket.sort((a, b) => a.start - b.start);
    }
  };

  // ---- Home Assistant's energy preferences, the sources ----
  let prefs: { at: number; prefs: EnergyPrefs } | undefined;
  const sources = async (): Promise<ResolvedSources> => {
    if (prefs === undefined || now() - prefs.at > PREFS_TTL_MS) {
      try {
        prefs = { at: now(), prefs: await deps.ha.send<EnergyPrefs>({ type: "energy/get_prefs" }) };
      } catch (err) {
        // No preferences (HA without the energy dashboard set up): energy.json alone.
        deps.log("debug", `energy: no energy preferences (${String(err)})`);
        prefs = { at: now(), prefs: {} };
      }
    }
    return resolveSources(prefs.prefs, file, deps.outdoorTemperature?.());
  };
  const quantityIds = (s: ResolvedSources): string[] => [...new Set([...s.imports, ...s.exports, ...s.gas, ...s.water].map((m) => m.id).concat(s.solar, s.devices.map((d) => d.id)))];
  const priceEntities = (s: ResolvedSources): string[] =>
    [...new Set([...s.imports, ...s.exports, ...s.gas, ...s.water].map((m) => entityOf(m.price)).concat(exportEntities()).filter((x): x is string => x !== undefined))];
  const exportEntities = (): string[] => file.tariffs.map((t) => t.exportPrice).filter((p): p is string => typeof p === "string" && p !== "import");

  // ---- statistics ----
  const fetchStats = async (s: ResolvedSources, from: number, to: number, period: "hour" | "5minute" = "hour"): Promise<HourlyStats> => {
    const out = emptyStats();
    const changeIds = quantityIds(s);
    const meanIds = period === "hour" ? [...priceEntities(s), ...(s.outdoorTemperature !== undefined ? [s.outdoorTemperature] : [])] : [];
    const ids = [...new Set([...changeIds, ...meanIds])];
    if (ids.length === 0) return out;
    const stats = await deps.ha.statisticsDuringPeriod({ statisticIds: ids, startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString(), period, types: ["change", "mean"], units: UNITS });
    for (const [id, rows] of Object.entries(stats)) {
      for (const r of rows) {
        const start = parseTime(r.start);
        if (!Number.isFinite(start)) continue;
        // 5-minute rows are summed into their hour.
        const hour = period === "hour" ? start : Math.floor(start / HOUR) * HOUR;
        if (typeof r.change === "number" && changeIds.includes(id)) {
          const m = out.change.get(id) ?? new Map<number, number>();
          m.set(hour, (m.get(hour) ?? 0) + r.change);
          out.change.set(id, m);
        }
        if (typeof r.mean === "number" && meanIds.includes(id)) {
          const m = out.mean.get(id) ?? new Map<number, number>();
          m.set(hour, r.mean);
          out.mean.set(id, m);
        }
      }
    }
    return out;
  };

  /** Monthly means of the price entities, for the nearest known price: refreshed daily. */
  let monthly: { at: number; means: Map<string, Array<{ start: number; mean: number }>> } | undefined;
  const monthlyMeans = async (s: ResolvedSources): Promise<Map<string, Array<{ start: number; mean: number }>>> => {
    if (monthly !== undefined && now() - monthly.at < 24 * HOUR) return monthly.means;
    const ids = priceEntities(s);
    const means = new Map<string, Array<{ start: number; mean: number }>>();
    if (ids.length > 0) {
      const stats = await deps.ha.statisticsDuringPeriod({ statisticIds: ids, startTime: new Date(now() - 6 * 366 * 24 * HOUR).toISOString(), period: "month", types: ["mean"] });
      for (const [id, rows] of Object.entries(stats)) {
        means.set(id, rows.filter((r) => typeof r.mean === "number").map((r) => ({ start: parseTime(r.start), mean: r.mean as number })));
      }
    }
    monthly = { at: now(), means };
    return means;
  };
  /** Per price entity, the price for hours with none: now, the live state; in the past, the nearest month's mean. */
  const fallbackFor = (s: ResolvedSources, at: number, means: Map<string, Array<{ start: number; mean: number }>>, live: boolean): Map<string, number> => {
    const out = new Map<string, number>();
    for (const id of priceEntities(s)) {
      const v = live ? Number(deps.state?.(id)?.state) : NaN;
      if (Number.isFinite(v)) {
        out.set(id, v);
        continue;
      }
      const ms = means.get(id) ?? [];
      let best: { start: number; mean: number } | undefined;
      for (const m of ms) if (best === undefined || Math.abs(m.start - at) < Math.abs(best.start - at)) best = m;
      if (best !== undefined) out.set(id, best.mean);
    }
    return out;
  };

  // ---- the gas adder: what the all-in gas price adds to the market price ----
  const gasAdder = async (s: ResolvedSources): Promise<PriceKnowledge["gasAdder"]> => {
    if (file.priceHistory?.gasAdder !== undefined) return { value: file.priceHistory.gasAdder, derived: false };
    const entity = s.gas[0] === undefined ? undefined : entityOf(s.gas[0].price);
    if (entity === undefined || known.gasMarket.length === 0) return undefined;
    const first = known.gasMarket[0]!.start;
    const stats = await deps.ha.statisticsDuringPeriod({ statisticIds: [entity], startTime: new Date(first).toISOString(), period: "day", types: ["mean"] });
    const diffs: number[] = [];
    for (const r of stats[entity] ?? []) {
      if (typeof r.mean !== "number") continue;
      const day = dayKey(parseTime(r.start), zone());
      const slot = known.gasMarket.find((g) => dayKey(g.start, zone()) === day);
      if (slot !== undefined) diffs.push(r.mean - slot.price);
    }
    if (diffs.length === 0) return undefined;
    diffs.sort((a, b) => a - b);
    return { value: diffs[Math.floor(diffs.length / 2)]!, derived: true };
  };

  // ---- the price history (EnergyZero, through Home Assistant) ----
  let configEntry: string | undefined;
  const entryId = async (): Promise<string | undefined> => {
    if (file.priceHistory?.configEntry !== undefined) return file.priceHistory.configEntry;
    if (configEntry !== undefined) return configEntry;
    const entries = await deps.ha.send<Array<{ entry_id: string; state?: string }>>({ type: "config_entries/get", domain: "energyzero" });
    configEntry = entries.find((e) => e.state === "loaded")?.entry_id ?? entries[0]?.entry_id;
    return configEntry;
  };
  /** The service's slots for the days a..b (local dates), or [] when it has none. */
  const fetchHistory = async (kind: "electricity" | "gas", a: string, b: string): Promise<Array<[number, number, number]>> => {
    const entry = await entryId();
    if (entry === undefined) throw new Error("no EnergyZero integration in Home Assistant");
    const res = await deps.ha.callService({
      domain: "energyzero",
      service: kind === "electricity" ? "get_energy_prices" : "get_gas_prices",
      serviceData: { config_entry: entry, incl_vat: true, ...(kind === "electricity" ? { price_type: "all_in" } : {}), start: `${a} 00:00:00`, end: `${b} 23:59:00` },
      returnResponse: true,
      timeoutMs: 30_000,
    });
    const prices = (res.response as { prices?: Array<{ start?: string; end?: string; price?: number }> } | undefined)?.prices ?? [];
    return prices
      .map((p) => [parseTime(p.start), parseTime(p.end), p.price] as const)
      .filter((p): p is [number, number, number] => Number.isFinite(p[0]) && Number.isFinite(p[1]) && typeof p[2] === "number")
      .map(([s, e, p]) => [s, e, p]);
  };
  /** Fetch and journal past prices for days a..b; a range the service refuses is tried day by day. */
  const recordHistory = async (kind: "electricity" | "gas", a: string, b: string): Promise<PricesRecorded[]> => {
    const one = async (x: string, y: string): Promise<Array<[number, number, number]>> => {
      try {
        return await fetchHistory(kind, x, y);
      } catch (err) {
        if (x === y) {
          deps.log("debug", `energy: no ${kind} price history for ${x} (${String(err)})`);
          return [];
        }
        const out: Array<[number, number, number]> = [];
        for (const d of daysBetween(x, y)) out.push(...(await one(d, d)));
        return out;
      }
    };
    const slots = await one(a, b);
    if (slots.length === 0) return [];
    const event: PricesRecorded = { tag: "PricesRecorded", at: now(), kind, source: "energyzero", priceType: kind === "electricity" ? "all_in" : "market", slots };
    await deps.record([event]);
    fold(event);
    return [event];
  };

  // ---- the gas split and the showers of a day ----
  const sharesOf = (s: ResolvedSources, from: number, to: number): { hotWater: number; heating: number } | undefined => {
    const a = s.attribution;
    if (a === undefined || deps.signals === undefined) return undefined;
    const readings = deps.signals
      .query({ entityId: a.gas, sinceMs: from - 6 * HOUR, untilMs: to, order: "asc", limit: 5000 })
      .filter((r) => typeof r.normalized.value === "number")
      .map((r) => ({ at: r.at, value: r.normalized.value as number }));
    const inDay = readings.filter((r) => r.at >= from);
    if (inDay.length < 2) return undefined;
    // The step into the day counts too: start from the last reading before midnight.
    const before = readings.filter((r) => r.at < from).at(-1);
    const rowsOf = (id: string | undefined): Array<[number, number]> => {
      if (id === undefined) return [];
      const rows: BinaryRow[] = deps.signals!
        .query({ entityId: id, sinceMs: from - 24 * HOUR, untilMs: to, order: "asc", limit: 5000 })
        .map((r) => ({ at: r.at, on: r.normalized.value === true }));
      return onSpans(rows, from - a.lagMs, to);
    };
    return gasShares(before === undefined ? inDay : [before, ...inDay], rowsOf(a.hotWater), rowsOf(a.heating), a.lagMs);
  };
  const showersOf = (from: number, to: number): Ledger["showers"] => {
    let count = 0, litres = 0, gasM3 = 0, cost = 0;
    let cursor: number | undefined;
    for (;;) {
      const page = deps.journal.queryEvents({ category: SHOWER_CATEGORY, sinceMs: from, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
      for (const r of page) {
        if (r.ts * 1000 >= to) return count === 0 ? undefined : { count, litres: Math.round(litres), gasM3: Math.round(gasM3 * 1000) / 1000, cost: Math.round(cost * 100) / 100 };
        const e = r.payload as { tag?: string; litres?: number; gasM3?: number | null; cost?: number | null } | null;
        if (e?.tag !== "ShowerReported") continue;
        count++;
        litres += e.litres ?? 0;
        gasM3 += e.gasM3 ?? 0;
        cost += e.cost ?? 0;
      }
      if (page.length < 1000) break;
      cursor = page.at(-1)!.globalSeq;
    }
    return count === 0 ? undefined : { count, litres: Math.round(litres), gasM3: Math.round(gasM3 * 1000) / 1000, cost: Math.round(cost * 100) / 100 };
  };

  const hoursOf = (key: string, until?: number): number[] => {
    const from = dayStart(key, zone());
    const to = Math.min(dayStart(addDays(key, 1), zone()), until ?? Infinity);
    const out: number[] = [];
    for (let h = from; h < to; h += HOUR) out.push(h);
    return out;
  };

  // ---- closing days ----
  const today = (): string => dayKey(now(), zone());
  /** The first day the statistics hold, bounded by maxBackfillDays. */
  const findFirstDay = async (s: ResolvedSources): Promise<string | undefined> => {
    const ids = quantityIds(s);
    if (ids.length === 0) return undefined;
    const limit = addDays(today(), -(deps.maxBackfillDays ?? 5 * 365));
    const stats = await deps.ha.statisticsDuringPeriod({ statisticIds: ids, startTime: new Date(dayStart(limit, zone())).toISOString(), period: "month", types: ["change"], units: UNITS });
    let first = Infinity;
    for (const rows of Object.values(stats)) for (const r of rows) if (typeof r.change === "number") first = Math.min(first, parseTime(r.start));
    if (!Number.isFinite(first)) return undefined;
    const day = dayKey(first, zone());
    return day < limit ? limit : day;
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let running: Promise<void> | undefined;
  const catchUp = async (): Promise<void> => {
    if (running !== undefined) return running;
    running = (async () => {
      status.running = true;
      try {
        const s = await sources();
        if (!hasSources(s)) return;
        firstDay ??= await findFirstDay(s);
        if (firstDay === undefined) return;
        // Just after midnight HA may not have compiled yesterday's last hour: up to the day before.
        const yesterday = addDays(today(), -1);
        const lastClosable = now() < dayStart(today(), zone()) + CLOSE_AFTER_MS ? addDays(yesterday, -1) : yesterday;
        const pending = daysBetween(firstDay, lastClosable).filter((d) => !closed.has(d));
        status.pendingDays = pending.length;
        status.firstDay = firstDay;
        if (pending.length === 0) return;
        deps.log("info", `energy: closing ${pending.length} day(s) from ${pending[0]} to ${pending.at(-1)}`);
        // A month at a time, newest first: the recent days, with prices in the statistics, come first.
        const months = new Map<string, string[]>();
        for (const d of pending) months.set(d.slice(0, 7), [...(months.get(d.slice(0, 7)) ?? []), d]);
        const means = await monthlyMeans(s);
        for (const days of [...months.values()].reverse()) {
          if (stopped) return;
          await closeDays(s, days, means);
          status.pendingDays = Math.max(0, status.pendingDays - days.length);
          if ((deps.chunkPauseMs ?? 2000) > 0 && months.size > 1) await sleep(deps.chunkPauseMs ?? 2000);
        }
        delete status.error;
      } catch (err) {
        status.error = String(err);
        deps.log("warn", `energy: closing days failed, tried again later (${String(err)})`);
      } finally {
        status.running = false;
        status.closedDays = closed.size;
        const keys = [...closed.keys()].sort();
        if (keys.length > 0) status.lastDay = keys.at(-1)!;
        running = undefined;
      }
    })();
    return running;
  };

  const closeDays = async (s: ResolvedSources, days: string[], means: Map<string, Array<{ start: number; mean: number }>>): Promise<void> => {
    const a = days[0]!;
    const b = days.at(-1)!;
    const from = dayStart(a, zone());
    const to = dayStart(addDays(b, 1), zone());
    const stats = await fetchStats(s, from, to);
    if (file.priceHistory !== undefined) {
      // Electricity: only the hours the statistics have no price for.
      const main = s.imports[0] === undefined ? undefined : entityOf(s.imports[0].price);
      if (main !== undefined) {
        const missing = days.filter((d) => hoursOf(d).some((h) => !stats.mean.get(main)?.has(h) && !known.electricity.has(h)));
        if (missing.length > 0) await recordHistory("electricity", missing[0]!, missing.at(-1)!).catch((err) => deps.log("warn", `energy: electricity price history: ${String(err)}`));
      }
      if (s.gas.length > 0) {
        const missing = days.filter((d) => !known.gasMarket.some((g) => g.start >= dayStart(d, zone()) && g.start < dayStart(addDays(d, 1), zone())));
        if (missing.length > 0) await recordHistory("gas", missing[0]!, missing.at(-1)!).catch((err) => deps.log("warn", `energy: gas price history: ${String(err)}`));
      }
    }
    const adder = await gasAdder(s).catch(() => undefined);
    const events: DayClosed[] = [];
    for (const d of days) {
      const dFrom = dayStart(d, zone());
      const dTo = dayStart(addDays(d, 1), zone());
      const shares = sharesOf(s, dFrom, dTo);
      const showers = showersOf(dFrom, dTo);
      const res = computeDay({
        key: d,
        from: dFrom,
        to: dTo,
        hours: hoursOf(d),
        stats,
        sources: s,
        file,
        known: { ...known, ...(adder !== undefined ? { gasAdder: adder } : {}), fallback: fallbackFor(s, dFrom, means, false) },
        ...(shares !== undefined ? { gasShares: shares } : {}),
        ...(showers !== undefined ? { showers } : {}),
        complete: true,
      });
      const flags = [...res.flags];
      if (s.attribution !== undefined && shares === undefined && res.ledger.gas.m3 > 0 && dTo > now() - 25 * 24 * HOUR) {
        flags.push({ kind: "unattributed", id: s.attribution.gas, at: dFrom, text: `${d}: the gas could not be split (no meter readings or boiler states in the signals)` });
      }
      events.push({ tag: "DayClosed", at: now(), ledger: res.ledger, flags });
    }
    await deps.record(events);
    for (const e of events) fold(e);
  };

  // ---- today, live ----
  let todayCache: { at: number; key: string; ledger: Ledger; rows: HourRow[]; flags: DataFlag[] } | undefined;
  const live = async (): Promise<NonNullable<typeof todayCache>> => {
    const key = today();
    if (todayCache !== undefined && todayCache.key === key && now() - todayCache.at < TODAY_TTL_MS) return todayCache;
    const s = await sources();
    const from = dayStart(key, zone());
    const t = now();
    const hourNow = Math.floor(t / HOUR) * HOUR;
    const stats = await fetchStats(s, from, t);
    // The hour that runs: HA's 5-minute statistics, until its hourly row is compiled.
    const partial = await fetchStats(s, hourNow, t, "5minute").catch(() => emptyStats());
    for (const [id, m] of partial.change) {
      const v = m.get(hourNow);
      if (v === undefined) continue;
      const hm = stats.change.get(id) ?? new Map<number, number>();
      if (!hm.has(hourNow)) hm.set(hourNow, v);
      stats.change.set(id, hm);
    }
    const curve = await priceCurve(s).catch(() => ({ electricity: [] as PricePoint[], gas: [] as PricePoint[] }));
    const electricity = new Map(known.electricity);
    for (const p of curve.electricity) if (p.end - p.start >= HOUR) electricity.set(p.start, p.price);
    const means = await monthlyMeans(s).catch(() => new Map());
    const adder = await gasAdder(s).catch(() => undefined);
    const showers = showersOf(from, t);
    const shares = sharesOf(s, from, t);
    const res = computeDay({
      key,
      from,
      to: dayStart(addDays(key, 1), zone()),
      hours: hoursOf(key, t),
      stats,
      sources: s,
      file,
      known: { ...known, electricity, ...(adder !== undefined ? { gasAdder: adder } : {}), fallback: fallbackFor(s, t, means, true) },
      ...(shares !== undefined ? { gasShares: shares } : {}),
      ...(showers !== undefined ? { showers } : {}),
      complete: false,
    });
    todayCache = { at: now(), key, ledger: res.ledger, rows: res.hours, flags: res.flags };
    return todayCache;
  };

  // ---- the price curve: today and, once published, tomorrow ----
  let curveCache: { at: number; key: string; electricity: PricePoint[]; gas: PricePoint[]; tomorrow: boolean } | undefined;
  const priceCurve = async (s: ResolvedSources): Promise<{ electricity: PricePoint[]; gas: PricePoint[] }> => {
    const key = today();
    if (curveCache !== undefined && curveCache.key === key && (now() - curveCache.at < CURVE_TTL_MS || curveCache.tomorrow)) return curveCache;
    let electricity: PricePoint[] = [];
    let gas: PricePoint[] = [];
    let tomorrow = false;
    if (file.priceHistory !== undefined) {
      const toPoints = (slots: Array<[number, number, number]>): PricePoint[] => slots.map(([start, end, price]) => ({ start, end, price }));
      const next = addDays(key, 1);
      const both = await fetchHistory("electricity", key, next).catch(() => undefined);
      if (both !== undefined && both.length > 0) {
        electricity = toPoints(both);
        tomorrow = both.some(([st]) => st >= dayStart(next, zone()));
      } else {
        electricity = toPoints(await fetchHistory("electricity", key, key).catch(() => []));
      }
      const adder = await gasAdder(s).catch(() => undefined);
      if (adder !== undefined) gas = toPoints((await fetchHistory("gas", key, key).catch(() => [])).map(([a, b, p]) => [a, b, p + adder.value]));
    }
    if (electricity.length === 0) electricity = curveFromAttributes(s);
    curveCache = { at: now(), key, electricity, gas, tomorrow };
    return curveCache;
  };
  /** A price curve some price entities carry in their attributes: `prices` [{start, price}], or Nord Pool's raw_today / raw_tomorrow. */
  const curveFromAttributes = (s: ResolvedSources): PricePoint[] => {
    const id = s.imports[0] === undefined ? undefined : entityOf(s.imports[0].price);
    const attrs = id === undefined ? undefined : deps.state?.(id)?.attributes;
    if (attrs === undefined) return [];
    const out: PricePoint[] = [];
    const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as Array<Record<string, unknown>>) : []);
    const prices = list(attrs["prices"]);
    for (let i = 0; i < prices.length; i++) {
      const start = parseTime(prices[i]!["start"]);
      const price = prices[i]!["price"];
      if (!Number.isFinite(start) || typeof price !== "number") continue;
      const nextStart = parseTime(prices[i + 1]?.["start"]);
      out.push({ start, end: Number.isFinite(nextStart) && nextStart > start ? Math.min(nextStart, start + HOUR) : start + HOUR, price });
    }
    for (const r of [...list(attrs["raw_today"]), ...list(attrs["raw_tomorrow"])]) {
      const start = parseTime(r["start"]);
      const end = parseTime(r["end"]);
      if (Number.isFinite(start) && Number.isFinite(end) && typeof r["value"] === "number") out.push({ start, end, price: r["value"] });
    }
    return out.sort((a, b) => a.start - b.start);
  };

  // ---- the hour rows of the last days, for the projection ----
  let pastRows: { key: string; days: HourRow[][] } | undefined;
  const lastDaysRows = async (s: ResolvedSources): Promise<HourRow[][]> => {
    const key = today();
    if (pastRows?.key === key) return pastRows.days;
    const days = daysBetween(addDays(key, -7), addDays(key, -1));
    const stats = await fetchStats(s, dayStart(days[0]!, zone()), dayStart(key, zone()));
    const out = days.map((d) => computeDay({ key: d, from: dayStart(d, zone()), to: dayStart(addDays(d, 1), zone()), hours: hoursOf(d), stats, sources: s, file, known, complete: true }).hours);
    pastRows = { key, days: out };
    return out;
  };

  const ledgerOf = async (d: string): Promise<Ledger | undefined> => (d === today() ? (await live()).ledger : closed.get(d)?.ledger);

  return {
    async overview() {
      const s = await sources();
      const available = hasSources(s);
      const key = today();
      const t = await live();
      const curve = available ? await priceCurve(s).catch(() => ({ electricity: [], gas: [] })) : { electricity: [], gas: [] };
      const nowT = now();
      const current = curve.electricity.find((p) => p.start <= nowT && nowT < p.end);
      const ahead = curve.electricity.filter((p) => p.end > nowT && p.start < nowT + 24 * HOUR).map((p) => p.price);
      const band = current === undefined ? undefined : priceBand(current.price, ahead);
      let projected: EnergyOverview["projected"];
      try {
        const past = await lastDaysRows(s);
        const hourNow = Math.floor(nowT / HOUR) * HOUR;
        const remaining = hoursOf(key).filter((h) => h > hourNow);
        const waterEntity = s.water[0] === undefined ? undefined : entityOf(s.water[0].price);
        const waterFixed = s.water[0] !== undefined && "fixed" in s.water[0].price ? s.water[0].price.fixed : null;
        const waterNow = waterEntity === undefined ? waterFixed : Number(deps.state?.(waterEntity)?.state);
        projected = projectDay(
          t.ledger,
          t.rows,
          remaining,
          past,
          dayStart(key, zone()),
          (hour) => {
            const p = curve.electricity.find((x) => x.start <= hour && hour < x.end)?.price ?? null;
            const g = curve.gas.find((x) => x.start <= hour && hour < x.end)?.price ?? null;
            return { price: p, exportPrice: null, gasPrice: g };
          },
          waterNow !== null && Number.isFinite(waterNow) ? waterNow : null,
        );
      } catch (err) {
        deps.log("debug", `energy: no projection (${String(err)})`);
      }
      const days = daysBetween(addDays(key, -7), addDays(key, -1))
        .map((d) => closed.get(d)?.ledger)
        .filter((l): l is Ledger => l !== undefined);
      const since = nowT - 30 * 24 * HOUR;
      const flags: DataFlag[] = [];
      // Newest first, one per problem and statistic; the days priced partly from an
      // estimate, and the days whose gas could not be split, as one line each.
      let estimatedDays = 0;
      let unattributedDays = 0;
      const seen = new Set<string>();
      const recent = [...closed.values()].filter((e) => e.ledger.from >= since).sort((a, b) => b.ledger.from - a.ledger.from);
      // Several counters that went back in the same hour (an integration added again) as one line.
      const resets = new Map<number, DataFlag[]>();
      for (const f of [...t.flags, ...recent.flatMap((e) => e.flags)]) if (f.kind === "reset" && f.at !== undefined) resets.set(f.at, [...(resets.get(f.at) ?? []), f]);
      for (const f of [...t.flags, ...recent.flatMap((e) => e.flags)]) {
        const together = f.kind === "reset" && f.at !== undefined ? resets.get(f.at)! : [];
        if (together.length > 2) {
          if (together[0] === f) flags.push({ kind: "reset", at: f.at!, text: `${together.length} counters went back in the same hour (an integration added again?): ${together.map((x) => x.id).join(", ")}; that hour counts 0 for each` });
          continue;
        }
        if (f.kind === "estimated_price" && f.id === undefined) estimatedDays++;
        else if (f.kind === "unattributed") unattributedDays++;
        else if (!seen.has(`${f.kind}|${f.id ?? ""}`)) {
          seen.add(`${f.kind}|${f.id ?? ""}`);
          flags.push(f);
        }
      }
      if (estimatedDays > 0) flags.push({ kind: "estimated_price", at: nowT, text: `${estimatedDays} of the last 30 days priced partly from the nearest known price (no price statistics, no price history for those hours)` });
      if (unattributedDays > 0) flags.push({ kind: "unattributed", at: nowT, text: `${unattributedDays} of the last 30 days: the gas could not be split between hot water and heating (no meter readings or boiler states in the signals)` });
      if (file.priceHistory === undefined && [...closed.values()].some((e) => e.ledger.estimated)) {
        flags.push({ kind: "no_price_history", text: "Some past days have no prices in the statistics and are priced from the nearest month; energy.json's priceHistory fetches real ones" });
      }
      flags.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      return {
        at: nowT,
        timeZone: zone(),
        available,
        sources: sourcesView(s),
        today: t.ledger,
        ...(projected !== undefined ? { projected } : {}),
        days,
        prices: {
          electricity: curve.electricity,
          gas: curve.gas,
          ...(current !== undefined ? { now: current.price } : {}),
          ...(band !== undefined ? { band } : {}),
        },
        flags: flags.slice(0, 50),
        backfill: { ...status, closedDays: closed.size },
      };
    },

    async periods(period, from, to) {
      if (!isDayKey(from) || !isDayKey(to)) throw new Error("from and to must be dates YYYY-MM-DD");
      const last = to > today() ? today() : to;
      const first = periodFirstDay(from, period);
      if (daysBetween(first, last).length > 6 * 366) throw new Error("at most six years at a time");
      const groups = new Map<string, Ledger[]>();
      for (const d of daysBetween(first, last)) {
        const l = await ledgerOf(d);
        if (l === undefined) continue;
        const k = periodKey(d, period);
        groups.set(k, [...(groups.get(k) ?? []), l]);
      }
      const rows = [...groups.entries()].map(([k, parts]) => {
        const day = parts[0]!.key;
        const pFirst = periodFirstDay(day, period);
        return sumLedgers(k, dayStart(pFirst, zone()), dayStart(nextPeriodFirstDay(day, period), zone()), parts);
      });
      return { period, rows };
    },

    async hours(date) {
      if (!isDayKey(date)) throw new Error("date must be YYYY-MM-DD");
      if (date === today()) return { date, hours: (await live()).rows };
      if (date > today()) return { date, hours: [] };
      const s = await sources();
      const from = dayStart(date, zone());
      const to = dayStart(addDays(date, 1), zone());
      const stats = await fetchStats(s, from, to);
      const means = await monthlyMeans(s).catch(() => new Map());
      const adder = await gasAdder(s).catch(() => undefined);
      const res = computeDay({ key: date, from, to, hours: hoursOf(date), stats, sources: s, file, known: { ...known, ...(adder !== undefined ? { gasAdder: adder } : {}), fallback: fallbackFor(s, from, means, false) }, complete: true });
      return { date, hours: res.hours };
    },

    configure(next) {
      file = next;
      prefs = undefined;
      todayCache = undefined;
      curveCache = undefined;
      pastRows = undefined;
      monthly = undefined;
    },

    start() {
      for (const e of readStream(deps.journal, PRICES_ENTITY)) fold(e);
      for (const e of readStream(deps.journal, LEDGER_ENTITY)) fold(e);
      status.closedDays = closed.size;
      const keys = [...closed.keys()].sort();
      if (keys.length > 0) {
        status.firstDay = keys[0]!;
        status.lastDay = keys.at(-1)!;
      }
      deps.log("info", `energy: ${closed.size} closed day(s) in the journal${keys.length > 0 ? ` (${keys[0]} to ${keys.at(-1)})` : ""}`);
      const tick = deps.tickMs ?? 10 * 60_000;
      if (tick > 0) {
        // The first run waits for Home Assistant to be connected and the house's zone known.
        kickoff = setTimeout(() => void catchUp(), 30_000);
        timer = setInterval(() => {
          const y = addDays(today(), -1);
          if ((status.pendingDays > 0 || !closed.has(y)) && now() >= dayStart(today(), zone()) + CLOSE_AFTER_MS) void catchUp();
        }, tick);
      }
    },

    catchUp,

    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      if (kickoff !== undefined) clearTimeout(kickoff);
    },
  };
}
