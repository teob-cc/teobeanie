// daily.ts — the daily summary in the household chat: yesterday's energy from the ledger's
// closed day (the euros, each carrier, the split of the gas, showers, the biggest devices,
// the degree days, the heat pump route and what was wrong with the data), then what needs
// a look now: alarms on, doors and windows left open, low batteries, sensors not
// reporting, the instances' cards with a bad field (a device health check), Teobeanie's
// own open problems and a pause that holds. Pure: the monitor gathers the parts at the
// summary time and posts the text.

import { addDays, dayKey, dayStart } from "./energy/calendar.js";
import type { EnergyOverview, Ledger } from "./energy/types.js";
import { attention, num } from "./house/summary.js";
import type { HouseEntity, HouseView } from "./house/view.js";

export interface DailyParts {
  /** When it is posted, ms epoch. */
  at: number;
  timeZone: string;
  /** The energy ledger's overview; an Error when it could not be read; absent without a ledger. */
  energy?: EnergyOverview | Error;
  /** The house view (the scope's states, the instances' cards); an Error when it could not be read. */
  house?: HouseView | Error;
  /** Teobeanie's own problems still open, as they were posted. */
  problems: string[];
  /** The pause, when it holds at `at`. */
  pause?: { since?: number; by?: string };
}

/** Names listed per line; the rest are counted. */
const MAX_LISTED = 8;
/** Devices named under "most used". */
const TOP_DEVICES = 3;
/** Data problems named for the day. */
const MAX_FLAGS = 3;

