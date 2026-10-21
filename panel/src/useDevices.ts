import { useEffect, useState } from "react";
import { api, type JournalRow } from "./api";
import { deviceIdsOf } from "./decisions";

// Device membership only changes on re-pairing: one cache per page load.
const known: Record<string, string[]> = {};

/** device_id → entity_ids for every device an audited call targeted in these rows. */
export function useDeviceEntities(rows: Iterable<JournalRow>): Record<string, string[]> {
  const [map, setMap] = useState<Record<string, string[]>>(known);
  useEffect(() => {
    const missing = new Set<string>();
    for (const r of rows) {
      if (r.manifest !== "HaCallServiceObserved") continue;
      for (const d of deviceIdsOf(r.payload)) if (!(d in known)) missing.add(d);
    }
    if (missing.size === 0) return;
    api
      .deviceEntities([...missing])
      .then((res) => {
        Object.assign(known, res.devices);
        setMap({ ...known });
      })
      .catch(() => {
        // template API unavailable — device-targeted calls stay unmatched
      });
  }, [rows]);
  return map;
}
