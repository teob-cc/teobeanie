// params.ts — a heuristic's parameters, described once. The same schema is what the
// loader checks an instance's params against, what the panel renders an instance
// editor from (describeParams), and, through Infer, the TypeScript type the heuristic
// is written against, so the three cannot drift:
//
//   const PARAMS = param.object({
//     door: param.entity().doc("The door contact: on = open."),
//     everyMin: param.duration("min", { positive: true }).doc("Minutes between reminders."),
//     text: param.text().doc("The reminder."),
//     quietWhileOn: param.entity().optional().doc("Skip a reminder while this entity is on."),
//   });
//   export type DoorNagParams = Infer<typeof PARAMS>;
//
// Underneath, a schema is plain JSON (ParamSpec), and checkParams works on that alone,
// so the panel can run the very check the loader does from the description.
//
// A schema describes; it does not fill in. A default is what the heuristic's code uses
// when the param is absent, shown to whoever edits the instance.

import type { Json } from "./heuristic.js";

export type ParamKind =
  | "entity"
  | "entities"
  | "number"
  | "duration"
  | "bool"
  | "time"
  /** A message people read (the editor offers a text area; a translation replaces it). */
  | "text"
  /** A heuristic's messages, each optional, with English defaults. */
  | "texts"
  /** Any other string: a command name, a room, an MQTT topic. */
  | "string"
  | "strings"
  /** A desired value: a state ("on", "heat") or attributes ({ "temperature": 21 }). */
  | "value"
  | "object"
  | "list"
  /** One of several objects, told apart by their keys. */
  | "oneOf";

export type DurationUnit = "ms" | "s" | "min" | "h";

/** One parameter as JSON: what the instance editor and the catalogue render. */
export interface ParamSpec {
  kind: ParamKind;
  /** False: params may leave it out (the heuristic has a default, or does without). */
  required: boolean;
  doc?: string;
  /** What the heuristic uses when it is left out. */
  default?: Json;
  /** entity, entities: the domains accepted; absent: any. */
  domains?: string[];
  /** number: what it is measured in ("%", "lx", "°"); duration: ms, s, min or h. */
  unit?: string;
  /** number, duration: inclusive bounds; positive: above 0. */
  min?: number;
  max?: number;
  positive?: boolean;
  integer?: boolean;
  /** time: "HH:MM:SS" is accepted as well as "HH:MM". */
  seconds?: boolean;
  /** A text's {slots}, as its default fills them in. */
  slots?: string[];
  /** object, texts: the fields. */
  fields?: ParamField[];
  /** list: what each item is. */
  item?: ParamSpec;
  /** oneOf: the alternatives by name, each an object. */
  alternatives?: ParamField[];
}

export interface ParamField extends ParamSpec {
  name: string;
}

/**
 * A parameter's schema: its spec, and at the type level the value it takes (T) and
 * whether params must have it (R). Each method returns a new schema.
 */
export interface Schema<T = unknown, R extends boolean = boolean> {
  readonly spec: ParamSpec;
  /** Type level only. */
  readonly __type?: T;
  readonly __required?: R;
  doc(text: string): Schema<T, R>;
  optional(): Schema<T, false>;
  /** Optional, and what the heuristic uses when it is left out. */
  default(value: T): Schema<T, false>;
}

/** The TypeScript type of the values a schema accepts. */
export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;

type Shape = Record<string, Schema<unknown, boolean>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ObjectOf<S extends Shape> = Simplify<
  { [K in keyof S as S[K] extends Schema<unknown, true> ? K : never]: Infer<S[K]> } & {
    [K in keyof S as S[K] extends Schema<unknown, true> ? never : K]?: Infer<S[K]>;
  }
>;

function make<T, R extends boolean>(spec: ParamSpec): Schema<T, R> {
  return {
    spec,
    doc: (doc) => make({ ...spec, doc }),
    optional: () => make({ ...spec, required: false }),
    default: (value) => make({ ...spec, required: false, default: value as Json }),
  };
}

const fieldsOf = (shape: Shape): ParamField[] => Object.entries(shape).map(([name, s]) => ({ name, ...s.spec }));
const withDomains = (spec: ParamSpec, domains: string[]): ParamSpec => (domains.length > 0 ? { ...spec, domains } : spec);
const slotsOf = (text: string): string[] => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))];

