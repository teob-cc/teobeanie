// devices.ts — device_id → entity_ids, for matching Node-RED's device-targeted calls
// (the call_service audit carries only device_id for those). Resolved through HA's
// REST template API (device_entities()), cached for the process lifetime: device
// membership only changes on re-pairing.

export interface DeviceResolver {
  entitiesOf(deviceIds: string[]): Promise<Record<string, string[]>>;
}

/** ws://host/api/websocket → http://host/api ; ws://supervisor/core/websocket → http://supervisor/core/api */
export function restBaseFromWs(wsUrl: string): string {
  const http = wsUrl.replace(/^ws(s?):/, "http$1:");
  return http.replace(/\/websocket$/, "").replace(/\/core$/, "/core/api");
}

const DEVICE_ID = /^[0-9a-f]{32}$/;

export function createDeviceResolver(opts: { wsUrl: string; token: string; fetchImpl?: typeof fetch }): DeviceResolver {
  const base = restBaseFromWs(opts.wsUrl);
  const f = opts.fetchImpl ?? fetch;
  const cache = new Map<string, string[]>();

  return {
    async entitiesOf(deviceIds) {
      const wanted = [...new Set(deviceIds)].filter((d) => DEVICE_ID.test(d));
      const missing = wanted.filter((d) => !cache.has(d));
      if (missing.length > 0) {
        // Ids are validated hex, so interpolating them into the template is safe.
        const template = `{{ { ${missing.map((d) => `'${d}': device_entities('${d}')`).join(", ")} } | tojson }}`;
        const res = await f(`${base}/template`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
          body: JSON.stringify({ template }),
        });
        if (!res.ok) throw new Error(`HA template API ${res.status}`);
        const map = JSON.parse(await res.text()) as Record<string, string[]>;
        for (const d of missing) cache.set(d, map[d] ?? []);
      }
      return Object.fromEntries(wanted.map((d) => [d, cache.get(d) ?? []]));
    },
  };
}
