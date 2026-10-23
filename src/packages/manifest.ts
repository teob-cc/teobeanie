// manifest.ts — a behaviour package's teobeanie.json: what the package is, which
// platform it runs on, and per heuristic it defines the roles its parameters play.
//
//   {
//     "name": "door-watch",
//     "version": "1.0.0",
//     "platform": ">=0.2.0 <1.0.0",
//     "title": "Door watch",
//     "description": "Reminders while a door stays open, and a notice when someone lingers.",
//     "pattern": "notice",
//     "heuristics": {
//       "door-nag": {
//         "pattern": "notice",
//         "roles": {
//           "door": { "domain": "binary_sensor", "device_class": ["door", "garage_door"] },
//           "quietWhileOn": { "domain": ["binary_sensor", "input_boolean"], "optional": true }
//         },
//         "uses": ["notify"]
//       }
//     }
//   }
//
// A role is one of the heuristic's entity parameters (params.ts) with hints for
// matching it to Home Assistant's registry: the domain, the device classes, whether it
// takes several entities, whether it may be left out, and whether the heuristic
// switches it (operate) or only reads it. The loader checks the roles against the
// parameter schema, so a later "suggest" can trust them. A path names a nested field
// with dots and a list's items with []: "rooms[].climate".

import type { AnyHeuristic, Pattern } from "../kernel/heuristic.js";
import type { ParamField, ParamSpec } from "../kernel/params.js";

/** The version of the "teobeanie" module (the SDK) a package's platform range is checked against: package.json's (a test keeps them equal). */
export const SDK_VERSION = "0.5.0";

export const MANIFEST = "teobeanie.json";

export const PATTERNS: readonly Pattern[] = ["momentary", "trigger", "hold", "button", "command", "notice", "guard"];

/** What a heuristic may rely on beyond its parameters (manifest "uses"). */
export const USES = ["notify", "commands", "triggers", "outdoor", "clock", "sun"] as const;
export type Use = (typeof USES)[number];

export interface Role {
  /** The Home Assistant domain(s) the entity is of: "binary_sensor", ["light", "switch"]. */
  domain: string | string[];
  /** The device classes that fit ("door", "motion"); absent: any. */
  device_class?: string | string[];
  /** Several entities (an entities param). Default false. */
  many?: boolean;
  /** The param may be left out. Default false. */
  optional?: boolean;
  /** The heuristic switches it (it must be operable in the house scope); false: it only reads it. */
  operate?: boolean;
  doc?: string;
}

export interface HeuristicManifest {
  title?: string;
  pattern?: Pattern;
  /** Param path → role. */
  roles?: Record<string, Role>;
  uses?: Use[];
}

export interface Manifest {
  name: string;
  version: string;
  /** A version range of the "teobeanie" module: ">=0.2.0 <1.0.0", "^0.2.0". */
  platform: string;
  title: string;
  description?: string;
  /** The package's main pattern, for the catalogue. */
  pattern?: Pattern;
  /** The module(s) that default-export its heuristics; absent: every top-level source file. */
  main?: string | string[];
  /** Heuristic id → what the package says about it. */
  heuristics: Record<string, HeuristicManifest>;
  /** Fact id → what the package says about it (a package may define facts, fact.ts). */
  facts?: Record<string, FactManifest>;
}

