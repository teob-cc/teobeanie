// working-set.ts — the working set's edits, journaled. Every change to the config folder
// that a reload applies (from the panel, the file watch or the CLI) is one
// ConfigChanged in a stream of its own: which files, who, what it changed for which
// instances, and the revision it makes (revisions.ts), so the timeline shows it between the decisions before and after it
// and the agent can explain a change in behaviour. A rejected reload changes nothing
// and journals nothing; the panel and the log show why.
//
// Also the panel's edits of heuristics.json: the file is hand-edited, so an edit
// changes only the value it is about (an instance's mode) and keeps the rest of the
// text as it was, then goes through the reload path like any other change.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CategoryId,
  EntityId,
  categoryTypes,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  type Aggregate,
  type Codec,
  type EntityRuntime,
} from "@lambda-house/teob-ts/core";
import type { Hono } from "hono";
import type { Mode } from "./kernel/actuator.js";
import type { InstanceConfig, InstanceInfo, ReloadChanges } from "./kernel/host.js";
import { requestUser } from "./pause.js";
import type { Reloader } from "./reload.js";
import { mayWrite } from "./studio/files.js";
import { installedPackageDirs } from "./packages/library.js";
import { packageFiles } from "./packages/lock.js";

/** The working set's stream (the timeline reads it), next to `teob-control/pause`. */
export const CONFIG_CATEGORY: CategoryId = CategoryId("teob-config");
export const CONFIG_ENTITY: EntityId = EntityId("working-set");

export interface ConfigChanged {
  tag: "ConfigChanged";
  at: number;
  /** The files the change touched: "heuristics.json", "heuristics/my-rule.ts, allowlist.json". */
  file: string;
  /** person:<name> or user:<id prefix> (the panel's HA user), "local" (standalone), "file" (the file watch), "cli". */
  by: string;
  /** "climate-guard/attic: params changed (maxRunMin 180 → 240); +door-nag/back" */
  summary: string;
  /**
   * The instance keys it added, removed or changed. Absent when it may touch every
   * instance (the scope changed), and on rows from before the field: those are global.
   */
  instances?: string[];
  /**
   * Its revision (revisions.ts): the working set after it is revision n, whose parent is
   * the one before. Absent on rows from before revisions.
   */
  revision?: number;
  parent?: number;
  /** The whole working set after it: path → content hash ("sha256-…"), the files under /data/revisions. */
  files?: Record<string, string>;
}

export type ConfigChange = Omit<ConfigChanged, "tag">;
export type ConfigCommand = { tag: "Record"; change: ConfigChange };

export const configAggregate: Aggregate<ConfigCommand, void, ConfigChanged, { changes: number }> = {
  category: CONFIG_CATEGORY,
  initial: () => ({ changes: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag !== "Record") return done();
    return persist(stampEnvelope({ tag: "ConfigChanged", ...cmd.change } satisfies ConfigChanged, { origin: cmd.change.by }));
  },
  apply: (state) => ({ changes: state.changes + 1 }),
};

export const configEventCodec: Codec<ConfigChanged> = tagCodec<ConfigChanged>("ConfigChanged");
export const configStateCodec: Codec<{ changes: number }> = objectCodec<{ changes: number }>("ConfigState");

/** Journal a change; resolves once it is persisted. */
export function createConfigJournal(runtime: Pick<EntityRuntime, "ask">): (change: ConfigChange) => Promise<void> {
  const cat = categoryTypes<ConfigCommand, void>(CONFIG_CATEGORY);
  return async (change) => {
    const res = await runtime.ask(CONFIG_ENTITY, { tag: "Record", change }, cat);
    if (!res.ok) throw new Error(`config journal: ${JSON.stringify(res.error)}`);
  };
}

// ---- what changed ----

/** The custom heuristics' sources, as the loader picks them (kernel/custom.ts). */
const SOURCE = /\.(ts|js|mjs)$/;
const isSource = (f: string): boolean => SOURCE.test(f) && !f.endsWith(".d.ts") && !/\.test\.[jt]s$/.test(f);

const digest = (text: string): string => createHash("sha1").update(text).digest("hex");

