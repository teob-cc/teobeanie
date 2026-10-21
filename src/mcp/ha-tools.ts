// ha-tools.ts — Home Assistant as a whole, read through Teobeanie, for exploring a
// house and writing behaviours: the registries (areas, devices, entities), current
// states, the recorder's history, the services, and which behaviour packages fit
// (packages/suggest.ts). With these an agent needs no MCP server of Home Assistant's own.
//
// Unlike the house tools (tools.ts) they reach past the house scope, so they only
// read: nothing they see is recorded into signals or the journal (only the call
// itself, in mcp-audit, like every tool call), and none of them can call a service.

import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import type { MCPTool } from "@lambda-house/teob-ts/ai";
import type { HouseScope } from "../allowlist.js";
import type { HaRegistry, HaRegistryReader } from "../ha-registry.js";
import { houseZone } from "../kernel/clock.js";
import type { HouseFacts } from "../kernel/heuristic.js";
import type { InstanceInfo } from "../kernel/host.js";
import type { PackageInfo, StarterPackage } from "../packages/library.js";
import { suggest, type SuggestEntity, type SuggestPackage } from "../packages/suggest.js";
import { parseTime } from "./timeline.js";
import { bool, localTime, num, str, strs, tool, type Args } from "./tools.js";

export interface HaToolDeps {
  ha: { send<T = unknown>(message: Record<string, unknown>): Promise<T> };
  registry: HaRegistryReader;
  /** Every entity's current state (the bridge's live cache). */
  states(): ReadonlyMap<string, HaEntityState>;
  scope: HouseScope;
  house: HouseFacts;
  instances(): InstanceInfo[];
  /** The packages in the config folder. */
  packages?: () => PackageInfo[];
  /** The add-on's starter packages (installed or not). */
  starter?: () => Array<Pick<StarterPackage, "name" | "manifest">>;
  now?: () => number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** ha_history: the longest range, and the most points in one page. */
export const HISTORY_MAX_RANGE_MS = 7 * DAY;
export const HISTORY_PAGE = 2000;

/** What every one of these tools says about itself. */
const READ_ONLY = "Read-only, and outside the house scope too: nothing it reads is recorded (only the call, in tool_calls).";

const offset = (a: Args): number => {
  const c = str(a, "cursor");
  if (c === undefined) return 0;
  if (!/^\d+$/.test(c)) throw new Error("cursor: pass the `more` of the previous page");
  return Number(c);
};
const page = <T>(rows: T[], a: Args, def: number, max: number): { rows: T[]; more?: string } => {
  const from = offset(a);
  const limit = num(a, "limit", def, 1, max);
  const rows_ = rows.slice(from, from + limit);
  return { rows: rows_, ...(from + limit < rows.length ? { more: String(from + limit) } : {}) };
};
const domainOf = (id: string): string => id.slice(0, id.indexOf("."));
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function createHaTools(deps: HaToolDeps): MCPTool[] {
  const now = deps.now ?? Date.now;
  const zone = (): string => houseZone(deps.house);
  const local = (ms: number): string => localTime(ms, zone());

  /** Every entity HA knows: in the entity registry, or with a state. */
  const allIds = (reg: HaRegistry): string[] => [...new Set([...reg.entities.keys(), ...deps.states().keys()])].sort();
  const nameOf = (reg: HaRegistry, id: string): string | undefined => {
    const n = deps.states().get(id)?.attributes?.["friendly_name"];
    return typeof n === "string" ? n : reg.entities.get(id)?.name;
  };
  const classOf = (id: string): string | undefined => {
    const c = deps.states().get(id)?.attributes?.["device_class"];
    return typeof c === "string" ? c : undefined;
  };
  /** An area by id or name, any case. */
  const findArea = (reg: HaRegistry, wanted: string): string => {
    const w = wanted.trim().toLowerCase();
    const hit = [...reg.areas.values()].find((a) => a.id.toLowerCase() === w || a.name.toLowerCase() === w);
    if (hit === undefined) {
      if (!reg.ok) throw new Error("the registries are unavailable: no areas to filter by");
      throw new Error(`no area "${wanted}"; areas: ${[...reg.areas.values()].map((a) => a.name).sort().join(", ")}`);
    }
    return hit.id;
  };

  const describe = (reg: HaRegistry, id: string) => {
    const e = reg.entities.get(id);
    const where = deps.registry.areaOf(reg, id);
    const dev = e?.deviceId === undefined ? undefined : reg.devices.get(e.deviceId);
    const dc = classOf(id);
    const name = nameOf(reg, id);
    return {
      id,
      ...(name !== undefined ? { name } : {}),
      domain: domainOf(id),
      ...(dc !== undefined ? { device_class: dc } : {}),
      ...(where !== undefined ? { area: where.area.name, ...(where.from === "device" ? { area_from: "device" as const } : {}) } : {}),
      ...(dev !== undefined ? { device: dev.name, device_id: dev.id } : {}),
      ...(e?.platform !== undefined ? { platform: e.platform } : {}),
      ...(e?.disabled ? { disabled: true } : {}),
      ...(e?.hidden ? { hidden: true } : {}),
      ...(e?.category !== undefined ? { category: e.category } : {}),
      ...(reg.exposed !== undefined ? { exposed: reg.exposed.has(id) } : {}),
      ...(e === undefined ? { registry: false } : {}),
      in_scope: deps.scope.observes(id),
      operable: deps.scope.operates(id),
    };
  };

  return [
    tool(
      "ha_registry",
      `Home Assistant's registries, the whole house (not only the house scope): the areas (with how many entities each), and the entities with their name, domain, device class, area (their own, else their device's: area_from "device"), device, integration (platform), disabled or hidden, exposed to Assist, and whether they are in the house scope and operable. Filter by area (id or name), domain, device class, a search over id, name, device and area, or exposed. The devices of the page's entities come with their manufacturer and model. At most limit entities; \`more\` continues. ${READ_ONLY}`,
      {
        area: { type: "string", description: "area id or name" },
        domain: { type: "string", description: "e.g. light, binary_sensor" },
        device_class: { type: "string", description: "e.g. motion, door, temperature" },
        search: { type: "string", description: "words in the entity id, name, device or area (all must match)" },
        exposed: { type: "boolean", description: "only entities exposed to Assist (true) or not (false)" },
        limit: { type: "number", description: "default 200, max 1000" },
        cursor: { type: "string", description: "the `more` of the previous page, with the same arguments" },
      },
      async (a) => {
        const reg = await deps.registry.get();
        const area = str(a, "area");
        const areaId = area === undefined ? undefined : findArea(reg, area);
        const domain = str(a, "domain");
        const dc = str(a, "device_class");
        const words = (str(a, "search") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const exposed = a["exposed"] === undefined ? undefined : bool(a, "exposed", true);
        if (exposed !== undefined && reg.exposed === undefined) throw new Error("Home Assistant did not say which entities are exposed to Assist");
        const all = allIds(reg).map((id) => describe(reg, id));
        const perArea = new Map<string, number>();
        for (const id of allIds(reg)) {
          const w = deps.registry.areaOf(reg, id);
          if (w !== undefined && !reg.entities.get(id)?.disabled) perArea.set(w.area.id, (perArea.get(w.area.id) ?? 0) + 1);
        }
        const rows = all.filter((e) => {
          if (areaId !== undefined && deps.registry.areaOf(reg, e.id)?.area.id !== areaId) return false;
          if (domain !== undefined && e.domain !== domain) return false;
          if (dc !== undefined && e.device_class !== dc) return false;
          if (exposed !== undefined && e.exposed !== exposed) return false;
          const text = [e.id, e.name, e.device, e.area].filter(Boolean).join(" ").toLowerCase();
          return words.every((w) => text.includes(w));
        });
        const p = page(rows, a, 200, 1000);
        const deviceIds = new Set(p.rows.map((e) => e.device_id).filter((d): d is string => d !== undefined));
        return {
          registry: reg.ok,
          ...(reg.ok ? {} : { note: "Home Assistant's registries could not be read: no areas or devices" }),
          areas: [...reg.areas.values()]
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((ar) => ({ id: ar.id, name: ar.name, ...(ar.floor !== undefined ? { floor: ar.floor } : {}), entities: perArea.get(ar.id) ?? 0 })),
          count: rows.length,
          entities: p.rows,
          devices: [...deviceIds].map((id) => {
            const d = reg.devices.get(id)!;
            const ar = d.areaId === undefined ? undefined : reg.areas.get(d.areaId);
            return { id, name: d.name, ...(d.manufacturer !== undefined ? { manufacturer: d.manufacturer } : {}), ...(d.model !== undefined ? { model: d.model } : {}), ...(ar !== undefined ? { area: ar.name } : {}) };
          }),
          ...(p.more !== undefined ? { more: p.more } : {}),
        };
      },
    ),

    tool(
      "ha_states",
      `Current state of any Home Assistant entity, the whole house (not only the house scope): state, unit, device class, when it last changed and was updated (house time), whether it is in the house scope, and its attributes when asked. Pick entities by ids, or by domain and/or area. At most limit entities; \`more\` continues. ${READ_ONLY}`,
      {
        entity_ids: { type: "array", items: { type: "string" } },
        domain: { type: "string" },
        area: { type: "string", description: "area id or name" },
        attributes: { type: "boolean", description: "include each entity's attributes (default false)" },
        limit: { type: "number", description: "default 200, max 1000" },
        cursor: { type: "string", description: "the `more` of the previous page, with the same arguments" },
      },
      async (a) => {
        const listed = strs(a, "entity_ids");
        const domain = str(a, "domain");
        const area = str(a, "area");
        const withAttrs = bool(a, "attributes", false);
        const states = deps.states();
        let reg: HaRegistry | undefined;
        let areaId: string | undefined;
        if (area !== undefined) {
          reg = await deps.registry.get();
          areaId = findArea(reg, area);
        }
        const unknown = (listed ?? []).filter((id) => !states.has(id));
        const ids = (listed ?? [...states.keys()].sort()).filter(
          (id) =>
            states.has(id) &&
            (domain === undefined || domainOf(id) === domain) &&
            (areaId === undefined || deps.registry.areaOf(reg!, id)?.area.id === areaId),
        );
        const p = page(ids, a, 200, 1000);
        const rows = p.rows.map((id) => {
          const s = states.get(id)!;
          const attrs = s.attributes ?? {};
          const changed = Date.parse(s.last_changed);
          const updated = Date.parse(s.last_updated);
          return {
            id,
            ...(typeof attrs["friendly_name"] === "string" ? { name: attrs["friendly_name"] } : {}),
            state: s.state,
            ...(typeof attrs["unit_of_measurement"] === "string" ? { unit: attrs["unit_of_measurement"] } : {}),
            ...(typeof attrs["device_class"] === "string" ? { device_class: attrs["device_class"] } : {}),
            ...(Number.isFinite(changed) ? { last_changed: local(changed) } : {}),
            ...(Number.isFinite(updated) && updated !== changed ? { last_updated: local(updated) } : {}),
            in_scope: deps.scope.observes(id),
            ...(withAttrs ? { attributes: attrs } : {}),
          };
        });
        return {
          time_zone: zone(),
          now: local(now()),
          count: ids.length,
          entities: rows,
          ...(unknown.length > 0 ? { unknown } : {}),
          ...(p.more !== undefined ? { more: p.more } : {}),
        };
      },
    ),

    tool(
      "ha_history",
      `Any Home Assistant entity's state history from the recorder, the whole house (not only the house scope), house time, oldest first: at most 7 days per range and ${HISTORY_PAGE} points per page; \`more\` continues. ${READ_ONLY}`,
      {
        entity: { type: "string" },
        from: { type: "string", description: 'start: "HH:MM" (today), "YYYY-MM-DD HH:MM" (house time), ISO 8601 or epoch ms; default 24 h before to' },
        to: { type: "string", description: "end, the same forms; default now" },
        cursor: { type: "string", description: "the `more` of the previous page, with the same arguments" },
      },
      async (a) => {
        const entity = str(a, "entity");
        if (entity === undefined) throw new Error("entity is required");
        if (!ENTITY_ID.test(entity)) throw new Error(`${entity} is not an entity id`);
        const toMs = parseTime(a["to"], "to", zone(), now()) ?? now();
        const fromMs = parseTime(a["from"], "from", zone(), now()) ?? toMs - DAY;
        if (fromMs > toMs) throw new Error("from is after to");
        if (toMs - fromMs > HISTORY_MAX_RANGE_MS) throw new Error("the range is at most 7 days: ask for the rest in another call");
        const res = await deps.ha.send<Record<string, Array<{ s: string; lu: number }>>>({
          type: "history/history_during_period",
          start_time: new Date(fromMs).toISOString(),
          end_time: new Date(toMs).toISOString(),
          entity_ids: [entity],
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        });
        const points = (res[entity] ?? []).map((pt) => ({ at: local(pt.lu * 1000), state: pt.s }));
        const from = offset(a);
        const p = { rows: points.slice(from, from + HISTORY_PAGE), more: from + HISTORY_PAGE < points.length ? String(from + HISTORY_PAGE) : undefined };
        const s = deps.states().get(entity);
        const name = s?.attributes?.["friendly_name"];
        const unit = s?.attributes?.["unit_of_measurement"];
        return {
          entity,
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof unit === "string" ? { unit } : {}),
          from: local(fromMs),
          to: local(toMs),
          total: points.length,
          points: p.rows,
          ...(p.more !== undefined ? { more: p.more } : {}),
        };
      },
    ),

    tool(
      "ha_services",
      `Home Assistant's services, for writing behaviours (which never call them directly: they act through Teobeanie's SafeActuator). Without a domain: each domain and its service names. With one: its services with their fields (description, required, example, selector) and target. ${READ_ONLY}`,
      { domain: { type: "string", description: "e.g. light, climate" } },
      async (a) => {
        const domain = str(a, "domain");
        type Service = { name?: string; description?: string; fields?: Record<string, unknown>; target?: unknown; response?: unknown };
        const all = await deps.ha.send<Record<string, Record<string, Service>>>({ type: "get_services" });
        if (domain === undefined) {
          return { domains: Object.keys(all).sort().map((d) => ({ domain: d, services: Object.keys(all[d] ?? {}).sort() })) };
        }
        const services = all[domain];
        if (services === undefined) throw new Error(`no domain "${domain}"`);
        return {
          domain,
          services: Object.entries(services)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([service, s]) => ({
              service: `${domain}.${service}`,
              ...(s.name ? { name: s.name } : {}),
              ...(s.description ? { description: s.description } : {}),
              ...(s.target !== undefined ? { target: s.target } : {}),
              fields: s.fields ?? {},
            })),
        };
      },
    ),

    tool(
      "suggest",
      `Which behaviour packages fit this house: the starter packages and those in the config folder, whose roles (teobeanie.json) Home Assistant's entities can fill. Per suggestion: the package and heuristic, the area, an instance for heuristics.json in shadow with its entity params bound (the same area's entities first), what it would switch, what is missing, alternatives, optional roles' candidates, roles matched by domain only (check those by name), and a one-line reason. Entities an instance of the same heuristic already uses are left out. Matching is by domain, device class and area only: names and the owner decide. ${READ_ONLY}`,
      {
        area: { type: "string", description: "only this area (id or name)" },
        limit: { type: "number", description: "default 10, max 50" },
      },
      async (a) => {
        const reg = await deps.registry.get();
        const area = str(a, "area");
        const areaName = area === undefined ? undefined : reg.areas.get(findArea(reg, area))!.name;
        const entities: SuggestEntity[] = allIds(reg).map((id) => {
          const e = reg.entities.get(id);
          const dc = classOf(id);
          const where = deps.registry.areaOf(reg, id);
          return {
            id,
            ...(where !== undefined ? { area: where.area.name } : {}),
            ...(dc !== undefined ? { device_class: dc } : {}),
            ...(e?.disabled ? { disabled: true } : {}),
            ...(e?.hidden ? { hidden: true } : {}),
            ...(e?.category !== undefined ? { category: true } : {}),
          };
        });
        const packages: SuggestPackage[] = [
          ...(deps.packages?.() ?? []).map((p) => ({ name: p.name, installed: p.installed, manifest: p.manifest })),
          ...(deps.starter?.() ?? []).map((p) => ({ name: p.name, installed: false, manifest: p.manifest })),
        ];
        const instances = deps.instances().map((i) => ({ heuristic: i.heuristic, entities: [...i.watch, ...i.reads, ...i.actuates], owns: i.actuates }));
        const suggestions = suggest({ packages, entities, instances, ...(areaName !== undefined ? { area: areaName } : {}), limit: num(a, "limit", 10, 1, 50) });
        return {
          ...(areaName !== undefined ? { area: areaName } : {}),
          registry: reg.ok,
          count: suggestions.length,
          suggestions,
          note: "Bindings match by domain, device class and area only. Read each package's README and example.json (heuristic_source with the package name) for its settings and guarantees before writing an instance; every entity under operates needs \"operate\": true in allowlist.json.",
        };
      },
    ),
  ];
}
