// calendar.ts — local days, ISO weeks, months and years in the house's time zone, as
// the ledger keys them ("2026-10-23", "2026-W43", "2026-10", "2026"). A day is the span
// between two local midnights, so a DST day has 23 or 25 hours. Pure.

import { localInstant } from "../kernel/clock.js";

export type Period = "day" | "week" | "month" | "year";

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** The local date at an instant, "YYYY-MM-DD". */
export function dayKey(at: number, timeZone: string): string {
  let f = dateFormatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, f);
  }
  return f.format(new Date(at));
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY.exec(s);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

function parts(key: string): [number, number, number] {
  const m = DAY.exec(key);
  if (m === null) throw new Error(`bad date "${key}", expected YYYY-MM-DD`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Local midnight at the start of a day. */
export function dayStart(key: string, timeZone: string): number {
  const [y, mo, d] = parts(key);
  return localInstant(y, mo, d, 0, timeZone);
}

/** The day `n` days after (or before) a day. */
export function addDays(key: string, n: number): string {
  const [y, mo, d] = parts(key);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** Days from a to b, both included; empty when b is before a. */
export function daysBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let k = a; k <= b; k = addDays(k, 1)) out.push(k);
  return out;
}

/** The ISO week a day falls in, "YYYY-Www" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function weekKey(key: string): string {
  const [y, mo, d] = parts(key);
  const t = new Date(Date.UTC(y, mo - 1, d));
  const dow = (t.getUTCDay() + 6) % 7; // Monday 0
  t.setUTCDate(t.getUTCDate() - dow + 3); // the Thursday of this week
  const year = t.getUTCFullYear();
  const week = 1 + Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / 864e5 / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The key of the period a day falls in. */
export function periodKey(key: string, period: Period): string {
  switch (period) {
    case "day":
      return key;
    case "week":
      return weekKey(key);
    case "month":
      return key.slice(0, 7);
    case "year":
      return key.slice(0, 4);
  }
}

/** The first day of the period a day falls in. */
export function periodFirstDay(key: string, period: Period): string {
  switch (period) {
    case "day":
      return key;
    case "week": {
      const [y, mo, d] = parts(key);
      const dow = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
      return addDays(key, -dow);
    }
    case "month":
      return `${key.slice(0, 7)}-01`;
    case "year":
      return `${key.slice(0, 4)}-01-01`;
  }
}

/** The first day of the next period. */
export function nextPeriodFirstDay(key: string, period: Period): string {
  const first = periodFirstDay(key, period);
  const [y, mo] = parts(first);
  switch (period) {
    case "day":
      return addDays(first, 1);
    case "week":
      return addDays(first, 7);
    case "month":
      return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
    case "year":
      return `${y + 1}-01-01`;
  }
}

/** Days in a year (365 or 366), for spreading a yearly amount over its days. */
export function daysInYear(key: string): number {
  const y = Number(key.slice(0, 4));
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}