export interface FactManifest {
  title?: string;
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string | string[] => typeof v === "string" || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"));
const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---- versions ----

const parse = (v: string): [number, number, number] | undefined => {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
const cmp = (a: [number, number, number], b: [number, number, number]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether `version` is in `range`: comparators (>=, >, <=, <, =), ^x.y.z, ~x.y.z, x.y.z, *, joined by spaces (and) and || (or). */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (v === undefined) return false;
  return range.split("||").some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .filter((c) => c !== "")
      .every((c) => {
        if (c === "*") return true;
        const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(c)!;
        const b = parse(m[2]!);
        if (b === undefined) return false;
        const d = cmp(v, b);
        switch (m[1]) {
          case "^":
            return d >= 0 && (b[0] > 0 ? v[0] === b[0] : b[1] > 0 ? v[0] === 0 && v[1] === b[1] : v[0] === 0 && v[1] === 0 && v[2] === b[2]);
          case "~":
            return d >= 0 && v[0] === b[0] && v[1] === b[1];
          case ">=":
            return d >= 0;
          case "<=":
            return d <= 0;
          case ">":
            return d > 0;
          case "<":
            return d < 0;
          default:
            return d === 0;
        }
      }),
  );
}

/** Whether a range is well-formed (each comparator names a version). */
export function isRange(range: string): boolean {
  const ok = (c: string) => c === "*" || parse(/^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(c)?.[2] ?? "") !== undefined;
  return range.trim() !== "" && range.split("||").every((alt) => alt.trim().split(/\s+/).every(ok));
}

// ---- the manifest ----

function checkRole(path: string, r: unknown, out: string[]): void {
  const at = `roles.${path}`;
  if (!isObject(r)) return void out.push(`${at}: expected an object { domain, device_class?, many?, optional?, operate? }`);
  for (const k of Object.keys(r)) {
    if (!["domain", "device_class", "many", "optional", "operate", "doc"].includes(k)) out.push(`${at}.${k}: unknown`);
  }
  if (!strings(r["domain"])) out.push(`${at}.domain: expected a domain or a list of them`);
  if (r["device_class"] !== undefined && !strings(r["device_class"])) out.push(`${at}.device_class: expected a device class or a list of them`);
  for (const k of ["many", "optional", "operate"]) {
    if (r[k] !== undefined && typeof r[k] !== "boolean") out.push(`${at}.${k}: expected true or false`);
  }
  if (r["doc"] !== undefined && typeof r["doc"] !== "string") out.push(`${at}.doc: expected a string`);
}

/** What is wrong with a parsed teobeanie.json, one line per problem; none: it is a manifest. */
export function manifestProblems(m: unknown, folder?: string): string[] {
  const out: string[] = [];
  if (!isObject(m)) return ["expected an object"];
  const known = ["name", "version", "platform", "title", "description", "pattern", "main", "heuristics", "facts"];
  for (const k of Object.keys(m)) if (!known.includes(k) && !k.startsWith("$")) out.push(`${k}: unknown, expected one of ${known.join(", ")}`);
  if (typeof m["name"] !== "string" || !KEBAB.test(m["name"])) out.push("name: expected a kebab-case name");
  else if (folder !== undefined && m["name"] !== folder) out.push(`name: "${m["name"]}" is not the folder's name (${folder})`);
  if (typeof m["version"] !== "string" || parse(m["version"]) === undefined) out.push('version: expected "major.minor.patch"');
  if (typeof m["platform"] !== "string" || !isRange(m["platform"])) out.push('platform: expected a version range of the "teobeanie" module, e.g. ">=0.2.0 <1.0.0"');
  if (typeof m["title"] !== "string" || m["title"].trim() === "") out.push("title: expected a string");
  if (m["description"] !== undefined && typeof m["description"] !== "string") out.push("description: expected a string");
  if (m["pattern"] !== undefined && !PATTERNS.includes(m["pattern"] as Pattern)) out.push(`pattern: expected one of ${PATTERNS.join(", ")}`);
  if (m["main"] !== undefined && !strings(m["main"])) out.push("main: expected a file name or a list of them");
  const fs = m["facts"];
  if (fs !== undefined) {
    if (!isObject(fs)) out.push("facts: expected an object with an entry per fact id");
    else
      for (const [id, f] of Object.entries(fs)) {
        if (!KEBAB.test(id)) out.push(`facts.${id}: the id must be kebab-case`);
        if (!isObject(f)) out.push(`facts.${id}: expected an object { title? }`);
        else {
          for (const k of Object.keys(f)) if (k !== "title") out.push(`facts.${id}.${k}: unknown`);
          if (f["title"] !== undefined && typeof f["title"] !== "string") out.push(`facts.${id}.title: expected a string`);
        }
      }
  }
  const hs = m["heuristics"];
  // A package of facts only may name no heuristics.
  if (!isObject(hs) || (Object.keys(hs).length === 0 && !(isObject(fs) && Object.keys(fs).length > 0))) {
    out.push("heuristics: expected an object with an entry per heuristic id");
    return out;
  }
  for (const [id, h] of Object.entries(hs)) {
    const at = `heuristics.${id}`;
    if (!KEBAB.test(id)) out.push(`${at}: the id must be kebab-case`);
    if (!isObject(h)) {
      out.push(`${at}: expected an object { title?, pattern?, roles?, uses? }`);
      continue;
    }
    for (const k of Object.keys(h)) if (!["title", "pattern", "roles", "uses"].includes(k)) out.push(`${at}.${k}: unknown`);
    if (h["title"] !== undefined && typeof h["title"] !== "string") out.push(`${at}.title: expected a string`);
    if (h["pattern"] !== undefined && !PATTERNS.includes(h["pattern"] as Pattern)) out.push(`${at}.pattern: expected one of ${PATTERNS.join(", ")}`);
    if (h["uses"] !== undefined && !(Array.isArray(h["uses"]) && h["uses"].every((u) => (USES as readonly unknown[]).includes(u)))) {
      out.push(`${at}.uses: expected a list of ${USES.join(", ")}`);
    }
    if (h["roles"] !== undefined) {
      if (!isObject(h["roles"])) out.push(`${at}.roles: expected an object, param path → role`);
      else {
        const problems: string[] = [];
        for (const [path, r] of Object.entries(h["roles"])) checkRole(path, r, problems);
        out.push(...problems.map((p) => `${at}.${p}`));
      }
    }
  }
  return out;
}

/** A parsed teobeanie.json, checked; throws with every problem. */
export function parseManifest(json: unknown, folder?: string): Manifest {
  const problems = manifestProblems(json, folder);
  if (problems.length > 0) throw new Error(`${MANIFEST}: ${problems.join("; ")}`);
  return json as Manifest;
}

// ---- roles against the parameter schema ----

/** What a role path names in a schema: the field, and the role's shape there. */
export interface RoleShape {
  field: ParamSpec;
  /** Several entities: an entities param, or one inside a list. */
  many: boolean;
  /** It may be left out: the field, or one it is inside, is optional. */
  optional: boolean;
}

/** What a role path names in a schema, or why it names nothing. */
export function resolveRole(spec: ParamSpec, path: string): RoleShape | string {
  let at: ParamSpec = spec;
  let many = false;
  let optional = false;
  for (const seg of path.split(".")) {
    const name = seg.endsWith("[]") ? seg.slice(0, -2) : seg;
    const fields: ParamField[] =
      at.kind === "oneOf" ? (at.alternatives ?? []).flatMap((a) => a.fields ?? []) : at.kind === "object" || at.kind === "texts" ? (at.fields ?? []) : [];
    const f = fields.find((x) => x.name === name);
    if (f === undefined) return `no param ${path}`;
    at = f;
    if (!f.required) optional = true;
    if (seg.endsWith("[]")) {
      if (at.kind !== "list" || at.item === undefined) return `${name} is not a list`;
      at = at.item;
      many = true;
    }
  }
  return { field: at, many: many || at.kind === "entities", optional };
}

/** Every entity parameter of a schema, by role path ("lights", "rooms[].climate"). */
export function entityPaths(spec: ParamSpec | undefined, prefix = ""): string[] {
  if (spec === undefined) return [];
  const walk = (fields: ParamField[]): string[] =>
    fields.flatMap((f) => {
      const p = `${prefix}${f.name}`;
      if (f.kind === "entity" || f.kind === "entities") return [p];
      if (f.kind === "object") return entityPaths(f, `${p}.`);
      if (f.kind === "oneOf") return entityPaths(f, `${p}.`);
      if (f.kind === "list" && f.item !== undefined) {
        if (f.item.kind === "entity" || f.item.kind === "entities") return [`${p}[]`];
        return entityPaths(f.item, `${p}[].`);
      }
      return [];
    });
  if (spec.kind === "oneOf") return [...new Set((spec.alternatives ?? []).flatMap((a) => walk(a.fields ?? [])))];
  return walk(spec.fields ?? []);
}

/**
 * What is wrong with a heuristic's manifest entry against the definition itself: its
 * pattern, its uses, and each role against the parameter schema (an entity param,
 * many for a list of entities, optional for one that may be left out, a domain the
 * schema accepts).
 */
export function checkAgainstDefinition(def: AnyHeuristic, h: HeuristicManifest): string[] {
  const out: string[] = [];
  if (h.pattern !== undefined && def.pattern !== undefined && h.pattern !== def.pattern) out.push(`pattern: "${h.pattern}", the heuristic says "${def.pattern}"`);
  const uses = new Set(h.uses ?? []);
  if (def.usesOutdoor === true && !uses.has("outdoor")) out.push('uses: it reads the outdoor conditions, add "outdoor"');
  if (def.usesOutdoor !== true && uses.has("outdoor")) out.push('uses: "outdoor", but it does not read the outdoor conditions');
  if (def.commands !== undefined && !uses.has("commands")) out.push('uses: it answers commands, add "commands"');
  if (def.commands === undefined && uses.has("commands")) out.push('uses: "commands", but it answers none');
  if (def.triggers !== undefined && !uses.has("triggers")) out.push('uses: it declares triggers, add "triggers"');
  if (def.triggers === undefined && uses.has("triggers")) out.push('uses: "triggers", but it declares none');
  const roles = Object.entries(h.roles ?? {});
  if (roles.length > 0 && def.params === undefined) return [...out, "roles: the heuristic has no parameter schema to check them against"];
  for (const [path, r] of roles) {
    const shape = resolveRole(def.params!.spec, path);
    if (typeof shape === "string") {
      out.push(`roles.${path}: ${shape}`);
      continue;
    }
    const f = shape.field;
    if (f.kind !== "entity" && f.kind !== "entities") {
      out.push(`roles.${path}: not an entity param (${f.kind})`);
      continue;
    }
    if ((r.many ?? false) !== shape.many) out.push(`roles.${path}: ${shape.many ? "takes several entities: many must be true" : "takes one entity: many must be false"}`);
    if ((r.optional ?? false) !== shape.optional) out.push(`roles.${path}: ${shape.optional ? "may be left out: optional must be true" : "is required: optional must be false"}`);
    const bad = f.domains === undefined ? [] : list(r.domain).filter((d) => !f.domains!.includes(d));
    if (bad.length > 0) out.push(`roles.${path}: domain ${bad.join(", ")} is not one the param takes (${f.domains!.join(", ")})`);
  }
  return out;
}
