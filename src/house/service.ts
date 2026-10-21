// service.ts — serves the House view: the layout over the bridge's live cache (areas
// and devices from HA's registries), today's energy totals from the recorder, and the
// "house" SSE frames that keep the panel live (states, and the instances' cards). Read-only towards Home Assistant: the
// only messages it sends are registry lists, energy/get_prefs and statistics, plus a
// subscription to the registries' update events (cached registries reload after one,
// after a reconnect, else every 10 minutes).

import type { HaClient, HaEntityState } from "@lambda-house/teob-ts/ha";
import { houseZone, localMinutes } from "../kernel/clock.js";
import { buildLayout, type EnergyHints, type EntityFacts, type GroupsConfig } from "./layout.js";
import { liveState, type EnergyToday, type HouseFrame, type HouseView, type InstanceCard, type LiveState, type TileSpecView } from "./view.js";

export type { EnergyToday };

export interface HouseService {
  view(): Promise<HouseView>;
  energyToday(): Promise<EnergyToday>;
  /** A config reload: the scope, tiles.json's groups and tiles, the outdoor sources. */
  configure(next: HouseConfig): void;
  /** An instance's card may have changed: the next frame carries the cards if any did. */
  cardsChanged(): void;
  stop(): void;
}

export type HouseConfig = Pick<HouseServiceDeps, "observes" | "groups" | "tiles" | "outdoor">;

export interface HouseServiceDeps {
  /** onConnectionChange / onEvent, when given, refresh the registries after a reconnect or a registry change. */
  ha: Pick<HaClient, "send" | "onStateChanged" | "statisticsDuringPeriod"> & Partial<Pick<HaClient, "onConnectionChange" | "onEvent">>;
  /** The bridge's live cache: every entity HA has. */
  live: () => ReadonlyMap<string, HaEntityState>;
  /** allowlist.json scope; undefined shows everything (minus HA's hidden and diagnostic entities). */
  observes?: (entityId: string) => boolean;
  groups: GroupsConfig;
  tiles: TileSpecView[];
  outdoor?: HouseView["outdoor"];
  /** The house's time zone (HA's configuration), read when used: "today" starts at its midnight. Default UTC. */
  timeZone?: () => string | undefined;
  /** The instances' cards as they stand now (host.cards()). */
  cards?: () => InstanceCard[];
  /** Publish a frame to the SSE bus, and whether anyone listens. */
  publish: (frame: HouseFrame) => void;
  listening: () => boolean;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  /** Frame coalescing window. Default 1000 ms. */
  frameMs?: number;
  now?: () => number;
}

interface Registry {
  at: number;
  ok: boolean;
  /** entity id → area name / device id; device id → name / area name. */
  entities: Map<string, { deviceId?: string; areaId?: string; hidden: boolean; category: boolean }>;
  devices: Map<string, { name: string; areaId?: string }>;
  areas: Map<string, string>;
  hints: EnergyHints;
  /** energy/get_prefs statistic ids per kind. */
  energy: Record<EnergyToday["totals"][number]["kind"], string[]>;
}

const REGISTRY_TTL_MS = 10 * 60_000;
/** HA events after which the cached registries are stale (areas renamed, devices moved, entities assigned). */
const REGISTRY_EVENTS = ["area_registry_updated", "device_registry_updated", "entity_registry_updated"];
const ENERGY_TTL_MS = 5 * 60_000;
const SKIP_DOMAINS = new Set(["zone", "update", "tts", "stt", "conversation", "wake_word", "assist_satellite", "event", "todo", "ai_task", "image"]);

interface DisplayEntity {
  ei: string;
  di?: string;
  ai?: string;
  hb?: boolean;
  ec?: number;
}
interface Device {
  id: string;
  name: string | null;
  name_by_user: string | null;
  area_id: string | null;
}
interface EnergySource {
  type: string;
  stat_energy_from?: string;
  stat_energy_to?: string | null;
  flow_from?: Array<{ stat_energy_from?: string }>;
  flow_to?: Array<{ stat_energy_to?: string }>;
}

