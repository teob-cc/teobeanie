// cli.ts — tools that work against a running Home Assistant:
//
//   HA_URL=http://homeassistant.local:8123 HA_TOKEN=... node dist/studio/cli.js types <config folder>
//
// writes <config folder>/heuristics/ha.d.ts (the house: the entities in its
// allowlist.json scope, or every entity without one, and the facts its packages and
// files define, each typed from its module), <config folder>/.teob/ (the
// "teobeanie" module's declarations, and heuristics.schema.json: heuristics.json as a JSON
// Schema built from the heuristics' parameter schemas, for an editor to check the instances
// with: "$schema": "./.teob/heuristics.schema.json") and, when absent, a tsconfig.json, so
// `tsc -p <config folder>` type-checks the rules there exactly as the Studio does.
//
//   HA_URL=... HA_TOKEN=... node dist/studio/cli.js replay <config folder> [<heuristic>/<id>]
//       [--heuristic <id>] [--params <json> | --params @<file>] [--replaces <who>] [--days 7] [--window-sec 120] [--timeline]
//
// runs an instance from <config folder>/heuristics.json (or the --heuristic with the
// --params given, which also override the instance's) over the recorder's history and
// compares what it would have done with what happened to the entities it owns. With
// --replaces (a user name as the logbook shows it, e.g. the one another automation
// add-on calls HA as), Teobeanie drives its entities instead: its calls take effect, that
// automation's recorded switches are dropped, and its switches are what Teobeanie is
// compared with; people's and devices' switches still happen.
//
//   node dist/studio/cli.js init <folder> [--force]
//
// writes a starter working set (examples/starter: README, the three files, a sample rule
// with its test, tsconfig.json), the starter packages into packages/ with their lock, and
// the typings for its allowlist; needs no Home
// Assistant. A folder that is not empty is refused unless --force.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import { loadAllowlist } from "../allowlist.js";
import { loadLibrary } from "../packages/library.js";
import { houseZone, isTimeZone } from "../kernel/clock.js";
import { outdoorEntities, type HouseFacts } from "../kernel/heuristic.js";
import { loadInstances } from "../kernel/host.js";
import { validateParams } from "../kernel/params.js";
import { compare, fmtAt, formatParity, houseChanges, replay, type Recorded } from "../replay.js";
import { heuristicsJsonSchema } from "./config-schema.js";
import { factModule, generateHouseTypes } from "./house-types.js";
import { initWorkingSet } from "./init.js";
import { CONFIG_TSCONFIG, toolkitTypes } from "./toolkit-types.js";

const USAGE = [
  "usage: node dist/studio/cli.js init <folder> [--force]",
  "       HA_URL=... HA_TOKEN=... node dist/studio/cli.js types <config folder>",
  "       HA_URL=... HA_TOKEN=... node dist/studio/cli.js replay <config folder> [<heuristic>/<id>] [--heuristic <id>] [--params <json>|@<file>] [--replaces <who>] [--days 7] [--window-sec 120] [--timeline]",
].join("\n");

