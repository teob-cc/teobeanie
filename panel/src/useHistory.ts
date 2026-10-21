import { useEffect, useState } from "react";
import { api, type SignalPoint } from "./api";

/**
 * Recorded values of these entities since `since` (ascending), refetched whenever
 * `refresh` changes. Entities whose fetch fails are simply absent.
 */
export function useSignalHistory(entityIds: string[], since: number, refresh: unknown): Record<string, SignalPoint[]> {
  const [history, setHistory] = useState<Record<string, SignalPoint[]>>({});
  const key = [...entityIds].sort().join(",");
  useEffect(() => {
    if (key === "") return;
    let live = true;
    void Promise.all(
      key.split(",").map((e) =>
        api
          .signals(e, since)
          .then((r) => [e, [...r.rows].sort((a, b) => a.at - b.at)] as const)
          .catch(() => undefined),
      ),
    ).then((pairs) => {
      if (live) setHistory(Object.fromEntries(pairs.filter((p) => p !== undefined)));
    });
    return () => {
      live = false;
    };
  }, [key, since, refresh]);
  return history;
}