/**
 * A digest per working-set file a reload reads: the config files (as parsed JSON, so
 * a re-indent is not a change), the custom heuristics' sources and the packages' files.
 */
export function configFingerprint(configDir: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const path = join(configDir, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    let canonical = text;
    try {
      canonical = JSON.stringify(JSON.parse(text));
    } catch {
      // unparseable: the reload rejects it; its text is its digest
    }
    out.set(f, digest(canonical));
  }
  const dir = join(configDir, "heuristics");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter(isSource).sort()) out.set(`heuristics/${f}`, digest(readFileSync(join(dir, f), "utf8")));
  }
  // The packages' files, each on its own: "packages/door-watch/door-nag.ts".
  for (const pkg of installedPackageDirs(configDir)) {
    const name = pkg.split(/[\\/]/).pop()!;
    for (const f of packageFiles(pkg)) out.set(`packages/${name}/${f}`, digest(readFileSync(join(pkg, f), "utf8")));
  }
  return out;
}

/** The files whose digest differs between two fingerprints (added and removed ones too). */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)).sort();
}

const MAX_LINES = 6;
const MAX_VALUE = 40;

const shown = (v: unknown): string => {
  if (v === undefined) return "unset";
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
};

/** "maxRunMin 180 → 240, room "a" → "b"": the top-level parameters that differ. */
function paramsDiff(before: unknown, after: unknown): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  if (typeof b !== "object" || typeof a !== "object" || Array.isArray(b) || Array.isArray(a)) return `${shown(before)} → ${shown(after)}`;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  const parts = keys.slice(0, 3).map((k) => `${k} ${shown(b[k])} → ${shown(a[k])}`);
  return parts.join(", ") + (keys.length > 3 ? `, and ${keys.length - 3} more` : "");
}

/**
 * One line per instance a reload touched, from its diff and the instances before and
 * after it: "+door-nag/back", "−door-nag/back", "climate-guard/attic: params changed
 * (maxRunMin 180 → 240)", "relay-pulse/gate: mode shadow → active".
 */
export function describeChanges(c: ReloadChanges, before: InstanceInfo[], after: InstanceInfo[]): string[] {
  const was = new Map(before.map((i) => [i.key, i]));
  const now = new Map(after.map((i) => [i.key, i]));
  const lines = [...c.added.map((k) => `+${k}`), ...c.removed.map((k) => `−${k}`)];
  for (const { key, why } of c.changed) {
    const b = was.get(key);
    const a = now.get(key);
    const detail =
      b === undefined || a === undefined ? ""
      : why === "mode" ? ` ${b.configuredMode} → ${a.configuredMode}${a.mode !== a.configuredMode ? ` (runs ${a.mode})` : ""}`
      : why === "params" ? ` (${paramsDiff(b.params, a.params)})`
      : why === "alerts" ? ` ${b.alerts ? "on" : "off"} → ${a.alerts ? "on" : "off"}`
      : why === "notifyPerHour" ? ` ${b.notifyPerHour} → ${a.notifyPerHour}`
      : "";
    lines.push(why === "mode" || why === "alerts" || why === "notifyPerHour" ? `${key}: ${why}${detail}` : `${key}: ${why} changed${detail}`);
  }
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `and ${lines.length - MAX_LINES + 1} more`] : lines;
}

// ---- editing heuristics.json in place ----

export interface JsonNode {
  start: number;
  /** One past the last character. */
  end: number;
  value?: unknown;
  members?: Array<{ key: string; keyStart: number; keyEnd: number; value: JsonNode }>;
  items?: JsonNode[];
}