/** The schema vocabulary. */
export const param = {
  /** An entity id, of one of these domains (none: any). */
  entity: (...domains: string[]) => make<string, true>(withDomains({ kind: "entity", required: true }, domains)),
  entities: (...domains: string[]) => make<string[], true>(withDomains({ kind: "entities", required: true }, domains)),
  number: (o: { unit?: string; min?: number; max?: number; positive?: boolean; integer?: boolean } = {}) =>
    make<number, true>({ kind: "number", required: true, ...o }),
  /** A length of time as a number in `unit` (never below 0). */
  duration: (unit: DurationUnit, o: { min?: number; max?: number; positive?: boolean; integer?: boolean } = {}) =>
    make<number, true>({ kind: "duration", required: true, unit, ...o }),
  bool: () => make<boolean, true>({ kind: "bool", required: true }),
  /** A house-local clock time, "HH:MM" ("24:00" is the end of the day); with seconds, "HH:MM:SS" too. */
  time: (o: { seconds?: boolean } = {}) => make<string, true>({ kind: "time", required: true, ...(o.seconds ? { seconds: true } : {}) }),
  text: () => make<string, true>({ kind: "text", required: true }),
  /** Messages by key, each optional: `defaults` are the English ones, `docs` say what each is for. */
  texts: <T extends { [K in keyof T]: string }>(defaults: T, docs: Partial<Record<keyof T, string>> = {}) =>
    make<Partial<T>, false>({
      kind: "texts",
      required: false,
      fields: Object.entries<string>(defaults).map(([name, text]) => {
        const slots = slotsOf(text);
        const doc = (docs as Record<string, string | undefined>)[name];
        return { name, kind: "text", required: false, default: text, ...(doc !== undefined ? { doc } : {}), ...(slots.length > 0 ? { slots } : {}) };
      }),
    }),
  string: () => make<string, true>({ kind: "string", required: true }),
  strings: () => make<string[], true>({ kind: "strings", required: true }),
  value: <T = Json>() => make<T, true>({ kind: "value", required: true }),
  object: <S extends Shape>(shape: S) => make<ObjectOf<S>, true>({ kind: "object", required: true, fields: fieldsOf(shape) }),
  list: <S extends Schema<unknown, boolean>>(item: S) => make<Array<Infer<S>>, true>({ kind: "list", required: true, item: item.spec }),
  /** One of several objects, by name; told apart by their keys. */
  oneOf: <S extends Record<string, Schema<object, boolean>>>(alternatives: S) =>
    make<Infer<S[keyof S]>, true>({ kind: "oneOf", required: true, alternatives: fieldsOf(alternatives) }),
};

// ---- checking ----

