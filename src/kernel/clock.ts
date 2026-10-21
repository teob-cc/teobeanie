// clock.ts — pure local-time helpers. decide() gets epoch millis (ctx.now); the house
// lives in a time zone with DST, so wall-clock rules convert explicitly, never via
// the process TZ (the add-on container sets none). The zone is the house's: HA's
// configuration (or the time_zone option), handed to decisions as ctx.house.timeZone.

/**
 * The zone when neither the time_zone option nor HA's configuration names one. UTC,
 * not a guess at where a house is: a wrong zone shows as an obvious offset.
 */
export const FALLBACK_TZ = "UTC";

/** The house's time zone, or the fallback while none is known. */
export const houseZone = (house: { timeZone?: string } | undefined): string => house?.timeZone ?? FALLBACK_TZ;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Minutes since local midnight in the given zone. */
export function localMinutes(at: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h * 60 + m;
}

/** "HH:MM" → minutes since midnight. */
export function parseHhMm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  if (h === undefined || m === undefined || !Number.isFinite(h) || !Number.isFinite(m)) {
    throw new Error(`bad time "${s}", expected HH:MM`);
  }
  return h * 60 + m;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in a zone at an instant: date and time of day. */
function wallClock(at: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let f = wallFormatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    wallFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(at));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour"), mi: n("minute"), s: n("second") };
}

/** The zone's offset from UTC at an instant, in ms (+2 h in a Central European summer). */
function offsetAt(at: number, timeZone: string): number {
  const w = wallClock(at, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant the local clock reads `minutes` past midnight, `days` local days after
 * the local date of `at` (0: that day, -1: the day before). A time a DST change skips
 * lands an hour later; one it repeats, on one of the two.
 */
export function localTimeOn(at: number, days: number, minutes: number, timeZone: string): number {
  const w = wallClock(at, timeZone);
  return localInstant(w.y, w.mo, w.d + days, minutes, timeZone);
}

/** The instant the local clock reads `minutes` past midnight on a local date (month 1-12). */
export function localInstant(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

/** The first instant after `at` at which the local clock reads `minutes` past midnight. */
export function nextLocalTime(at: number, minutes: number, timeZone: string): number {
  const today = localTimeOn(at, 0, minutes, timeZone);
  return today > at ? today : localTimeOn(at, 1, minutes, timeZone);
}

/** Whether the runtime knows this IANA time zone ("America/New_York", "UTC"). */
export function isTimeZone(tz: string | undefined): tz is string {
  if (tz === undefined || tz === "") return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