const [command, dir, ...rest] = process.argv.slice(2);
if ((command !== "init" && command !== "types" && command !== "replay") || dir === undefined) {
  console.error(USAGE);
  process.exit(2);
}
if (command === "init") {
  if (rest.some((a) => a !== "--force")) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const r = initWorkingSet(dir, { force: rest.includes("--force") });
    console.log(`wrote ${r.written.length} files to ${dir}/ (start with README.md), and the starter packages to ${join(dir, "packages")}/: ${r.packages.join(", ")}`);
    console.log(`typings cover the starter's ${r.entities} placeholder entities (${r.operable} operable). For the real house, once its allowlist.json is in place:`);
    console.log(`  HA_URL=http://homeassistant.local:8123 HA_TOKEN=... node dist/studio/cli.js types ${dir}`);
    if (!r.toolkit) console.log(`no emitted declarations next to the toolkit, so no ${join(dir, ".teob")}/: build first (pnpm build), or run types`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}
const url = (process.env["HA_URL"] ?? "http://homeassistant.local:8123").replace(/\/$/, "");
const token = process.env["HA_TOKEN"]?.trim();
if (!token) {
  console.error("set HA_TOKEN to a long-lived Home Assistant token");
  process.exit(2);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`GET ${url}${path}: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  return (await res.json()) as T;
}

if (command === "types") await types(dir);
else await replayCommand(dir, rest);

async function types(dir: string): Promise<void> {
  const all = await get<HaEntityState[]>("/api/states");
  const scope = existsSync(join(dir, "allowlist.json")) ? loadAllowlist(dir, () => {}).scope : undefined;
  if (scope === undefined) console.warn(`no ${join(dir, "allowlist.json")}: typing every entity, none operable`);
  const states = scope === undefined ? all : all.filter((s) => scope.observes(s.entity_id));

  const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  // The folder's packages, the starter ones it does not have yet, and its own files: their
  // facts are typed in ha.d.ts, their heuristics' params in heuristics.schema.json.
  const lib = await loadLibrary(dir, (_l, m) => console.error(m), undefined, { withStarter: true });
  const facts = lib.facts.map((f) => {
    const src = lib.factSources.get(f.id);
    const module = src === undefined ? undefined : factModule(join(dir, "heuristics"), src.file);
    return { id: f.id, title: f.title, ...(module !== undefined ? { module } : {}), ...(src?.binding !== undefined ? { binding: src.binding } : {}) };
  });
  write(join(dir, "heuristics", "ha.d.ts"), generateHouseTypes(states, { at: Date.now(), operable: scope?.operated ?? [], facts }));
  const toolkit = toolkitTypes();
  if (toolkit === undefined) {
    console.error("no emitted declarations next to the toolkit: build first (pnpm build)");
    process.exit(1);
  }
  for (const [file, text] of Object.entries(toolkit)) write(join(dir, ".teob", file), text);
  // heuristics.json's instances, checked by an editor as the loader checks them.
  write(join(dir, ".teob", "heuristics.schema.json"), `${JSON.stringify(heuristicsJsonSchema(lib.heuristics), null, 2)}\n`);
  const tsconfig = join(dir, "tsconfig.json");
  if (!existsSync(tsconfig)) write(tsconfig, `${JSON.stringify(CONFIG_TSCONFIG, null, 2)}\n`);
  console.log(`wrote ${states.length} entities (${scope?.operated.length ?? 0} operable) and ${facts.length} facts to ${join(dir, "heuristics", "ha.d.ts")}, the "teobeanie" module and heuristics.schema.json to ${join(dir, ".teob")}/`);
}

async function replayCommand(dir: string, args: string[]): Promise<void> {
  const flags = new Map<string, string>();
  let key: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--timeline") flags.set("timeline", "1");
    else if (a.startsWith("--")) flags.set(a.slice(2), args[++i] ?? "");
    else key = a;
  }
  const log = (_l: string, m: string) => console.error(m);
  const instance = key === undefined ? undefined : loadInstances(dir, log).find((i) => `${i.heuristic}/${i.id}` === key);
  if (key !== undefined && instance === undefined) {
    console.error(`no instance ${key} in ${join(dir, "heuristics.json")}`);
    process.exit(2);
  }
  const heuristicId = flags.get("heuristic") ?? instance?.heuristic;
  const rawParams = flags.get("params");
  const params: unknown =
    rawParams === undefined ? instance?.params : JSON.parse(rawParams.startsWith("@") ? readFileSync(rawParams.slice(1), "utf8") : rawParams);
  if (heuristicId === undefined || params === undefined) {
    console.error(`name an instance, or --heuristic and --params\n${USAGE}`);
    process.exit(2);
  }
  const library = (await loadLibrary(dir, log, undefined, { withStarter: true })).heuristics;
  const def = library.find((d) => d.id === heuristicId);
  if (def === undefined) {
    console.error(`no heuristic "${heuristicId}" (in ${join(dir, "packages")}, the starter packages or ${join(dir, "heuristics")})`);
    process.exit(2);
  }
  const invalid = validateParams(def, params);
  if (invalid.length > 0) {
    console.error(`${heuristicId}: the params do not fit its schema:\n  ${invalid.join("\n  ")}`);
    process.exit(2);
  }
  // Local times (rules' between, the printed stamps) in HA's zone.
  const { time_zone: timeZone } = await get<{ time_zone?: string }>("/api/config");
  const house: HouseFacts = {
    ...(existsSync(join(dir, "allowlist.json")) ? loadAllowlist(dir, () => {}).house : {}),
    ...(isTimeZone(timeZone) ? { timeZone } : {}),
  };
  const tz = houseZone(house);

  const days = Number(flags.get("days") ?? 7);
  const windowMs = Number(flags.get("window-sec") ?? 120) * 1000;
  const to = Date.now();
  const from = to - days * 86_400_000;
  const owned = def.actuates(params);
  const entities = [
    ...new Set([...def.watch(params), ...owned, ...(def.watchAttributes?.(params) ?? []), ...(def.usesOutdoor ? outdoorEntities(house.outdoor) : [])]),
  ];

  // Full attributes, attribute-only changes included: a sun elevation or a weather reading can be a signal.
  const history = await get<HaEntityState[][]>(
    `/api/history/period/${new Date(from).toISOString()}?end_time=${encodeURIComponent(new Date(to).toISOString())}&filter_entity_id=${entities.join(",")}&significant_changes_only=0`,
  );
  const recorded: Recorded[] = history.flat().map((s) => ({
    entity: s.entity_id,
    at: Date.parse(s.last_updated ?? s.last_changed),
    state: s.state,
    attributes: s.attributes ?? {},
  }));
  const missing = entities.filter((e) => !recorded.some((r) => r.entity === e));

  const who = await attribution(owned, from, to);
  const replaces = flags.get("replaces");
  const calls = replay(def, params, recorded, { from, to }, {
    house,
    ...(replaces !== undefined ? { drive: { keep: (r: Recorded) => who(r.entity, r.at, r.state) !== replaces } } : {}),
  });
  const all = houseChanges(recorded, owned).map((c) => ({ ...c, ...withBy(who(c.entity, c.at, c.state)) }));
  const changes = replaces === undefined ? all : all.filter((c) => c.by === replaces);
  const label = instance !== undefined ? `${key}${flags.has("heuristic") || rawParams !== undefined ? ` as ${heuristicId} with the given params` : ""}` : heuristicId;
  console.log(`replay ${label}: ${fmtAt(from, tz)} → ${fmtAt(to, tz)} ${tz} (${days} days), ${recorded.length} recorded states of ${entities.length - missing.length} entities`);
  if (missing.length > 0) console.log(`no history for ${missing.join(", ")}`);
  if (replaces !== undefined) {
    const others = all.filter((c) => c.by !== replaces);
    console.log(`Teobeanie drives ${owned.join(", ")} in place of ${replaces}; compared with ${replaces}'s switches. Kept: ${others.length} switches by others${others.length > 0 ? ` (${[...new Set(others.map((c) => c.by ?? "unknown"))].join(", ")})` : ""}`);
  }
  console.log(formatParity(compare(calls, changes, owned, windowMs), windowMs, house));

  if (flags.has("timeline")) {
    console.log("\ntimeline:");
    const rows = [
      ...calls.map((c) => ({ at: c.at, text: `Teobeanie  ${c.service} ${c.entity} · ${c.why}` })),
      ...changes.map((c) => ({ at: c.at, text: `house      ${c.entity} → ${c.state}${c.by ? ` by ${c.by}` : ""}` })),
    ].sort((a, b) => a.at - b.at);
    for (const r of rows) console.log(`${fmtAt(r.at, tz)}  ${r.text}`);
  }
}

