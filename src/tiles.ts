// tiles.ts — the House view's pinned tiles, composed from the bridge's live cache.
// Which entities get a tile is house configuration: CONFIG_DIR/tiles.json; without it
// the House view has no pinned tiles and the generic layout (by area and domain). The
// same file's optional "groups" adjusts the House view's sections (house/layout.ts).
// examples/starter/tiles.json is a starting point.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeState, type HaBridge } from "@lambda-house/teob-ts/ha";
import { parseGroups, type GroupsConfig } from "./house/layout.js";
import { compassPoint } from "./house/summary.js";

export type TileKind = "power" | "temp" | "co2" | "humidity" | "wind" | "binary" | "presence" | "text";

const KINDS = new Set<TileKind>(["power", "temp", "co2", "humidity", "wind", "binary", "presence", "text"]);

export interface TileSpec {
  entityId: string;
  label: string;
  kind: TileKind;
  /** Show this attribute instead of the state (a weather entity's wind_speed, humidity, ...). */
  attribute?: string;
}

/** The unit of a weather attribute, from the entity's own *_unit attributes. */
function attributeUnit(attributes: Record<string, unknown>, attribute: string): string | null {
  const unitKey = attribute.startsWith("wind") && attribute !== "wind_bearing" ? "wind_speed_unit" : attribute === "dew_point" || attribute.endsWith("temperature") ? "temperature_unit" : `${attribute}_unit`;
  const unit = attributes[unitKey];
  if (typeof unit === "string") return unit;
  if (attribute === "humidity" || attribute === "cloud_coverage") return "%";
  if (attribute === "wind_bearing") return "°";
  return null;
}

/** Where the wind comes from, as a compass point. */
export const compass = compassPoint;

/** Load CONFIG_DIR/tiles.json ({"tiles": [{entityId, label, kind}]}), else none. */
export function loadTiles(configDir: string, log: (l: string, m: string) => void): TileSpec[] {
  return loadHouseConfig(configDir, log).tiles;
}

/**
 * CONFIG_DIR/tiles.json: the pinned "tiles" and the House view's "groups" overrides
 * (see house/layout.ts). Either may be left out; without the file, no tiles.
 */
export function loadHouseConfig(configDir: string, log: (l: string, m: string) => void): { tiles: TileSpec[]; groups: GroupsConfig } {
  const path = join(configDir, "tiles.json");
  if (!existsSync(path)) {
    log("info", `no ${path} — House view shows no pinned tiles and the generic layout`);
    return { tiles: [], groups: {} };
  }
  let parsed: { tiles?: unknown; groups?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { tiles?: unknown; groups?: unknown };
  } catch (err) {
    throw new Error(`${path}: unparseable JSON: ${(err as Error).message}`);
  }
  if (parsed.tiles === undefined && parsed.groups !== undefined) return { tiles: [], groups: parseGroups(parsed.groups, `${path}: groups`) };
  if (!Array.isArray(parsed.tiles)) throw new Error(`${path}: missing "tiles" array`);
  return { tiles: parseTiles(parsed.tiles, path), groups: parseGroups(parsed.groups, `${path}: groups`) };
}

function parseTiles(tiles: unknown[], path: string): TileSpec[] {
  return tiles.map((t, i) => {
    const spec = t as Partial<TileSpec>;
    if (typeof spec.entityId !== "string" || typeof spec.label !== "string" || !KINDS.has(spec.kind as TileKind)) {
      throw new Error(`${path}: tiles[${i}] needs entityId, label and kind (${[...KINDS].join("|")})`);
    }
    if (spec.attribute !== undefined && typeof spec.attribute !== "string") throw new Error(`${path}: tiles[${i}].attribute must be a string`);
    return { entityId: spec.entityId, label: spec.label, kind: spec.kind as TileKind, ...(spec.attribute ? { attribute: spec.attribute } : {}) };
  });
}

export interface Tile extends TileSpec {
  value: number | string | boolean | null;
  unit: string | null;
  stateAt: number | null;
}

export function buildTiles(specs: TileSpec[], bridge: Pick<HaBridge, "liveState">): { at: number; tiles: Tile[] } {
  return {
    at: Date.now(),
    tiles: specs.map((spec) => {
      const state = bridge.liveState(spec.entityId);
      if (state === undefined) return { ...spec, value: null, unit: null, stateAt: null };
      const parsed = Date.parse(state.last_updated);
      if (spec.attribute !== undefined) {
        const v = state.attributes[spec.attribute];
        const bearing = state.attributes["wind_bearing"];
        const unit = attributeUnit(state.attributes, spec.attribute);
        return {
          ...spec,
          value: typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : null,
          unit: spec.kind === "wind" && typeof bearing === "number" ? `${unit ?? ""} ${compass(bearing)}`.trim() : unit,
          stateAt: Number.isFinite(parsed) ? parsed : null,
        };
      }
      const normalized = normalizeState(state);
      return {
        ...spec,
        value: normalized.value,
        unit: normalized.unit,
        stateAt: Number.isFinite(parsed) ? parsed : null,
      };
    }),
  };
}

/** Boot check: warn for every tile entity missing from the allowlist (its SSE updates would be missing). */
export function checkTileCoverage(specs: TileSpec[], routedEntityIds: Iterable<string>, log: (l: string, m: string) => void): void {
  const routed = new Set(routedEntityIds);
  for (const spec of specs) {
    if (!routed.has(spec.entityId)) {
      log("warning", `tile entity ${spec.entityId} is not in the allowlist — its live SSE updates will be missing`);
    }
  }
}