const eur = (v: number): string => `${v < 0 ? "−" : ""}€${Math.abs(v).toFixed(2)}`;
const kwh = (v: number): string => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} kWh`;
const m3 = (v: number): string => `${v.toFixed(2)} m³`;

function list(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

/** "Sun 25 Oct", house time. */
const dayLabel = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(at));

/** "14:02" today, "Sat 14:02" within the week, "12 Oct" before. */
function since(at: number, now: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return time;
  if (now - at < 6 * 24 * 3_600_000) return `${new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(new Date(at))} ${time}`;
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(new Date(at));
}

// ---- energy -------------------------------------------------------------------

function energyLines(o: EnergyOverview, at: number, timeZone: string): string[] {
  if (!o.available) return [];
  const today = dayKey(at, timeZone);
  const yesterday = addDays(today, -1);
  const label = dayLabel(dayStart(yesterday, timeZone), timeZone);
  const d = o.days.find((x) => x.key === yesterday);
  if (d === undefined) return [`Energy ${label}: not closed yet${o.backfill.running ? " (the ledger is closing days)" : ""}`];

  const before = o.days.filter((x) => x.key < yesterday);
  const average = before.length > 0 ? before.reduce((a, x) => a + x.total, 0) / before.length : undefined;
  const lines = [`Energy ${label}: ${eur(d.total)}${average !== undefined ? ` (${eur(average)} a day the ${before.length} days before)` : ""}`];

  const e = d.electricity;
  if (e.importKwh + e.exportKwh + d.solar.kWh > 0) {
    const parts = [`${kwh(e.importKwh)} in`, ...(e.exportKwh > 0 ? [`${kwh(e.exportKwh)} out`] : []), ...(d.solar.kWh > 0 ? [`solar ${kwh(d.solar.kWh)}`] : [])];
    lines.push(`- Electricity: ${parts.join(", ")}: ${eur(e.importCost - e.exportCredit)}`);
  }
  if (d.gas.m3 > 0) {
    const split = d.gas.heatingM3 !== undefined && d.gas.hotWaterM3 !== undefined ? ` (heating ${m3(d.gas.heatingM3)}, hot water ${m3(d.gas.hotWaterM3)})` : "";
    lines.push(`- Gas: ${m3(d.gas.m3)}${split}: ${eur(d.gas.cost)}`);
  }
  if (d.water.m3 > 0) lines.push(`- Water: ${Math.round(d.water.m3 * 1000)} L: ${eur(d.water.cost)}`);
  if (d.fixed !== 0) lines.push(`- Fixed charges: ${eur(d.fixed)}`);
  if (d.showers !== undefined && d.showers.count > 0) {
    lines.push(`- Showers: ${d.showers.count}, ${Math.round(d.showers.litres)} L: ${eur(d.showers.cost)}`);
  }
  const top = [...d.devices].filter((x) => x.kWh > 0).sort((a, b) => b.kWh - a.kWh).slice(0, TOP_DEVICES);
  if (top.length > 0) lines.push(`- Most used: ${top.map((x) => `${x.name} ${kwh(x.kWh)} (${eur(x.cost)})`).join(", ")}`);
  if (d.degreeDays !== undefined && d.degreeDays > 0) {
    lines.push(`- Heating: ${d.degreeDays.toFixed(1)} degree days, ${eur(d.total / d.degreeDays)} per degree day`);
  }
  if (d.heat !== undefined && d.heat.gasCost > 0) {
    const h = d.heat;
    lines.push(`- A heat pump instead of gas: ${eur(h.heatPumpCost)} against ${eur(h.gasCost + h.gasFixed)}, ${h.saving >= 0 ? `${eur(h.saving)} less` : `${eur(-h.saving)} more`}`);
  }
  lines.push(...dataLines(o, d, yesterday, timeZone));
  return lines;
}

/** What was wrong with the day's data: the flags in its hours, and estimated prices. */
function dataLines(o: EnergyOverview, d: Ledger, day: string, timeZone: string): string[] {
  const from = dayStart(day, timeZone);
  const to = dayStart(addDays(day, 1), timeZone);
  const texts = o.flags.filter((f) => f.at !== undefined && f.at >= from && f.at < to).map((f) => f.text);
  if (d.estimated) texts.push("some hours priced from an estimate (no price known for them)");
  const shown = texts.slice(0, MAX_FLAGS).map((t) => `- Data: ${t}`);
  if (texts.length > MAX_FLAGS) shown.push(`- Data: ${texts.length - MAX_FLAGS} more, on the Energy tab`);
  return shown;
}

// ---- what needs a look ----------------------------------------------------------

function attentionLines(house: HouseView, at: number, timeZone: string): string[] {
  const a = attention(Object.values(house.entities));
  const lines: string[] = [];
  if (a.alerts.length > 0) lines.push(`- Alarm: ${list(a.alerts.map((e) => `${e.name} since ${since(e.changedAt, at, timeZone)}`))}`);
  if (a.open.length > 0) lines.push(`- Open: ${list(a.open.map((e) => `${e.name} since ${since(e.changedAt, at, timeZone)}`))}`);
  if (a.lowBatteries.length > 0) lines.push(`- Low batteries: ${list(a.lowBatteries.map(battery))}`);
  if (a.unavailable.length > 0) {
    const quiet = [...a.unavailable].sort((x, y) => x.changedAt - y.changedAt);
    lines.push(`- Not reporting: ${list(quiet.map((e) => `${e.name} since ${since(e.changedAt, at, timeZone)}`))}`);
  }
  for (const c of [...house.cards].sort((x, y) => x.key.localeCompare(y.key))) {
    const bad = c.card?.fields.filter((f) => f.tone === "bad") ?? [];
    if (bad.length > 0) lines.push(`- ${c.card!.title}: ${bad.map((f) => `${f.label} ${String(f.value)}${f.unit !== undefined ? ` ${f.unit}` : ""}`).join(", ")}`);
  }
  return lines;
}

const battery = (e: HouseEntity): string => {
  const v = e.domain === "sensor" ? num(e) : null;
  return v === null ? e.name : `${e.name} ${Math.round(v)} %`;
};

// ---- the message ----------------------------------------------------------------

export function dailySummary(p: DailyParts): string {
  const lines = [`Teobeanie, ${dayLabel(p.at, p.timeZone)}`];

  if (p.energy instanceof Error) lines.push(`Energy: the ledger could not be read (${p.energy.message})`);
  else if (p.energy !== undefined) lines.push(...energyLines(p.energy, p.at, p.timeZone));

  const needs: string[] = [];
  if (p.house instanceof Error) needs.push(`- The house could not be read (${p.house.message})`);
  else if (p.house !== undefined) needs.push(...attentionLines(p.house, p.at, p.timeZone));
  needs.push(...p.problems.map((t) => `- ${t.replace(/^Teobeanie: /, "")}`));
  if (p.pause !== undefined) {
    const when = p.pause.since !== undefined ? ` since ${since(p.pause.since, p.at, p.timeZone)}` : "";
    needs.push(`- All heuristics paused${when}${p.pause.by !== undefined ? ` by ${p.pause.by}` : ""}: only guards act`);
  }
  lines.push("");
  if (needs.length === 0) lines.push("Nothing needs attention.");
  else lines.push("Needs attention:", ...needs);
  return lines.join("\n");
}