export function createHouseService(deps: HouseServiceDeps): HouseService {
  const now = deps.now ?? Date.now;
  let cfg: HouseConfig = deps;
  const inView = (id: string, reg: Registry | undefined): boolean => {
    if (cfg.observes !== undefined) return cfg.observes(id);
    if (SKIP_DOMAINS.has(id.slice(0, id.indexOf(".")))) return false;
    const r = reg?.entities.get(id);
    return r === undefined || (!r.hidden && !r.category);
  };

  // ---- registries (areas, devices, energy prefs), refreshed lazily ----
  let registry: Registry | undefined;
  let loading: Promise<Registry> | undefined;
  const loadRegistry = async (): Promise<Registry> => {
    const reg: Registry = { at: now(), ok: false, entities: new Map(), devices: new Map(), areas: new Map(), hints: {}, energy: { grid_import: [], grid_export: [], solar: [], gas: [], water: [] } };
    try {
      const [display, devices, areas] = await Promise.all([
        deps.ha.send<{ entities: DisplayEntity[] }>({ type: "config/entity_registry/list_for_display" }),
        deps.ha.send<Device[]>({ type: "config/device_registry/list" }),
        deps.ha.send<Array<{ area_id: string; name: string }>>({ type: "config/area_registry/list" }),
      ]);
      for (const a of areas) reg.areas.set(a.area_id, a.name);
      for (const d of devices) reg.devices.set(d.id, { name: d.name_by_user ?? d.name ?? d.id, ...(d.area_id ? { areaId: d.area_id } : {}) });
      for (const e of display.entities) {
        reg.entities.set(e.ei, { ...(e.di ? { deviceId: e.di } : {}), ...(e.ai ? { areaId: e.ai } : {}), hidden: e.hb === true, category: e.ec !== undefined && e.ec !== null });
      }
      reg.ok = true;
    } catch (err) {
      deps.log("warn", `house view: registries unavailable, grouping without areas and devices (${String(err)})`);
    }
    try {
      const prefs = await deps.ha.send<{ energy_sources?: EnergySource[] }>({ type: "energy/get_prefs" });
      const grid = new Set<string>();
      const solar = new Set<string>();
      const device = (id: string | null | undefined): string | undefined => (id ? reg.entities.get(id)?.deviceId : undefined);
      for (const s of prefs.energy_sources ?? []) {
        const from = [s.stat_energy_from, ...(s.flow_from ?? []).map((f) => f.stat_energy_from)].filter((x): x is string => typeof x === "string");
        const to = [s.stat_energy_to, ...(s.flow_to ?? []).map((f) => f.stat_energy_to)].filter((x): x is string => typeof x === "string");
        if (s.type === "grid") {
          reg.energy.grid_import.push(...from);
          reg.energy.grid_export.push(...to);
          for (const id of [...from, ...to]) if (device(id)) grid.add(device(id)!);
        } else if (s.type === "solar") {
          reg.energy.solar.push(...from);
          for (const id of from) if (device(id)) solar.add(device(id)!);
        } else if (s.type === "gas" || s.type === "water") {
          reg.energy[s.type].push(...from);
        }
      }
      reg.hints = { gridDevices: grid, solarDevices: solar };
    } catch (err) {
      deps.log("debug", `house view: no energy preferences (${String(err)})`);
    }
    return reg;
  };
  let stale = false;
  const getRegistry = async (): Promise<Registry> => {
    // A failed load is retried after a minute, not on every request.
    if (registry !== undefined && !stale && now() - registry.at < (registry.ok ? REGISTRY_TTL_MS : 60_000)) return registry;
    if (loading === undefined) {
      stale = false;
      loading = loadRegistry().finally(() => (loading = undefined));
    }
    const reg = await loading;
    registry = reg;
    return reg;
  };
  // The next view reloads the registries after a reconnect (HA may have restarted with
  // other areas) and after any registry change. The cache stays usable meanwhile.
  const markStale = (): void => {
    stale = true;
  };
  let wasConnected = true;
  const unsubscribeRegistry = [
    deps.ha.onConnectionChange?.((connected) => {
      if (connected && !wasConnected) markStale();
      wasConnected = connected;
    }),
    ...REGISTRY_EVENTS.map((type) => deps.ha.onEvent?.(type, markStale)),
  ];

  const view = async (): Promise<HouseView> => {
    const reg = await getRegistry();
    const facts: EntityFacts[] = [];
    const states = new Map<string, LiveState>();
    for (const [id, s] of deps.live()) {
      if (!inView(id, reg)) continue;
      const r = reg.entities.get(id);
      const dev = r?.deviceId === undefined ? undefined : reg.devices.get(r.deviceId);
      // The entity's own area, else its device's (an area id HA no longer knows counts as none).
      const own = r?.areaId === undefined ? undefined : reg.areas.get(r.areaId);
      const fromDevice = own !== undefined || dev?.areaId === undefined ? undefined : reg.areas.get(dev.areaId);
      facts.push({
        id,
        state: s.state,
        attributes: s.attributes,
        ...(own !== undefined ? { area: own, areaFrom: "entity" as const } : fromDevice !== undefined ? { area: fromDevice, areaFrom: "device" as const } : {}),
        ...(dev !== undefined ? { device: dev.name, deviceId: r!.deviceId! } : {}),
      });
      states.set(id, liveState(s));
    }
    const { groups, tiles, outdoor, observes } = cfg;
    const layout = buildLayout(facts, { groups, hints: reg.hints, tiles });
    const entities: HouseView["entities"] = {};
    for (const [id, e] of Object.entries(layout.entities)) entities[id] = { ...e, ...states.get(id)! };
    // Tile entities are always present (a tile may show an entity no section shows).
    for (const t of tiles) {
      const s = states.get(t.entityId);
      if (!(t.entityId in entities) && s !== undefined) entities[t.entityId] = { id: t.entityId, name: t.label, domain: t.entityId.split(".")[0]!, section: "", group: "", ...s };
    }
    return {
      at: now(),
      scoped: observes !== undefined,
      registry: reg.ok,
      ...(outdoor !== undefined ? { outdoor } : {}),
      sections: layout.sections,
      pinned: layout.pinned,
      tiles,
      entities,
      cards: deps.cards?.() ?? [],
    };
  };

  // ---- today's energy, from the recorder's hourly statistics ----
  let today: EnergyToday | undefined;
  const energyToday = async (): Promise<EnergyToday> => {
    const t = now();
    const since = Math.floor(t / 60_000) * 60_000 - localMinutes(t, houseZone({ timeZone: deps.timeZone?.() })) * 60_000;
    if (today !== undefined && today.since === since && t - today.at < ENERGY_TTL_MS) return today;
    const reg = await getRegistry();
    const kinds = Object.entries(reg.energy)
      .map(([kind, ids]) => [kind as EnergyToday["totals"][number]["kind"], ids.filter((id) => inView(id, reg))] as const)
      .filter(([, ids]) => ids.length > 0);
    const ids = [...new Set(kinds.flatMap(([, ids]) => ids))];
    const totals: EnergyToday["totals"] = [];
    if (ids.length > 0) {
      const stats = await deps.ha.statisticsDuringPeriod({
        statisticIds: ids,
        startTime: new Date(since).toISOString(),
        period: "hour",
        types: ["change"],
        units: { energy: "kWh", volume: "m³" },
      });
      const change = (id: string): number => (stats[id] ?? []).reduce((sum, v) => sum + (typeof v.change === "number" ? v.change : 0), 0);
      for (const [kind, of] of kinds) {
        totals.push({ kind, value: of.reduce((sum, id) => sum + change(id), 0), unit: kind === "gas" || kind === "water" ? "m³" : "kWh" });
      }
    }
    today = { at: t, since, totals };
    return today;
  };

  // ---- live frames: changed states and cards, coalesced ----
  const pending = new Map<string, LiveState>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The cards as the last frame sent them: a frame carries them only when they differ. */
  let sentCards: string | undefined;
  const flush = (): void => {
    timer = undefined;
    // A card may read any entity it declares, so it is looked at on every frame.
    const cards = deps.cards?.();
    const cardsJson = cards === undefined ? undefined : JSON.stringify(cards);
    const cardsMoved = cardsJson !== undefined && cardsJson !== sentCards;
    if (pending.size === 0 && !cardsMoved) return;
    const states = Object.fromEntries(pending);
    pending.clear();
    if (cardsMoved) sentCards = cardsJson;
    deps.publish({ type: "house", at: now(), states, ...(cardsMoved ? { cards: cards! } : {}) });
  };
  const schedule = (): void => {
    timer ??= setTimeout(flush, deps.frameMs ?? 1000);
  };
  const unsubscribe = deps.ha.onStateChanged((e) => {
    if (e.newState === null || !deps.listening() || !inView(e.entityId, registry)) return;
    pending.set(e.entityId, liveState(e.newState));
    schedule();
  });

  return {
    view,
    energyToday,
    configure(next) {
      cfg = next;
    },
    cardsChanged() {
      if (deps.cards !== undefined && deps.listening()) schedule();
    },
    stop() {
      unsubscribe();
      for (const off of unsubscribeRegistry) off?.();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