function withBy(by: string | undefined): { by?: string } {
  return by !== undefined ? { by } : {};
}

/** Who made a state change, from the logbook: a user's name, an automation, or "device". */
async function attribution(owned: string[], from: number, to: number): Promise<(entity: string, at: number, state: string) => string | undefined> {
  const users = await userNames();
  const byEntity = new Map<string, Array<{ at: number; state: string; by: string }>>();
  for (const entity of owned) {
    type Entry = { when: string; state?: string; context_user_id?: string | null; context_entity_id?: string };
    // The logbook covers one day unless given an end time.
    const entries = await get<Entry[]>(`/api/logbook/${new Date(from).toISOString()}?end_time=${encodeURIComponent(new Date(to).toISOString())}&entity=${entity}`);
    byEntity.set(
      entity,
      entries.map((e) => ({
        at: Date.parse(e.when),
        state: e.state ?? "",
        by: e.context_user_id ? (users.get(e.context_user_id) ?? `user ${e.context_user_id.slice(0, 8)}`) : (e.context_entity_id ?? "device"),
      })),
    );
  }
  return (entity, at, state) => byEntity.get(entity)?.find((e) => e.state === state && Math.abs(e.at - at) < 2000)?.by;
}

/** User id → name (needs an administrator's token; empty otherwise). */
async function userNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/websocket`);
    await new Promise<void>((resolve) => {
      const done = () => {
        ws.close();
        resolve();
      };
      const timer = setTimeout(done, 5000);
      ws.onerror = () => {
        clearTimeout(timer);
        done();
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; id?: number; success?: boolean; result?: Array<{ id: string; name: string }> };
        if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: 1, type: "config/auth/list" }));
        else if (m.type === "auth_invalid" || m.id === 1) {
          for (const u of m.result ?? []) names.set(u.id, u.name);
          clearTimeout(timer);
          done();
        }
      };
    });
  } catch {
    // No names: user ids are shown instead.
  }
  return names;
}
