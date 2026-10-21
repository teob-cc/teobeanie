// view.ts — what GET api/house returns and what the "house" SSE frames carry: the
// layout (sections, groups, roles) once, the entities' live states, then batches of
// changed states. Pure: the panel imports the types and liveState().

import type { InstanceCard } from "../kernel/card.js";
import type { Layout, LayoutEntity } from "./layout.js";

export type { InstanceCard };

/** An entity's state as the panel needs it. Times are ms epoch. */
export interface LiveState {
  state: string;
  attributes: Record<string, unknown>;
  changedAt: number;
  updatedAt: number;
}

export type HouseEntity = LayoutEntity & LiveState;

/** A legacy tiles.json tile (unchanged schema). */
export interface TileSpecView {
  entityId: string;
  label: string;
  kind: string;
  attribute?: string;
}

export interface HouseView {
  at: number;
  /** True when allowlist.json limits the view; false shows everything Home Assistant has. */
  scoped: boolean;
  /** Registry data (areas, devices) was available. */
  registry: boolean;
  /** Where the outdoor conditions come from (allowlist.json "outdoor"). */
  outdoor?: { weather?: string; temperature?: string; humidity?: string; wind?: string };
  sections: Layout["sections"];
  pinned: string[];
  tiles: TileSpecView[];
  entities: Record<string, HouseEntity>;
  /** The cards of the active and shadow instances whose heuristic has a view(). */
  cards: InstanceCard[];
}

/** GET api/house/energy-today: today's totals of HA's energy dashboard sources in scope. */
export interface EnergyToday {
  at: number;
  /** Local midnight (house time zone), ms epoch. */
  since: number;
  totals: Array<{ kind: "grid_import" | "grid_export" | "solar" | "gas" | "water"; value: number; unit: string }>;
}

/** SSE frame: states changed since the last frame (coalesced, at most one per second). */
export interface HouseFrame {
  type: "house";
  at: number;
  states: Record<string, LiveState>;
  /** Every card again, when any changed since the last frame. */
  cards?: InstanceCard[];
}

// Attributes the panel never reads; dropped to keep frames small.
const DROP = new Set(["friendly_name", "icon", "entity_picture", "supported_features", "supported_color_modes", "attribution", "effect_list", "source_list", "sound_mode_list", "hvac_modes", "preset_modes", "fan_modes", "swing_modes", "options", "editable", "id", "user_id", "device_trackers"]);

export function liveState(s: { state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string }): LiveState {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.attributes)) if (!DROP.has(k)) attributes[k] = v;
  const changedAt = Date.parse(s.last_changed);
  const updatedAt = Date.parse(s.last_updated);
  return { state: s.state, attributes, changedAt: Number.isFinite(changedAt) ? changedAt : 0, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
}
