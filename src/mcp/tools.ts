// tools.ts — the house as MCP tools, for an agent (or a person auditing one): the
// entities in the house scope with their current state, what changed and who changed
// it, the recorder's history, the heuristics with their source and their decisions,
// a decision's causation chain, signal rows over a range, one merged timeline
// (timeline.ts), and the tool calls agents made. Read-only: nothing here can act on
// the house.
//
// Only the house scope exists here. An entity outside allowlist.json is reported as
// outside the scope, never read. Times are house-local.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCPToolResultFactory as Result, type MCPTool, type MCPToolResult } from "@lambda-house/teob-ts/ai";
import type { JournalReader } from "@lambda-house/teob-ts/core";
import type { HaEntityState, SignalQuery, SignalRow } from "@lambda-house/teob-ts/ha";
import type { HouseScope } from "../allowlist.js";
import { houseZone } from "../kernel/clock.js";
import type { InstanceInfo } from "../kernel/host.js";
import { readOutdoor, type HouseFacts, type Observed } from "../kernel/heuristic.js";
import { normalizeState } from "@lambda-house/teob-ts/ha";
import { SOURCE_NAME, listSources } from "../studio/files.js";
import type { Caller } from "./access.js";
import type { PackageInfo } from "../packages/library.js";
import { MCP_CATEGORY } from "./journal.js";
import type { PauseState } from "../pause.js";
import { createUserDirectory, type UserDirectory } from "../attribution.js";
import { AUDIT_CATEGORY } from "../audit.js";
import { DEFAULT_WINDOW_MS, createHouseRecord, parseTime, payload, readJournal, rowTime, shownCause, type Cause, type DecisionRow } from "./timeline.js";

export interface HouseToolDeps {
  scope: HouseScope;
  liveState(entityId: string): HaEntityState | undefined;
  signals: { query(q: SignalQuery): SignalRow[] };
  journal: JournalReader;
  ha: { send<T = unknown>(message: Record<string, unknown>): Promise<T> };
  /** HA users by id (the audit's directory); one over deps.ha when absent. */
  users?: UserDirectory;
  instances(): InstanceInfo[];
  /** The global pause (pause.ts). */
  pause?(): PauseState;
  configDir: string;
  /** Where the outdoor conditions come from (allowlist.json "outdoor"), and the house's time zone. */
  house: HouseFacts;
  /** The behaviour packages the running set was loaded with (packages/ in the config folder). */
  packages?: () => PackageInfo[];
  caller(): Caller | undefined;
  now?: () => number;
}

const MINUTE = 60_000;

const localTimes = new Map<string, Intl.DateTimeFormat>();
/** "2026-10-12 21:30:05" in the given zone (the house's). */
export const localTime = (ms: number, timeZone: string): string => {
  let f = localTimes.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "medium" });
    localTimes.set(timeZone, f);
  }
  return f.format(ms);
};