const UNIT: Record<string, string> = { ms: "milliseconds", s: "seconds", min: "minutes", h: "hours" };
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const TIME = /^(([01]?\d|2[0-3]):[0-5]\d|24:00)$/;
const TIME_S = /^(([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?|24:00(:00)?)$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function bounds(s: ParamSpec, floor?: number): string {
  const min = s.min ?? floor;
  return [s.positive ? "> 0" : min !== undefined ? `≥ ${min}` : "", s.max !== undefined ? `≤ ${s.max}` : ""].filter((x) => x !== "").join(", ");
}

/** What a value of this spec looks like, for a problem's "expected ...". */
export function expected(s: ParamSpec): string {
  const of = s.domains !== undefined ? ` of domain ${s.domains.join(" or ")}` : "";
  const num = (floor?: number) => {
    const b = bounds(s, floor);
    return `${s.integer ? "a whole number" : "a number"}${b !== "" ? ` ${b}` : ""}`;
  };
  switch (s.kind) {
    case "entity":
      return `an entity id${of}`;
    case "entities":
      return `a list of entity ids${of}`;
    case "number":
      return `${num()}${s.unit !== undefined ? ` (${s.unit})` : ""}`;
    case "duration":
      return `${UNIT[s.unit ?? ""] ?? s.unit}: ${num(0)}`;
    case "bool":
      return "true or false";
    case "time":
      return s.seconds ? 'a time "HH:MM" or "HH:MM:SS"' : 'a time "HH:MM"';
    case "text":
    case "string":
      return "a string";
    case "strings":
      return "a list of strings";
    case "texts":
      return `an object of texts (${(s.fields ?? []).map((f) => f.name).join(", ")})`;
    case "value":
      return "a state or attributes (a string, a number or an object)";
    case "object":
      return `an object {${(s.fields ?? []).map((f) => f.name).join(", ")}}`;
    case "list":
      return `a list of ${expected(s.item ?? { kind: "value", required: true })}`;
    case "oneOf":
      return `one of ${(s.alternatives ?? []).map((a) => `${a.name} {${(a.fields ?? []).map((f) => f.name).join(", ")}}`).join(", ")}`;
  }
}

const shown = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

function check(s: ParamSpec, v: unknown, path: string, out: string[]): void {
  const bad = () => out.push(`${path}: expected ${expected(s)}, got ${shown(v)}`);
  const numberOk = (n: unknown, floor?: number): boolean => {
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
    const min = s.min ?? floor;
    return !(s.integer && !Number.isInteger(n)) && !(s.positive && n <= 0) && !(min !== undefined && n < min) && !(s.max !== undefined && n > s.max);
  };
  const entityOk = (e: unknown): boolean =>
    typeof e === "string" && ENTITY_ID.test(e) && (s.domains === undefined || s.domains.includes(e.slice(0, e.indexOf("."))));
  switch (s.kind) {
    case "entity":
      if (!entityOk(v)) bad();
      return;
    case "entities":
      if (!Array.isArray(v)) return void bad();
      v.forEach((e, i) => {
        if (!entityOk(e)) out.push(`${path}[${i}]: expected ${expected({ ...s, kind: "entity" })}, got ${shown(e)}`);
      });
      return;
    case "number":
      if (!numberOk(v)) bad();
      return;
    case "duration":
      if (!numberOk(v, 0)) bad();
      return;
    case "bool":
      if (typeof v !== "boolean") bad();
      return;
    case "time":
      if (typeof v !== "string" || !(s.seconds ? TIME_S : TIME).test(v)) bad();
      return;
    case "text":
    case "string":
      if (typeof v !== "string") bad();
      return;
    case "strings":
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad();
      return;
    case "value":
      if (!(typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || isObject(v))) bad();
      return;
    case "list":
      if (!Array.isArray(v)) return void bad();
      v.forEach((x, i) => check(s.item!, x, `${path}[${i}]`, out));
      return;
    case "texts":
    case "object":
      if (!isObject(v)) return void bad();
      checkFields(s.fields ?? [], v, path, out);
      return;
    case "oneOf": {
      if (!isObject(v)) return void bad();
      const alternatives = s.alternatives ?? [];
      const tried = alternatives.map((a) => {
        const problems: string[] = [];
        checkFields(a.fields ?? [], v, path, problems);
        return { problems, shared: (a.fields ?? []).filter((f) => f.name in v).length };
      });
      if (tried.some((t) => t.problems.length === 0)) return;
      // The alternative the value has most keys of is the one meant: its problems.
      const best = tried.reduce((a, b) => (b.shared > a.shared ? b : a), { problems: [] as string[], shared: 0 });
      if (best.shared > 0) out.push(...best.problems);
      else bad();
      return;
    }
  }
}

function checkFields(fields: ParamField[], v: Record<string, unknown>, path: string, out: string[]): void {
  const known = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(v)) {
    if (!known.has(k)) out.push(`${path}.${k}: unknown, expected one of ${[...known].join(", ")}`);
  }
  for (const f of fields) {
    const x = v[f.name];
    if (x === undefined) {
      if (f.required) out.push(`${path}.${f.name}: missing, expected ${expected(f)}`);
      continue;
    }
    check(f, x, `${path}.${f.name}`, out);
  }
}

/** What is wrong with these params against a spec, one line per problem (path, then what was expected); none: they fit. */
export function checkParams(spec: ParamSpec, params: unknown): string[] {
  const out: string[] = [];
  // No params at all reads as {}: the problems then name what is missing.
  check(spec, params ?? {}, "params", out);
  return out;
}

/** An instance's params checked against its heuristic's schema; a heuristic without one takes anything. */
export function validateParams(def: { params?: Schema }, params: unknown): string[] {
  return def.params === undefined ? [] : checkParams(def.params.spec, params);
}

/** A heuristic's parameters as JSON (each a ParamField), for the panel and the catalogue; undefined: it has no schema. */
export function describeParams(def: { params?: Schema }): ParamField[] | undefined {
  return def.params?.spec.fields;
}
