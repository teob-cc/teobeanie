import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { EnergyToday, HouseFrame, HouseView } from "../../src/house/view";
import type { SseFrame } from "./useSse";

const RELAYOUT_MS = 10 * 60_000; // areas and devices change rarely: re-read the layout now and then
const ENERGY_MS = 5 * 60_000;

/**
 * The House view: GET api/house once (and on every SSE reconnect, which reconciles
 * anything missed, and after a config reload), then "house" frames patch the entities'
 * states in place and replace the instances' cards when they changed.
 */
export function useHouse(
  subscribe: (fn: (f: SseFrame) => void) => () => void,
  connected: boolean,
): { view: HouseView | null; error: string | null; reload: () => void; lastFrameAt: number | null } {
  const [view, setView] = useState<HouseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);

  const reload = useCallback(() => {
    api
      .house()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, RELAYOUT_MS);
    return () => clearInterval(t);
  }, [reload]);

  const prevConnected = useRef(false);
  useEffect(() => {
    if (connected && !prevConnected.current) reload();
    prevConnected.current = connected;
  }, [connected, reload]);

  useEffect(
    () =>
      subscribe((f) => {
        // A config reload may have changed the scope, the tiles or the groups.
        if (f.type === "reload" && f.ok === true) reload();
        if (f.type !== "house") return;
        const frame = f as unknown as HouseFrame;
        setLastFrameAt(frame.at);
        setView((prev) => {
          if (prev === null) return prev;
          // The cards come whole, when any changed.
          const cards = frame.cards ?? prev.cards;
          let entities: HouseView["entities"] | undefined;
          for (const [id, s] of Object.entries(frame.states)) {
            const e = prev.entities[id];
            if (e === undefined) continue; // not in the layout (yet): the next reload places it
            entities ??= { ...prev.entities };
            entities[id] = { ...e, ...s };
          }
          if (entities === undefined && cards === prev.cards) return prev;
          return { ...prev, cards, ...(entities !== undefined ? { entities } : {}) };
        });
      }),
    [subscribe, reload],
  );

  return { view, error, reload, lastFrameAt };
}

/** Today's energy totals, refreshed every few minutes; null until known or when HA has none. */
export function useEnergyToday(enabled: boolean): EnergyToday | null {
  const [today, setToday] = useState<EnergyToday | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      api
        .energyToday()
        .then((t) => live && setToday(t))
        .catch(() => {
          // recorder unavailable: the energy section shows live power only
        });
    load();
    const t = setInterval(load, ENERGY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [enabled]);
  return today;
}

/** Current time, re-rendered every intervalMs (for "changed 12s ago"). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