type Args = Record<string, unknown>;
const num = (a: Args, key: string, def: number, min: number, max: number): number => {
  const v = a[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return Math.min(max, Math.max(min, v));
};
const str = (a: Args, key: string): string | undefined => {
  const v = a[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
};
const strs = (a: Args, key: string): string[] | undefined => {
  const v = a[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${key} must be a list of strings`);
  return v as string[];
};
const bool = (a: Args, key: string, def: boolean): boolean => {
  const v = a[key];
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new Error(`${key} must be true or false`);
  return v;
};

function tool(name: string, description: string, properties: Record<string, unknown>, run: (args: Args) => Promise<unknown> | unknown): MCPTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, additionalProperties: false },
    async execute(input: unknown): Promise<MCPToolResult> {
      try {
        const args = typeof input === "object" && input !== null ? (input as Args) : {};
        return Result.success(await run(args));
      } catch (err) {
        return Result.failure(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createHouseTools(deps: HouseToolDeps): MCPTool[] {
  const now = deps.now ?? Date.now;
  // The zone HA last gave, read on every call.
  const zone = (): string => houseZone(deps.house);
  const local = (ms: number): string => localTime(ms, zone());
  const name = (id: string): string | undefined => {
    const n = deps.liveState(id)?.attributes?.["friendly_name"];
    return typeof n === "string" ? n : undefined;
  };
  const inScope = (ids: string[]) => ({ in: ids.filter((e) => deps.scope.observes(e)), out: ids.filter((e) => !deps.scope.observes(e)) });
  const entitiesFor = (a: Args): { ids: string[]; outside: string[] } => {
    const listed = strs(a, "entities");
    const domain = str(a, "domain");
    if (listed !== undefined) {
      const s = inScope(listed);
      return { ids: s.in, outside: s.out };
    }
    return { ids: deps.scope.observed.filter((e) => domain === undefined || e.startsWith(`${domain}.`)), outside: [] };
  };

  const users = deps.users ?? createUserDirectory({ send: (m) => deps.ha.send(m), log: () => {}, now });
  const record = createHouseRecord({ ...deps, users, now });

  const heuristicCategories = () => [...new Set(deps.instances().map((i) => i.heuristic))];

  /** A cause as shown: who, and the event to chain when there is one. */
  const shown = (c: Cause) => ({ by: shownCause(c), ...(c.event !== undefined ? { cause: c.event } : {}) });
  /** A record row as shown: house time, the cause flattened. */
  const shownRow = <R extends { at: number; by?: Cause | string; timers?: Array<{ timer: unknown; at: number }> }>({ at, by, timers, ...rest }: R) => ({
    at: local(at),
    ...rest,
    ...(by === undefined ? {} : typeof by === "string" ? { by } : shown(by)),
    ...(timers !== undefined ? { timers: timers.map((t) => ({ timer: t.timer, at: local(t.at) })) } : {}),
  });
  /** The from/to/limit/cursor/order of a range query. */
  const rangeOf = (a: Args, defLimit: number) => {
    const toMs = parseTime(a["to"], "to", zone(), now()) ?? now();
    const fromMs = parseTime(a["from"], "from", zone(), now()) ?? toMs - DEFAULT_WINDOW_MS;
    if (fromMs > toMs) throw new Error("from is after to");
    const order = str(a, "order") ?? "asc";
    if (order !== "asc" && order !== "desc") throw new Error('order must be "asc" or "desc"');
    const cursor = str(a, "cursor");
    return { fromMs, toMs, limit: num(a, "limit", defLimit, 1, 1000), order, ...(cursor !== undefined ? { cursor } : {}) } as const;
  };
  const RANGE = {
    from: { type: "string", description: 'start: "HH:MM" (today), "YYYY-MM-DD HH:MM" (house time), ISO 8601 or epoch ms; default 6 h before to' },
    to: { type: "string", description: "end, the same forms; default now" },
    order: { type: "string", enum: ["asc", "desc"], description: "asc (default, oldest first) or desc" },
    cursor: { type: "string", description: "the `more` of the previous page, with the same arguments" },
  };

  /** A package's source file, by heuristic id, "<package>/<file>" or the package's name (its first source). */
  const packageSource = (wanted: string): { pkg: PackageInfo; file: string } | undefined => {
    const packages = deps.packages?.() ?? [];
    for (const pkg of packages) {
      const byId = pkg.sources[wanted];
      if (byId !== undefined) return { pkg, file: byId };
    }
    const [name, file] = wanted.split("/");
    const pkg = packages.find((p) => p.name === name);
    if (pkg === undefined) return undefined;
    const sources = [...new Set(Object.values(pkg.sources))].sort();
    if (file === undefined) return sources[0] !== undefined ? { pkg, file: sources[0] } : undefined;
    return pkg.files.includes(file) && SOURCE_NAME.test(file) ? { pkg, file } : undefined;
  };

  return [
    tool(
      "house_scope",
      "The house scope: how many Home Assistant entities Teobeanie observes, by domain, and the ones it may operate. Anything else in Home Assistant is outside the house and invisible to these tools.",
      {},
      () => {
        const byDomain: Record<string, { observed: number; operable: number }> = {};
        for (const e of deps.scope.observed) {
          const d = e.slice(0, e.indexOf("."));
          const row = (byDomain[d] ??= { observed: 0, operable: 0 });
          row.observed++;
          if (deps.scope.operates(e)) row.operable++;
        }
        return {
          observed: deps.scope.observed.length,
          by_domain: byDomain,
          ...(deps.house.outdoor ? { outdoor_sources: deps.house.outdoor } : {}),
          operable: deps.scope.operated.map((id) => ({ id, name: name(id), state: deps.liveState(id)?.state })),
        };
      },
    ),

    tool(
      "house_state",
      "Current state of the entities in the house scope: state, unit, when it last changed (house time) and whether Teobeanie may operate it. Filter by domain, by entity ids, to operable ones, or to those changed in the last N minutes.",
      {
        domain: { type: "string", description: "e.g. light, binary_sensor" },
        entities: { type: "array", items: { type: "string" }, description: "entity ids" },
        operable_only: { type: "boolean" },
        changed_within_min: { type: "number", description: "only entities whose state changed in the last N minutes" },
      },
      (a) => {
        const { ids, outside } = entitiesFor(a);
        const operableOnly = bool(a, "operable_only", false);
        const within = a["changed_within_min"] === undefined ? undefined : num(a, "changed_within_min", 60, 1, 7 * 1440);
        const rows = ids
          .filter((id) => !operableOnly || deps.scope.operates(id))
          .map((id) => {
            const s = deps.liveState(id);
            const since = s ? Date.parse(s.last_changed) : NaN;
            const attrs = s?.attributes ?? {};
            return {
              id,
              name: name(id),
              state: s?.state ?? "missing",
              ...(typeof attrs["unit_of_measurement"] === "string" ? { unit: attrs["unit_of_measurement"] } : {}),
              ...(typeof attrs["device_class"] === "string" ? { device_class: attrs["device_class"] } : {}),
              since: Number.isFinite(since) ? local(since) : undefined,
              sinceMs: since,
              operable: deps.scope.operates(id),
            };
          })
          .filter((r) => within === undefined || (Number.isFinite(r.sinceMs) && r.sinceMs >= now() - within * MINUTE))
          .map(({ sinceMs: _drop, ...r }) => r);
        return { time_zone: zone(), now: local(now()), count: rows.length, entities: rows, ...(outside.length > 0 ? { outside_scope: outside } : {}) };
      },
    ),

    tool(
      "recent_changes",
      "What changed in the house and who did it: state changes of entities in the scope, and service calls on them, newest first. 'by' says who caused it: Teobeanie (with the heuristic instance when known), person:<name> (an HA user), system:<name> (a system user such as the Supervisor, which other add-ons call as), user:<id> (a user whose name is not known), automation, or device (no user: the device, an integration or an automation's call). Numeric sensors are left out unless asked for or listed.",
      {
        since_min: { type: "number", description: "look back this many minutes (default 60, max 7 days)" },
        domain: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        include_numeric: { type: "boolean", description: "include numeric sensor readings (default false)" },
        limit: { type: "number", description: "max rows of each kind (default 200, max 1000)" },
      },
      async (a) => {
        const sinceMs = now() - num(a, "since_min", 60, 1, 7 * 1440) * MINUTE;
        const limit = num(a, "limit", 200, 1, 1000);
        const { ids, outside } = entitiesFor(a);
        const numeric = bool(a, "include_numeric", false) || a["entities"] !== undefined;
        const by = await record.attribution(sinceMs);
        const changes: Array<{ at: number; entity: string; name?: string; from?: string; to: string; by: Cause; obs_id: string }> = [];
        for (const id of ids) {
          let prev: string | undefined;
          for (const row of deps.signals.query({ entityId: id, sinceMs, order: "asc", limit: 5000 })) {
            if (!numeric && typeof row.normalized.value === "number") break;
            const raw = row.raw as Partial<HaEntityState> | null;
            const state = typeof raw?.state === "string" ? raw.state : String(row.normalized.value);
            if (state === prev) continue;
            changes.push({ at: row.at, entity: id, name: name(id), ...(prev !== undefined ? { from: prev } : {}), to: state, by: await by(raw?.context), obs_id: row.obsId });
            prev = state;
          }
        }
        const calls: Array<{ at: number; service: string; entities: string[]; data?: unknown; by: Cause; event_id?: string }> = [];
        const wanted = new Set(ids);
        for (const r of readJournal(deps.journal, { category: AUDIT_CATEGORY, sinceMs }, 20_000)) {
          const p = r.payload as { domain: string; service: string; entityIds: string[]; serviceData?: Record<string, unknown>; at: number };
          const hit = (p.entityIds ?? []).filter((e) => wanted.has(e));
          if (hit.length === 0) continue;
          calls.push({
            at: p.at,
            service: `${p.domain}.${p.service}`,
            entities: hit,
            ...(p.serviceData && Object.keys(p.serviceData).length > 0 ? { data: p.serviceData } : {}),
            by: await record.callCause(by, r),
            ...(r.envelope?.eventId ? { event_id: r.envelope.eventId } : {}),
          });
        }
        const newest = <T extends { at: number; by: Cause }>(xs: T[]) => xs.sort((x, y) => y.at - x.at).slice(0, limit).map(shownRow);
        return {
          from: local(sinceMs),
          to: local(now()),
          changes: newest(changes),
          calls: newest(calls),
          ...(outside.length > 0 ? { outside_scope: outside } : {}),
        };
      },
    ),

    tool(
      "history",
      "One entity's state history from Home Assistant's recorder (longer than recent_changes keeps), house time, oldest first, at most 500 points.",
      {
        entity: { type: "string" },
        hours: { type: "number", description: "look back this many hours (default 24, max 336)" },
      },
      async (a) => {
        const entity = str(a, "entity");
        if (entity === undefined) throw new Error("entity is required");
        if (!deps.scope.observes(entity)) throw new Error(`${entity} is outside the house scope`);
        const start = now() - num(a, "hours", 24, 1, 336) * 3_600_000;
        const res = await deps.ha.send<Record<string, Array<{ s: string; lu: number }>>>({
          type: "history/history_during_period",
          start_time: new Date(start).toISOString(),
          end_time: new Date(now()).toISOString(),
          entity_ids: [entity],
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        });
        const points = (res[entity] ?? []).map((p) => ({ at: local(p.lu * 1000), state: p.s }));
        const unit = deps.liveState(entity)?.attributes?.["unit_of_measurement"];
        return { entity, name: name(entity), ...(typeof unit === "string" ? { unit } : {}), points: points.slice(-500), total: points.length };
      },
    ),

    tool(
      "heuristics",
      "The heuristic instances the house runs (heuristics.json): mode (off, shadow = decides but never acts, active), parameters, what each watches, reads and owns, and its last decision. While everything is paused, each instance the pause stops says since when and by whom (guards still act).",
      {},
      () => {
        const p = deps.pause?.();
        const paused = p?.paused ? { since: p.at !== undefined ? local(p.at) : undefined, by: p.by, ...(p.reason !== undefined ? { reason: p.reason } : {}) } : undefined;
        return deps.instances().map((i) => {
          const last = deps.journal.queryEvents({ category: i.heuristic, entityId: i.id, limit: 50, order: "desc" }).find((r) => payload(r).tag === "Decided");
          return {
            key: i.key,
            title: i.title,
            ...(i.pattern !== undefined ? { pattern: i.pattern } : {}),
            mode: i.mode,
            ...(i.configuredMode !== i.mode ? { configured_mode: i.configuredMode } : {}),
            ...(paused !== undefined && i.pattern !== "guard" && i.mode !== "off" ? { paused } : {}),
            params: i.params,
            watches: i.watch,
            reads: i.reads,
            owns: i.actuates,
            ...(i.uses.length > 0 ? { uses: i.uses } : {}),
            ...(i.commands.length > 0 ? { commands: i.commands } : {}),
            ...(i.triggers.length > 0 ? { triggers: i.triggers } : {}),
            ...(last ? { last_decision: { at: local(rowTime(last)), why: payload(last)["why"], ...(last.envelope?.eventId ? { event_id: last.envelope.eventId } : {}) } } : {}),
          };
        });
      },
    ),

    tool(
      "heuristic_source",
      "Source code of a heuristic: from a behaviour package in the config folder (by heuristic id, package name or <package>/<file>; a starter package came with the add-on, and says whether the house changed it), or a rule file in the config folder's heuristics/. Without a name, lists them.",
      { name: { type: "string", description: "e.g. occupancy-light, door-watch, door-watch/door-nag.ts, hallway-light.ts" } },
      (a) => {
        const config = listSources(deps.configDir).map((f) => f.name);
        const wanted = str(a, "name");
        const about = (p: PackageInfo) => ({ package: p.name, version: p.version, origin: p.origin, modified: p.modified });
        if (wanted === undefined) {
          const packages = (deps.packages?.() ?? []).map((p) => ({ ...about(p), title: p.title, heuristics: p.heuristics, files: p.files.filter((f) => SOURCE_NAME.test(f)) }));
          return { packages, config_folder: config };
        }
        const found = packageSource(wanted);
        if (found !== undefined) {
          const { pkg, file } = found;
          const defines = Object.entries(pkg.sources).filter(([, f]) => f === file).map(([id]) => id);
          return { name: `${pkg.name}/${file}`, ...about(pkg), built_in: pkg.origin === "starter", defines, source: readFileSync(join(pkg.dir, file), "utf8") };
        }
        const file = config.find((f) => f === wanted || f === `${wanted}.ts` || f === `${wanted}.js` || f === `${wanted}.mjs`);
        if (file && SOURCE_NAME.test(file)) return { name: file, built_in: false, source: readFileSync(join(deps.configDir, "heuristics", file), "utf8") };
        throw new Error(`no heuristic source named ${wanted}`);
      },
    ),

    tool(
      "decisions",
      "Teobeanie's decisions, newest first: what came in, why the heuristic decided, and each action with what became of it (shadow = journaled but not sent, refused with the reason, sent, done, failed).",
      {
        since_min: { type: "number", description: "look back this many minutes (default 1440, max 30 days)" },
        instance: { type: "string", description: "instance key (heuristic/id) or heuristic id" },
        actions_only: { type: "boolean", description: "only decisions that produced an action" },
        limit: { type: "number", description: "default 100, max 1000" },
      },
      (a) => {
        const sinceMs = now() - num(a, "since_min", 1440, 1, 30 * 1440) * MINUTE;
        const limit = num(a, "limit", 100, 1, 1000);
        const only = str(a, "instance");
        const actionsOnly = bool(a, "actions_only", false);
        const out: DecisionRow[] = [];
        for (const category of heuristicCategories()) {
          if (only !== undefined && only !== category && !only.startsWith(`${category}/`)) continue;
          const rows = readJournal(deps.journal, { category, sinceMs, ...(only?.includes("/") ? { entityId: only.slice(category.length + 1) } : {}) }, 20_000);
          out.push(...record.foldDecisions(category, rows).filter((d) => !actionsOnly || d.actions !== undefined));
        }
        return out
          .sort((x, y) => y.at - x.at)
          .slice(0, limit)
          .map(shownRow);
      },
    ),

    tool(
      "chain",
      "Why a journal event happened: its causation chain, the event first, then what caused it, back to what started it (a signal row, a timer, a command). Each hop has its stream, instance, tag, house time and a one-line summary; a call Teobeanie made continues into the decision that requested it. Also what the event itself caused. Event ids come from decisions, timeline, signals and recent_changes (event_id, cause).",
      { event_id: { type: "string" } },
      async (a) => {
        const id = str(a, "event_id");
        if (id === undefined) throw new Error("event_id is required");
        const c = await record.chain(id, local);
        return {
          event_id: c.event_id,
          hops: c.hops.map(shownRow),
          ...(c.origin !== undefined ? { origin: "obs_id" in c.origin ? shownRow(c.origin) : c.origin } : {}),
          ...(c.effects.length > 0 ? { effects: c.effects.map(shownRow) } : {}),
        };
      },
    ),

    tool(
      "signals",
      "One entity's signal rows (what Teobeanie recorded of it) over a time range, house time: state, value, unit, who caused each change ('by' as in recent_changes, 'cause' the event to chain) and its obs_id. At most limit rows; `more` continues.",
      {
        entity: { type: "string" },
        ...RANGE,
        limit: { type: "number", description: "default 200, max 1000" },
      },
      async (a) => {
        const entity = str(a, "entity");
        if (entity === undefined) throw new Error("entity is required");
        const p = await record.signals(entity, rangeOf(a, 200));
        return { entity, name: name(entity), from: local(p.from), to: local(p.to), rows: p.rows.map(shownRow), ...(p.more !== undefined ? { more: p.more } : {}) };
      },
    ),

    tool(
      "timeline",
      "What happened around an entity or a heuristic instance, in time order: changes (what changed, by whom), calls (who called what on it), decisions (why, each action with what became of it), the pause, and config changes. Every row has its event_id or obs_id to cite or chain. For an entity: the instances that watch, read or own it; for an instance: what it watches and owns. At most limit rows; `more` continues.",
      {
        entity: { type: "string" },
        instance: { type: "string", description: "instance key (heuristic/id) or heuristic id" },
        ...RANGE,
        limit: { type: "number", description: "default 100, max 1000" },
      },
      async (a) => {
        const entity = str(a, "entity");
        const instance = str(a, "instance");
        const p = await record.timeline({ ...(entity !== undefined ? { entity } : {}), ...(instance !== undefined ? { instance } : {}) }, rangeOf(a, 100));
        return {
          ...(entity !== undefined ? { entity, name: name(entity) } : { instance }),
          from: local(p.from),
          to: local(p.to),
          rows: p.rows.map(shownRow),
          ...(p.more !== undefined ? { more: p.more } : {}),
        };
      },
    ),

    tool(
      "tool_calls",
      "The MCP tool calls agents made against this house, newest first: tool, arguments, who called (HA user and network address), and the outcome. Use it to review what an agent has been doing.",
      {
        since_min: { type: "number", description: "default 1440, max 30 days" },
        tool: { type: "string" },
        limit: { type: "number", description: "default 100, max 1000" },
      },
      (a) => {
        const sinceMs = now() - num(a, "since_min", 1440, 1, 30 * 1440) * MINUTE;
        const only = str(a, "tool");
        return readJournal(deps.journal, { category: MCP_CATEGORY, sinceMs }, 5000)
          .map(payload)
          .filter((p) => only === undefined || p["tool"] === only)
          .slice(0, num(a, "limit", 100, 1, 1000))
          .map(({ tag: _tag, ...p }) => ({ ...p, at: local(p["at"] as number) }));
      },
    ),

    tool(
      "outdoor",
      "Outdoor conditions now: temperature, humidity, wind speed, gusts and bearing, and the weather condition, with the entity each value comes from (measuring sensors are preferred over the weather forecast entity).",
      {},
      () => {
        const o = deps.house.outdoor;
        if (o === undefined) return { configured: false, note: 'no "outdoor" sources in allowlist.json' };
        const observe = (id: string): Observed | undefined => {
          const s = deps.liveState(id);
          return s === undefined ? undefined : { value: normalizeState(s).value, state: s.state, since: Date.parse(s.last_updated), attributes: s.attributes };
        };
        const sources = Object.fromEntries(
          Object.entries(o).map(([k, id]) => {
            const s = deps.liveState(id);
            return [k, { entity: id, state: s?.state ?? "missing", updated: s ? local(Date.parse(s.last_updated)) : undefined }];
          }),
        );
        return { now: local(now()), ...readOutdoor(observe, o), sources };
      },
    ),

    tool("whoami", "Who this server thinks you are (HA user, network address, door) and the house's time.", {}, () => ({
      caller: deps.caller() ?? null,
      now: local(now()),
      time_zone: zone(),
    })),
  ];
}

export const INSTRUCTIONS = `Teobeanie, the house's event-sourced assistant agent: the house as it sees it. Only the entities in the house scope (allowlist.json) exist here; everything else in Home Assistant is deliberately outside it. These tools are read-only.
Start with house_scope and house_state; recent_changes says who changed what (Teobeanie, a person, a system user such as the Supervisor, an automation, the device); decisions shows Teobeanie's reasoning and what became of each action; heuristics and heuristic_source show the logic. Heuristic instances in "shadow" mode decide and journal but never act.
To explain why something happened, find its row (timeline, decisions, recent_changes) and walk its event_id or cause with chain; signals gives an entity's recorded rows over a range. For what happened around an entity or an instance, timeline merges changes, calls, decisions, the pause and config changes in time order. Cite the event_id or obs_id of the rows an answer rests on. Ranges take from and to as "HH:MM", "YYYY-MM-DD HH:MM" (house time) or ISO; a page that has more says so (more: pass it as cursor).
Times are house-local (whoami and house_state give the zone). Every call you make is journaled (tool_calls).`;
