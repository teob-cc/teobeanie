// allowlist.ts — the house scope: which HA entities Teobeanie may see and which it may
// operate. Every listed entity is observed (routed into signals.db with its debounce
// class); an entry marked "operate": true may also be acted on. Everything else in
// Home Assistant (the printer, the cameras, ...) does not exist for Teobeanie: heuristics
// cannot watch or call it, the Studio does not type it and the MCP tools do not show it.
// Loaded from DATA_DIR/allowlist.json with a fallback to the committed
// examples/starter/allowlist.json (generic placeholders, so a fresh install boots).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteSpec } from "@lambda-house/teob-ts/ha";
import type { HouseFacts, OutdoorSources } from "./kernel/heuristic.js";

export interface AllowlistFile {
  policyVersion?: number;
  /** Where the outdoor conditions come from; every entity must be listed below. */
  outdoor?: OutdoorSources;
  entities: Array<{
    id: string;
    /** Default "on-change". */
    debounce?: "on-change" | "deadband" | "throttle-ema" | "slow-context";
    /** Teobeanie may call services on this entity. Default false: observe only. */
    operate?: boolean;
    params?: { deadband?: number; emaHalflifeMs?: number; emitIntervalMs?: number };
  }>;
}

/** The house's operation scope. */
export interface HouseScope {
  /** Listed in allowlist.json: Teobeanie may read it. */
  observes(entityId: string): boolean;
  /** Listed with "operate": true: Teobeanie may act on it. */
  operates(entityId: string): boolean;
  readonly observed: readonly string[];
  readonly operated: readonly string[];
}

export function houseScope(observed: Iterable<string>, operated: Iterable<string>): HouseScope {
  const obs = new Set(observed);
  const ops = new Set(operated);
  for (const e of ops) obs.add(e);
  return {
    observes: (e) => obs.has(e),
    operates: (e) => ops.has(e),
    observed: [...obs].sort(),
    operated: [...ops].sort(),
  };
}

/** A scope that answers from whatever scope is current: handed out once, swapped by a config reload. */
export function liveScope(current: () => HouseScope): HouseScope {
  return {
    observes: (e) => current().observes(e),
    operates: (e) => current().operates(e),
    get observed() {
      return current().observed;
    },
    get operated() {
      return current().operated;
    },
  };
}

export interface Allowlist {
  policyVersion: number;
  routes: RouteSpec[];
  scope: HouseScope;
  /** Facts every decision sees (the outdoor sources). */
  house: HouseFacts;
  /** False when no allowlist.json exists and the starter example stands in. */
  fromFile: boolean;
}

const DEBOUNCE_CLASSES = new Set(["on-change", "deadband", "throttle-ema", "slow-context"]);

/** Package root = parent of the directory holding this module (src/ or dist/). */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Load and validate the entity allowlist.
 *
 * Throws with a precise message on: unparseable JSON, missing entities array,
 * duplicate id, unknown debounce class, deadband route without params.deadband.
 */
export function loadAllowlist(dataDir: string, log: (l: string, m: string) => void): Allowlist {
  const primary = join(dataDir, "allowlist.json");
  let path = primary;
  if (!existsSync(primary)) {
    path = join(packageRoot(), "examples", "starter", "allowlist.json");
    log(
      "warning",
      `allowlist not found at ${primary} — falling back to ${path} (generic placeholders; ` +
        `create ${primary} to route your own entities)`,
    );
  }

  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`allowlist ${path}: unparseable JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as AllowlistFile).entities)) {
    throw new Error(`allowlist ${path}: missing "entities" array`);
  }
  const file = parsed as AllowlistFile;

  const seen = new Set<string>();
  const routes: RouteSpec[] = file.entities.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string" || entry.id === "") {
      throw new Error(`allowlist ${path}: entities[${i}] has no string "id"`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`allowlist ${path}: duplicate entity id "${entry.id}"`);
    }
    seen.add(entry.id);
    const debounce = entry.debounce ?? "on-change";
    if (!DEBOUNCE_CLASSES.has(debounce)) {
      throw new Error(
        `allowlist ${path}: entity "${entry.id}" has unknown debounce class "${String(entry.debounce)}"`,
      );
    }
    if (entry.debounce === "deadband" && typeof entry.params?.deadband !== "number") {
      throw new Error(`allowlist ${path}: deadband entity "${entry.id}" requires params.deadband (number)`);
    }
    if (entry.operate !== undefined && typeof entry.operate !== "boolean") {
      throw new Error(`allowlist ${path}: entity "${entry.id}" has a non-boolean "operate"`);
    }
    const spec: RouteSpec = { entityId: entry.id, debounce };
    if (entry.params !== undefined) spec.params = entry.params;
    return spec;
  });

  const policyVersion = file.policyVersion ?? 1;
  const scope = houseScope(
    routes.map((r) => r.entityId),
    file.entities.filter((e) => e.operate === true).map((e) => e.id),
  );
  const house: HouseFacts = {};
  if (file.outdoor !== undefined) {
    const o = file.outdoor as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (!["weather", "temperature", "humidity", "wind"].includes(k)) throw new Error(`allowlist ${path}: outdoor has an unknown key "${k}"`);
      if (typeof v !== "string" || !scope.observes(v)) throw new Error(`allowlist ${path}: outdoor.${k} must be an entity listed in "entities"`);
    }
    if (o["weather"] !== undefined && !String(o["weather"]).startsWith("weather.")) {
      throw new Error(`allowlist ${path}: outdoor.weather must be a weather.* entity`);
    }
    house.outdoor = file.outdoor;
  }
  return { policyVersion, routes, scope, house, fromFile: path === primary };
}
