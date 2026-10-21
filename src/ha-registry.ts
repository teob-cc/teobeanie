// ha-registry.ts — Home Assistant's area, device and entity registries, and which
// entities are exposed to Assist, as the MCP explore tools read them (mcp/ha-tools.ts).
// Read over the websocket and cached; the cache is stale after a registry event, after
// a reconnect, and after 10 minutes. Read-only: it only lists.

import type { HaClient } from "@lambda-house/teob-ts/ha";

export interface RegArea {
  id: string;
  name: string;
  floor?: string;
}

export interface RegDevice {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  areaId?: string;
}

export interface RegEntity {
  id: string;
  /** The name the registry gives (the user's), else the integration's. */
  name?: string;
  platform?: string;
  deviceId?: string;
  areaId?: string;
  disabled: boolean;
  hidden: boolean;
  /** "config" or "diagnostic". */
  category?: string;
}

export interface HaRegistry {
  at: number;
  /** All three registries were read. */
  ok: boolean;
  areas: Map<string, RegArea>;
  devices: Map<string, RegDevice>;
  entities: Map<string, RegEntity>;
  /** Entity ids exposed to Assist; undefined when HA did not say. */
  exposed?: Set<string>;
}

export interface HaRegistryReader {
  get(): Promise<HaRegistry>;
  /** An entity's area: its own, else its device's (an area id HA no longer knows counts as none). */
  areaOf(reg: HaRegistry, entityId: string): { area: RegArea; from: "entity" | "device" } | undefined;
  stop(): void;
}

/** HA events after which the cached registries are stale. */
export const REGISTRY_EVENTS = ["area_registry_updated", "device_registry_updated", "entity_registry_updated"];
const TTL_MS = 10 * 60_000;

interface RawEntity {
  entity_id: string;
  name?: string | null;
  original_name?: string | null;
  platform?: string;
  device_id?: string | null;
  area_id?: string | null;
  disabled_by?: string | null;
  hidden_by?: string | null;
  entity_category?: string | null;
}
interface RawDevice {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  area_id?: string | null;
}
interface RawArea {
  area_id: string;
  name: string;
  floor_id?: string | null;
}

export function createHaRegistry(deps: {
  ha: Pick<HaClient, "send"> & Partial<Pick<HaClient, "onConnectionChange" | "onEvent">>;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
}): HaRegistryReader {
  const now = deps.now ?? Date.now;
  let cached: HaRegistry | undefined;
  let loading: Promise<HaRegistry> | undefined;
  let stale = false;

  const load = async (): Promise<HaRegistry> => {
    const reg: HaRegistry = { at: now(), ok: false, areas: new Map(), devices: new Map(), entities: new Map() };
    try {
      const [entities, devices, areas] = await Promise.all([
        deps.ha.send<RawEntity[]>({ type: "config/entity_registry/list" }),
        deps.ha.send<RawDevice[]>({ type: "config/device_registry/list" }),
        deps.ha.send<RawArea[]>({ type: "config/area_registry/list" }),
      ]);
      for (const a of areas) reg.areas.set(a.area_id, { id: a.area_id, name: a.name, ...(a.floor_id ? { floor: a.floor_id } : {}) });
      for (const d of devices) {
        reg.devices.set(d.id, {
          id: d.id,
          name: d.name_by_user ?? d.name ?? d.id,
          ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
          ...(d.model ? { model: d.model } : {}),
          ...(d.area_id ? { areaId: d.area_id } : {}),
        });
      }
      for (const e of entities) {
        const name = e.name ?? e.original_name;
        reg.entities.set(e.entity_id, {
          id: e.entity_id,
          ...(name ? { name } : {}),
          ...(e.platform ? { platform: e.platform } : {}),
          ...(e.device_id ? { deviceId: e.device_id } : {}),
          ...(e.area_id ? { areaId: e.area_id } : {}),
          disabled: e.disabled_by !== undefined && e.disabled_by !== null,
          hidden: e.hidden_by !== undefined && e.hidden_by !== null,
          ...(e.entity_category ? { category: e.entity_category } : {}),
        });
      }
      reg.ok = true;
    } catch (err) {
      deps.log("warn", `registries unavailable (${String(err)})`);
    }
    try {
      const x = await deps.ha.send<{ exposed_entities?: Record<string, { conversation?: boolean }> }>({ type: "homeassistant/expose_entity/list" });
      reg.exposed = new Set(Object.entries(x.exposed_entities ?? {}).filter(([, v]) => v.conversation === true).map(([id]) => id));
    } catch (err) {
      deps.log("debug", `which entities are exposed to Assist is unknown (${String(err)})`);
    }
    return reg;
  };

  const markStale = (): void => {
    stale = true;
  };
  let wasConnected = true;
  const offs = [
    deps.ha.onConnectionChange?.((connected) => {
      if (connected && !wasConnected) markStale();
      wasConnected = connected;
    }),
    ...REGISTRY_EVENTS.map((type) => deps.ha.onEvent?.(type, markStale)),
  ];

  return {
    async get() {
      // A failed read is retried after a minute, not on every call.
      if (cached !== undefined && !stale && now() - cached.at < (cached.ok ? TTL_MS : 60_000)) return cached;
      if (loading === undefined) {
        stale = false;
        loading = load().finally(() => (loading = undefined));
      }
      cached = await loading;
      return cached;
    },
    areaOf(reg, entityId) {
      const e = reg.entities.get(entityId);
      const own = e?.areaId === undefined ? undefined : reg.areas.get(e.areaId);
      if (own !== undefined) return { area: own, from: "entity" };
      const dev = e?.deviceId === undefined ? undefined : reg.devices.get(e.deviceId);
      const fromDevice = dev?.areaId === undefined ? undefined : reg.areas.get(dev.areaId);
      return fromDevice === undefined ? undefined : { area: fromDevice, from: "device" };
    },
    stop() {
      for (const off of offs) off?.();
    },
  };
}