/** Where each value of a JSON text is: enough to replace one and keep the rest as written. */
export function locateJson(text: string): JsonNode {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): JsonNode => {
    ws();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      const members: NonNullable<JsonNode["members"]> = [];
      for (ws(); text[i] !== "}"; ws()) {
        if (text[i] === ",") {
          i++;
          ws();
        }
        const keyStart = i;
        const key = string();
        const keyEnd = i;
        ws();
        i++; // :
        members.push({ key, keyStart, keyEnd, value: value() });
      }
      i++;
      return { start, end: i, members };
    }
    if (ch === "[") {
      i++;
      const items: JsonNode[] = [];
      for (ws(); text[i] !== "]"; ws()) {
        if (text[i] === ",") i++;
        else items.push(value());
      }
      i++;
      return { start, end: i, items };
    }
    if (ch === '"') return { start, value: string(), end: i };
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (m === null) throw new Error(`unexpected ${JSON.stringify(ch)} at ${i}`);
    i += m[0].length;
    return { start, end: i, value: JSON.parse(m[0]) };
  };
  return value();
}

/** heuristics.json's "instances" array, once the text is known to parse. */
function instancesArray(text: string): JsonNode & { items: JsonNode[] } {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`heuristics.json: unparseable JSON: ${(err as Error).message}`);
  }
  const list = locateJson(text).members?.find((m) => m.key === "instances")?.value;
  if (list?.items === undefined) throw new Error('heuristics.json: missing "instances" array');
  return list as JsonNode & { items: JsonNode[] };
}

/** The instance's object and its place in the array; -1 when there is none. */
function instanceIndex(list: JsonNode & { items: JsonNode[] }, key: string): number {
  const slash = key.indexOf("/");
  const [heuristic, id] = [key.slice(0, slash), key.slice(slash + 1)];
  return list.items.findIndex((o) => {
    const field = (k: string): unknown => o.members?.find((m) => m.key === k)?.value.value;
    return o.members !== undefined && field("heuristic") === heuristic && field("id") === id;
  });
}

/** The instance's object in heuristics.json's text, by key ("relay-pulse/gate"). */
export function findInstance(text: string, key: string): { start: number; end: number; members: NonNullable<JsonNode["members"]> } {
  const list = instancesArray(text);
  const o = list.items[instanceIndex(list, key)];
  if (o === undefined) throw new Error(`heuristics.json: no instance ${key}`);
  return { start: o.start, end: o.end, members: o.members! };
}

/**
 * heuristics.json's text with one instance's mode set, and nothing else changed: the
 * "mode" value is replaced, or, when the instance has none, added after its "id" in
 * the same layout (one line or one member per line).
 */
export function setInstanceMode(text: string, key: string, mode: Mode): string {
  const inst = findInstance(text, key);
  const value = JSON.stringify(mode);
  const current = inst.members.find((m) => m.key === "mode");
  if (current !== undefined) return text.slice(0, current.value.start) + value + text.slice(current.value.end);
  const id = inst.members.find((m) => m.key === "id")!;
  const colon = text.slice(id.keyEnd, id.value.start);
  const lineStart = text.lastIndexOf("\n", id.keyStart) + 1;
  const multiline = text.slice(inst.start, inst.end).includes("\n");
  const sep = multiline ? `,\n${text.slice(lineStart, id.keyStart).replace(/\S/g, " ")}` : ", ";
  return text.slice(0, id.value.end) + `${sep}"mode"${colon}${value}` + text.slice(id.value.end);
}

// Whole instances: added in the layout of the ones before them, changed value by value
// (a changed param replaces that param's value only, so the rest of a hand-written
// instance keeps its key order and line breaks), removed with their comma.

/** The instance fields the panel edits, in the order a new instance is written. */
export const INSTANCE_FIELDS = ["mode", "params", "alerts", "notifyPerHour", "commandHelp"] as const;

/** How the file is written: its indent ("" when it is one line) and whether a colon has a space after it. */
interface Layout {
  unit: string;
  spaced: boolean;
}

const MAX_WIDTH = 100;

const layoutOf = (text: string): Layout => ({ unit: /\n([ \t]+)"/.exec(text)?.[1] ?? "", spaced: /":\s/.test(text) });

/** The leading white space of the line `at` is on. */
const lineIndent = (text: string, at: number): string => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1))![0];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Equal as JSON, whatever the key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k]));
  }
  return a === b;
}

