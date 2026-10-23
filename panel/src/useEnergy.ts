// useEnergy.ts — the Energy tab's data: the overview (on mount, every 5 minutes while
// the tab is in view, and on every SSE reconnect), the periods and a day's hours on demand,
// the heating seasons with each overview.
// A route an older add-on does not serve answers 404: the state says "missing", not an error.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, HttpError } from "./api";
import type { EnergyHours, EnergyOverview, EnergyPeriods, EnergySeasons, Ledger } from "../../src/energy/types";
import { earlierKey, periodRange, yearEarlierRange, type Period } from "./energy";

const OVERVIEW_MS = 5 * 60_000;
/** A reconnect right after a load (the first "hello") needs no second one. */
const FRESH_MS = 15_000;

export type LoadState = "loading" | "ready" | "missing" | "error";

const stateOf = (e: unknown): LoadState => (e instanceof HttpError && e.status === 404 ? "missing" : "error");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface EnergyData {
  /** The last overview that loaded; kept when a refresh fails. */
  overview: EnergyOverview | null;
  state: LoadState;
  /** The last refresh's failure, if it failed. */
  error: string | null;
  loadedAt: number | null;
  reload: () => void;
}

/** GET api/energy: on mount, then every 5 minutes while visible, on becoming visible when stale, and on reconnect. */
export function useEnergy(visible: boolean, connected: boolean): EnergyData {
  const [overview, setOverview] = useState<EnergyOverview | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const loadedRef = useRef(0);

  const reload = useCallback(() => {
    loadedRef.current = Date.now();
    api
      .energy()
      .then((o) => {
        setOverview(o);
        setState("ready");
        setError(null);
        setLoadedAt(Date.now());
      })
      .catch((e) => {
        setState(stateOf(e));
        setError(message(e));
      });
  }, []);

  useEffect(reload, [reload]);

  // While in view (the tab shown and the page not in the background): every 5 minutes,
  // and at once when it comes back into view with an overview older than that.
  const [pageShown, setPageShown] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setPageShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const inView = visible && pageShown;
  useEffect(() => {
    if (!inView) return;
    if (Date.now() - loadedRef.current >= OVERVIEW_MS) reload();
    const t = setInterval(reload, OVERVIEW_MS);
    return () => clearInterval(t);
  }, [inView, reload]);

  // The stream came back: something may have been missed while it was down.
  const prevConnected = useRef(false);
  useEffect(() => {
    if (connected && !prevConnected.current && Date.now() - loadedRef.current > FRESH_MS) reload();
    prevConnected.current = connected;
  }, [connected, reload]);

  return { overview, state, error, loadedAt, reload };
}

export interface PeriodsData {
  rows: Ledger[];
  /** The same periods a year earlier, by the current row's key (none for years). */
  earlier: Map<string, Ledger>;
  state: LoadState;
  error: string | null;
}

/**
 * The chart's periods ending today, and the same periods a year earlier. Loaded when
 * enabled (the tab once in view) and again when `stamp` (the overview's time) moves, so
 * today's bar follows the overview; a year earlier is closed, read once per range.
 */
export function usePeriods(period: Period, today: string | null, enabled: boolean, stamp: number | null): PeriodsData {
  const [data, setData] = useState<{ key: string; rows: Ledger[] } | null>(null);
  const [earlier, setEarlier] = useState<{ key: string; rows: Map<string, Ledger> } | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const earlierCache = useRef(new Map<string, Map<string, Ledger>>());

  useEffect(() => {
    if (!enabled || today === null) return;
    let live = true;
    const key = `${period}:${today}`;
    const r = periodRange(period, today);
    api
      .energyPeriods(period, r.from, r.to)
      .then((p: EnergyPeriods) => {
        if (!live) return;
        setData({ key, rows: p.rows });
        setState("ready");
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setState(stateOf(e));
        setError(message(e));
      });
    const er = yearEarlierRange(period, today);
    const cached = earlierCache.current.get(key);
    if (er === null) setEarlier({ key, rows: new Map() });
    else if (cached !== undefined) setEarlier({ key, rows: cached });
    else
      api
        .energyPeriods(period, er.from, er.to)
        .then((p) => {
          const byKey = new Map(p.rows.map((row) => [row.key, row] as const));
          earlierCache.current.set(key, byKey);
          if (live) setEarlier({ key, rows: byKey });
        })
        .catch(() => {
          // no comparison: the chart shows this year's bars alone
        });
    return () => {
      live = false;
    };
  }, [period, today, enabled, stamp]);

  const key = today === null ? "" : `${period}:${today}`;
  const current = data?.key === key;
  const rows = current ? data.rows : [];
  const ghosts = earlier?.key === key ? earlier.rows : new Map<string, Ledger>();
  // A row's ghost: the earlier row whose key is this row's a year back.
  const matched = new Map<string, Ledger>();
  for (const row of rows) {
    const g = ghosts.get(earlierKey(row.key));
    if (g !== undefined) matched.set(row.key, g);
  }
  // Switching period shows "loading" until its rows come, unless the route failed.
  return { rows, earlier: matched, state: current ? "ready" : state === "ready" ? "loading" : state, error };
}

export interface HoursData {
  hours: EnergyHours | null;
  state: LoadState;
  error: string | null;
}

/** One local date's hours; nothing loads while date is null. */
export function useHours(date: string | null, stamp: number | null): HoursData {
  const [hours, setHours] = useState<EnergyHours | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (date === null) return;
    let live = true;
    setState("loading");
    api
      .energyHours(date)
      .then((h) => {
        if (!live) return;
        setHours(h);
        setState("ready");
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setState(stateOf(e));
        setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [date, stamp]);
  return { hours: hours !== null && hours.date === date ? hours : null, state, error };
}

/** GET api/energy/seasons: once the tab has opened, again with each overview (`stamp`). */
export function useSeasons(enabled: boolean, stamp: number | null): { seasons: EnergySeasons | null; state: LoadState } {
  const [seasons, setSeasons] = useState<EnergySeasons | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .energySeasons()
      .then((s) => {
        if (!live) return;
        setSeasons(s);
        setState("ready");
      })
      .catch((e) => live && setState(stateOf(e)));
    return () => {
      live = false;
    };
  }, [enabled, stamp]);
  return { seasons, state };
}