/** One line: `{ "a": 1, "b": [1, 2] }`, or `{"a":1}` in a file written without spaces. */
function flat(v: unknown, spaced: boolean): string {
  if (Array.isArray(v)) return `[${v.map((x) => flat(x, spaced)).join(spaced ? ", " : ",")}]`;
  if (isPlainObject(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return "{}";
    const body = entries.map(([k, x]) => `${JSON.stringify(k)}:${spaced ? " " : ""}${flat(x, spaced)}`).join(spaced ? ", " : ",");
    return spaced ? `{ ${body} }` : `{${body}}`;
  }
  return JSON.stringify(v);
}

/**
 * A value as the file would have it at this indent: on one line when that fits (and
 * always in a one-line file), else one member or item per line. `used`: the columns
 * before it on its line besides the indent (a key).
 */
function render(v: unknown, indent: string, layout: Layout, used = 0, expand = false): string {
  const one = flat(v, layout.spaced);
  const container = (Array.isArray(v) && v.length > 0) || (isPlainObject(v) && Object.values(v).some((x) => x !== undefined));
  if (layout.unit === "" || !container || (!expand && indent.length + used + one.length <= MAX_WIDTH)) return one;
  const inner = indent + layout.unit;
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + render(x, inner, layout)).join(",\n")}\n${indent}]`;
  const colon = layout.spaced ? ": " : ":";
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}${colon}${render(x, inner, layout, k.length + 3)}`).join(",\n")}\n${indent}}`;
}

/** The instance as written to the file: its fields in the usual order, an unset field left out. */
function instanceObject(c: InstanceConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { heuristic: c.heuristic, id: c.id };
  for (const f of INSTANCE_FIELDS) if (c[f] !== undefined) out[f] = c[f];
  return out;
}

/** The instance as heuristics.json's text has it; undefined when there is none. */
export function readInstance(text: string, key: string): InstanceConfig | undefined {
  const list = instancesArray(text);
  const o = list.items[instanceIndex(list, key)];
  return o === undefined ? undefined : (JSON.parse(text.slice(o.start, o.end)) as InstanceConfig);
}

/** The instances heuristics.json's text has, as written. */
export function readInstances(text: string): InstanceConfig[] {
  const list = instancesArray(text);
  return list.items.map((o) => JSON.parse(text.slice(o.start, o.end)) as InstanceConfig);
}

/** heuristics.json's text with an instance added after the last one, in their layout. */
export function addInstance(text: string, c: InstanceConfig): string {
  const list = instancesArray(text);
  const key = `${c.heuristic}/${c.id}`;
  if (instanceIndex(list, key) >= 0) throw new Error(`heuristics.json: there already is an instance ${key}`);
  const layout = layoutOf(text);
  const obj = instanceObject(c);
  const last = list.items.at(-1);
  if (last === undefined) {
    const outer = lineIndent(text, list.start);
    const inner = outer + layout.unit;
    const body = layout.unit === "" ? `[${flat(obj, layout.spaced)}]` : `[\n${inner}${render(obj, inner, layout, 0, true)}\n${outer}]`;
    return text.slice(0, list.start) + body + text.slice(list.end);
  }
  const before = text.slice(text.lastIndexOf("\n", last.start - 1) + 1, last.start);
  const ownLine = /^[ \t]*$/.test(before);
  const multiline = text.slice(last.start, last.end).includes("\n");
  const indent = ownLine ? before : lineIndent(text, last.start);
  const sep = ownLine ? `,\n${before}` : layout.spaced ? ", " : ",";
  const body = multiline ? render(obj, indent, layout, 0, true) : flat(obj, layout.spaced);
  return text.slice(0, last.end) + sep + body + text.slice(last.end);
}

/** heuristics.json's text without the instance, and the comma before (or after) it. */
export function removeInstance(text: string, key: string): string {
  const list = instancesArray(text);
  const i = instanceIndex(list, key);
  if (i < 0) throw new Error(`heuristics.json: no instance ${key}`);
  const items = list.items;
  if (items.length === 1) return text.slice(0, list.start) + "[]" + text.slice(list.end);
  return i > 0 ? text.slice(0, items[i - 1]!.end) + text.slice(items[i]!.end) : text.slice(0, items[0]!.start) + text.slice(items[1]!.start);
}

/** The object at `path` under the instance (an empty path: the instance itself). */
function objectAt(text: string, key: string, path: string[]): JsonNode {
  const list = instancesArray(text);
  let node = list.items[instanceIndex(list, key)];
  if (node === undefined) throw new Error(`heuristics.json: no instance ${key}`);
  for (const k of path) node = node.members!.find((m) => m.key === k)!.value;
  return node;
}

/**
 * Set the value at `path` under the instance (undefined: remove it). An object that
 * stays an object is changed member by member; anything else is replaced, as one line
 * when its object is on one line.
 */
function patch(text: string, key: string, path: string[], value: unknown): string {
  const parent = objectAt(text, key, path.slice(0, -1));
  const name = path.at(-1)!;
  const members = parent.members!;
  const i = members.findIndex((m) => m.key === name);
  const multiline = text.slice(parent.start, parent.end).includes("\n");
  const layout = multiline ? layoutOf(text) : { ...layoutOf(text), unit: "" };
  if (value === undefined) {
    if (i < 0) return text;
    if (members.length === 1) return text.slice(0, parent.start) + "{}" + text.slice(parent.end);
    return i > 0 ? text.slice(0, members[i - 1]!.value.end) + text.slice(members[i]!.value.end) : text.slice(0, members[0]!.keyStart) + text.slice(members[1]!.keyStart);
  }
  if (i < 0) {
    const last = members.at(-1);
    if (last === undefined) return text.slice(0, parent.start) + render({ [name]: value }, lineIndent(text, parent.start), layout) + text.slice(parent.end);
    const colon = text.slice(last.keyEnd, last.value.start);
    const lineStart = text.lastIndexOf("\n", last.keyStart - 1) + 1;
    // The column of the last key, so a key added to "a": 1, "b": 2 lines up under "a".
    const column = text.slice(lineStart, last.keyStart).replace(/\S/g, " ");
    const sep = multiline ? `,\n${column}` : layout.spaced ? ", " : ",";
    return text.slice(0, last.value.end) + `${sep}${JSON.stringify(name)}${colon}${render(value, column, layout, name.length + 3)}` + text.slice(last.value.end);
  }
  const node = members[i]!.value;
  const old: unknown = JSON.parse(text.slice(node.start, node.end));
  if (sameJson(old, value)) return text;
  if (isPlainObject(old) && isPlainObject(value)) {
    let out = text;
    for (const k of Object.keys(old)) if (value[k] === undefined) out = patch(out, key, [...path, k], undefined);
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out = patch(out, key, [...path, k], v);
    return out;
  }
  return text.slice(0, node.start) + render(value, lineIndent(text, node.start), layout, name.length + 3) + text.slice(node.end);
}

/** heuristics.json's text with one field of the instance set in place (undefined: removed), such as "twinOf". */
export function setInstanceField(text: string, key: string, field: string, value: unknown): string {
  return patch(text, key, [field], value);
}

/**
 * heuristics.json's text with the instance's mode, params, alerts, notifyPerHour and
 * commandHelp as given (an absent one removed; alerts false and an empty commandHelp
 * are absent too), each value changed in place. Its other keys stay.
 */
export function replaceInstance(text: string, key: string, fields: Partial<Pick<InstanceConfig, (typeof INSTANCE_FIELDS)[number]>>): string {
  const current = readInstance(text, key);
  if (current === undefined) throw new Error(`heuristics.json: no instance ${key}`);
  const want: Record<string, unknown> = {
    ...fields,
    // "alerts": false and "commandHelp": {} mean what their absence does: keep what is written.
    alerts: fields.alerts === true ? true : current.alerts === false ? false : undefined,
    commandHelp: fields.commandHelp !== undefined && Object.keys(fields.commandHelp).length > 0 ? fields.commandHelp : sameJson(current.commandHelp, {}) ? {} : undefined,
  };
  // A new mode goes after the id, where people look for it.
  let out = want.mode !== undefined && current.mode === undefined ? setInstanceMode(text, key, want.mode as Mode) : text;
  for (const f of INSTANCE_FIELDS) out = patch(out, key, [f], want[f]);
  return out;
}

/**
 * heuristics.json's text with a twin promoted: the original's instance removed, and the
 * twin in its place, under the original's id and mode, its own heuristic and params
 * kept and its "twinOf" gone. One edit, so it is one revision.
 */
export function promoteTwinText(text: string, twinKey: string): { text: string; original: string; promoted: string } {
  const twin = readInstance(text, twinKey);
  if (twin === undefined) throw new Error(`heuristics.json: no instance ${twinKey}`);
  if (typeof twin.twinOf !== "string") throw new Error(`${twinKey} is not a twin (it has no "twinOf")`);
  const original = readInstance(text, twin.twinOf);
  if (original === undefined) throw new Error(`heuristics.json: no instance ${twin.twinOf}, the original of ${twinKey}`);
  const promoted = `${twin.heuristic}/${original.id}`;
  let out = removeInstance(text, twin.twinOf);
  out = patch(out, twinKey, ["id"], original.id);
  out = setInstanceMode(out, promoted, original.mode ?? "shadow");
  out = patch(out, promoted, ["twinOf"], undefined);
  return { text: out, original: twin.twinOf, promoted };
}

/**
 * One line for the journal: "+door-nag/back (shadow)", "−door-nag/back",
 * "door-nag/back: mode shadow → active, params changed (everyMin 5 → 10)".
 */
export function describeEdit(key: string, before: InstanceConfig | undefined, after: InstanceConfig | undefined): string {
  if (before === undefined) return `+${key} (${after?.mode ?? "shadow"})`;
  if (after === undefined) return `−${key}`;
  const parts: string[] = [];
  if ((before.mode ?? "shadow") !== (after.mode ?? "shadow")) parts.push(`mode ${before.mode ?? "shadow"} → ${after.mode ?? "shadow"}`);
  if (!sameJson(before.params ?? {}, after.params ?? {})) parts.push(`params changed (${paramsDiff(before.params, after.params)})`);
  if ((before.alerts === true) !== (after.alerts === true)) parts.push(`alerts ${before.alerts === true ? "on" : "off"} → ${after.alerts === true ? "on" : "off"}`);
  if (before.notifyPerHour !== after.notifyPerHour) parts.push(`notifyPerHour ${shown(before.notifyPerHour)} → ${shown(after.notifyPerHour)}`);
  if (!sameJson(before.commandHelp ?? {}, after.commandHelp ?? {})) parts.push("commandHelp changed");
  return `${key}: ${parts.length > 0 ? parts.join(", ") : "unchanged"}`;
}

// ---- the panel's command ----

const MODES: Mode[] = ["off", "shadow", "active"];

/**
 * POST api/instances/<heuristic>/<id>/mode { mode }: through Home Assistant ingress
 * only. Rewrites the instance's mode in heuristics.json, reloads (all or nothing: a
 * rejected reload puts the file back) and journals the change with the HA user.
 */
export function mountInstanceMode(app: Hono, deps: { mode: "addon" | "standalone"; reloader: Reloader }): void {
  app.post("/api/instances/:heuristic/:id/mode", async (c) => {
    const peer = (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;
    if (!mayWrite(deps.mode, peer)) return c.json({ error: "Forbidden", reason: "modes are changed through the Home Assistant panel only" }, 403);
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null;
    if (!MODES.includes(body?.mode as Mode)) return c.json({ error: "BadRequest", reason: 'body: { "mode": "off" | "shadow" | "active" }' }, 400);
    const key = `${c.req.param("heuristic")}/${c.req.param("id")}`;
    try {
      const outcome = await deps.reloader.edit({
        file: "heuristics.json",
        by: requestUser((n) => c.req.header(n)),
        change: (text) => {
          if (text === undefined) throw new Error("no heuristics.json in the config folder");
          return setInstanceMode(text, key, body!.mode as Mode);
        },
      });
      return c.json(outcome, outcome.ok ? 200 : 422);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return c.json({ error: /no instance/.test(reason) ? "NotFound" : "BadRequest", reason }, /no instance/.test(reason) ? 404 : 400);
    }
  });
}
