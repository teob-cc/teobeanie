// rule.ts — desired-state rules. A rule is a pure function from the observed house
// (and time) to the state its entities should be in:
//
//   export default rule("hallway-light", ({ ha, held }) => {
//     const motion = ha.binary_sensor.hallway_motion;
//     return ha.light.hallway.to(motion.is("on") ? "on" : held(() => motion.is("off"), minutes(5)) ? "off" : keep);
//   });
//
// rule() compiles to an ordinary HeuristicDef, so rules run on the same kernel as
// deciders: journaled decisions, shadow mode, the SafeActuator, the simulator. The
// kernel re-evaluates the rule on every change of an entity it watches and when a
// time condition can flip, and sends calls only when an entity's desired value
// changes — a person who overrides a device is not fought until the rule changes its
// mind. Reasons are derived from the predicates the evaluation took.
//
// Types: with a generated ha.d.ts (the house's entities and their states) every
// entity id, state and desired value is checked; without one, everything is a string.

import { houseZone, localMinutes, parseHhMm } from "./clock.js";
import type { Action, AnyHeuristic, Card, DecideCtx, Decision, HouseFacts, Json, Observed, Outdoor, Pattern, TimerOp, Value, ViewCtx } from "./heuristic.js";
import { cancelTimer, outdoorEntities, readOutdoor, setTimer } from "./heuristic.js";
import type { Schema } from "./params.js";

// ---- the house, as types ----

declare global {
  /**
   * Entity id → its possible states. Empty here; the generated ha.d.ts fills it in
   * (`declare global { interface TeobHouse { "light.hallway": "on" | "off"; ... } }`).
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TeobHouse {}
  /**
   * The entities Teobeanie may operate ("operate": true in allowlist.json). Empty here; the
   * generated ha.d.ts fills it in next to TeobHouse.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TeobOperable {}
  /**
   * Fact id → the type of its value. Empty here; the generated ha.d.ts fills it in from
   * the facts the config folder defines (fact.ts).
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TeobFacts {}
}

type Known = keyof TeobHouse & string;
/** An entity id of this house (any string while the house is untyped). */
export type EntityId = [Known] extends [never] ? string : Known;
type Unavailable = "unavailable" | "unknown";
export type StatesOf<Id extends string> = Id extends keyof TeobHouse ? TeobHouse[Id] & string : string;
type Operable = keyof TeobOperable & string;
/** What `.to()` accepts: a desired value, but only within the operation scope of a typed house. */
export type ToArg<Id extends string> = [Known] extends [never]
  ? DesiredFor<Id> | Keep | Release
  : Id extends Operable
    ? DesiredFor<Id> | Keep | Release
    : `${Id} is outside the operation scope: mark it "operate" in allowlist.json`;

type OnOff = "on" | "off";

export interface LightAttributes {
  brightness_pct?: number;
  brightness?: number;
  color_temp_kelvin?: number;
  rgb_color?: [number, number, number];
  hs_color?: [number, number];
  xy_color?: [number, number];
  effect?: string;
  transition?: number;
}

/** A desired value of any entity, as journaled. */
export type Desired = string | number | { [attr: string]: Json };

/** What an entity can be told, by domain. */
export type DesiredFor<Id extends string> = string extends Id
  ? Desired
  : Id extends `light.${string}`
    ? OnOff | ({ state?: OnOff } & LightAttributes)
    : Id extends `fan.${string}`
      ? OnOff | { state?: OnOff; percentage?: number; preset_mode?: string }
      : Id extends `${"switch" | "input_boolean" | "media_player" | "humidifier" | "siren" | "remote"}.${string}`
        ? OnOff
        : Id extends `${"cover" | "valve"}.${string}`
          ? "open" | "closed" | { position: number }
          : Id extends `lock.${string}`
            ? "locked" | "unlocked"
            : Id extends `climate.${string}`
              ? StatesOf<Id> | { hvac_mode?: StatesOf<Id>; temperature?: number; target_temp_low?: number; target_temp_high?: number }
              : Id extends `${"number" | "input_number"}.${string}`
                ? number
                : Id extends `${"select" | "input_select"}.${string}`
                  ? StatesOf<Id>
                  : never;

// ---- authoring surface ----

/** "No opinion right now": the entity keeps whatever it was last told. */
export const keep: unique symbol = Symbol.for("teob.keep");
export type Keep = typeof keep;

/**
 * "No opinion any more": forget the last desired value without touching the entity,
 * so the next answer counts as new even when it is the same (a setpoint applied each
 * time heating starts).
 */
export const release: unique symbol = Symbol.for("teob.release");
export type Release = typeof release;

const WANT: unique symbol = Symbol.for("teob.want");
/** One entity's desired value, as returned by `entity.to(value)`. */
export interface Want {
  readonly [WANT]: true;
  readonly entity: string;
  readonly value: Desired | Keep | Release;
}

/** A handle on one HA entity. Reading it records the read. */
export interface Entity<Id extends string = string> {
  readonly id: Id;
  /** Raw HA state string, undefined when the entity does not exist. */
  readonly state: StatesOf<Id> | Unavailable | undefined;
  /** Normalized value: on/open/home → true, off/closed → false, numbers parsed, unavailable → null. */
  readonly value: Value | undefined;
  /** last_changed, ms epoch (0 when unknown). */
  readonly since: number;
  is(...states: Array<StatesOf<Id> | Unavailable>): boolean;
  above(n: number): boolean;
  below(n: number): boolean;
  attr(name: string): unknown;
  /** The state this entity should be in, or `keep`. */
  to(value: ToArg<Id>): Want;
  toString(): string;
}

type DomainOf<Id> = Id extends `${infer D}.${string}` ? D : never;
type ObjectIdOf<Id, D extends string> = Id extends `${D}.${infer O}` ? O : never;

/** A handle on one fact (fact.ts). Reading it records the read. */
export interface Fact<T = Json> {
  /** The name it was read by: the fact's id, or its camelCase or snake_case form. */
  readonly id: string;
  /** Its value now; undefined while it has none (unknown, or left out by the loader). */
  readonly value: T | undefined;
  /** When it took this value, ms epoch (0 when unknown). */
  readonly since: number;
  is(...values: T[]): boolean;
  toString(): string;
}

type KnownFact = keyof TeobFacts & string;
type CamelOf<S extends string> = S extends `${infer H}-${infer R}` ? `${H}${Capitalize<CamelOf<R>>}` : S;
type SnakeOf<S extends string> = S extends `${infer H}-${infer R}` ? `${H}_${SnakeOf<R>}` : S;
/** A fact id of this house (any string while it has no typed facts). */
export type FactId = [KnownFact] extends [never] ? string : KnownFact;
/** The type of a fact's value: from ha.d.ts, else any JSON value. */
export type FactValueOf<Id extends string> = Id extends KnownFact ? TeobFacts[Id] : Json;
/** ha.facts.<id>: each fact by its camelCase and its snake_case name. */
export type Facts = [KnownFact] extends [never]
  ? Record<string, Fact>
  : { readonly [K in KnownFact as CamelOf<K> | SnakeOf<K>]: Fact<TeobFacts[K]> };

/** ha.light.hallway → the Entity "light.hallway"; ha.facts.<name> → a fact. A misspelled id is a type error. */
export type Ha = ([Known] extends [never]
  ? Record<string, Record<string, Entity>>
  : { readonly [D in DomainOf<Known>]: { readonly [O in ObjectIdOf<Known, D>]: Entity<`${D}.${O}`> } }) & { readonly facts: Facts };

export interface Sun {
  readonly belowHorizon: boolean;
  readonly elevation: number | undefined;
}

export interface World {
  ha: Ha;
  entity<Id extends EntityId>(id: Id): Entity<Id>;
  /** True once cond() has been continuously true for ms. */
  held(cond: () => boolean, ms: number): boolean;
  /** True while cond() is true and for ms after it last was. */
  within(cond: () => boolean, ms: number): boolean;
  /** Local house time between two "HH:MM" clock times (wraps midnight). */
  between(from: string, to: string): boolean;
  readonly sun: Sun;
  /** Outdoor temperature, humidity and wind, from the sources in allowlist.json "outdoor". */
  readonly outdoor: Outdoor;
  keep: Keep;
}

export interface RuleOptions<P> {
  title?: string;
  description?: string;
  /** What it promises the people in the house (HeuristicDef.guarantees). */
  guarantees?: string;
  /** The parameters an instance takes (params.ts); none: any. */
  params?: Schema<P>;
  /** Entities whose changes re-evaluate the rule, in addition to those found in its source and first evaluation. */
  watch?(params: P): string[];
  /** Entities the rule may set, in addition to those its first evaluation returns. */
  owns?(params: P): string[];
  /**
   * Keep the entities where the rule wants them: when one drifts (a person, another
   * automation, the device), set it back. Default: the person wins, and the rule only
   * acts when its own answer changes. graceSec is the least time between two sends to
   * one entity (default 60), so a device that is slow to report is not sent twice.
   * With yieldToUsers, a change made through HA by a user (a person, an app, another
   * automation) is left alone until the rule's answer changes; only the device's own
   * drift is set back.
   */
  enforce?(params: P): boolean | { graceSec?: number; yieldToUsers?: boolean };
  /**
   * When an answer changes to what an entity already is, record it without a call, on
   * every change (by default only at start). For switches and lights only the on/off
   * state counts: a light someone already switched on keeps the brightness they chose.
   */
  settle?(params: P): boolean;
  /** Entities whose attribute changes re-evaluate the rule (sun.sun for its elevation). */
  watchAttributes?(params: P): string[];
  /** The meta control pattern this rule implements. */
  pattern?: Pattern;
  /** The instance's card on the House page (HeuristicDef.view): from what the rule wants, by entity. */
  view?(state: { desired: Readonly<Record<string, Json>> }, ctx: ViewCtx<P>): Card | undefined;
}

export type RuleFn<P> = (w: World, params: P) => Want | ReadonlyArray<Want | undefined> | undefined;

// ---- journal shapes ----

/** held/within bookkeeping: whether a condition holds, and since when it did or did not. */
export interface Track {
  on: boolean;
  at: number;
}

export interface RuleState {
  desired: Record<string, Json>;
  /** When each entity was last sent its desired value (enforcing rules only). */
  sent?: Record<string, number>;
  /** Entities a user changed away from the desired value: left alone until the answer changes (yieldToUsers). */
  yielded?: Record<string, string>;
  /** held/within bookkeeping: when each tracked condition last changed. */
  track: Record<string, Track>;
  /** Entities read but not watched, already reported. */
  unwatched: string[];
}

export type RuleEvent =
  | { tag: "DesiredChanged"; entity: string; from: Json; to: Json; at?: number }
  /** An enforcing rule set an entity back to its desired value after it drifted. */
  | { tag: "Reasserted"; entity: string; to: Json; was: string; at: number }
  /** An enforcing rule left an entity a user changed (user null: back at the desired value, enforced again). */
  | { tag: "Yielded"; entity: string; user: string | null }
  | { tag: "Tracked"; set: Record<string, Track>; clear: string[] }
  | { tag: "UnwatchedRead"; entities: string[] };

/** The timer a rule is re-evaluated on when a time condition can flip. */
export const EVAL = "eval";

// ---- entity handles ----

/** A fact as a decision reads it: its value and since when it holds. */
export interface FactReading {
  value: Json;
  since: number;
}

/** What an evaluation (of a rule or a fact) sees and records. */
export interface Scope {
  now: number;
  house: HouseFacts;
  get(id: string): Observed | undefined;
  /** A fact by id or name; undefined when it has no value. */
  fact(name: string): FactReading | undefined;
  /** Predicate results in evaluation order: the branch the rule took. */
  trace: string[];
  /** Entities read (in order of first read). */
  reads: Set<string>;
  /** Facts read, by the name they were read with. */
  factReads: Set<string>;
  /** Earliest future time a time condition can flip. */
  wakes: number[];
  track: Record<string, Track>;
  touched: Map<string, Track | null>;
}

const short = (id: string): string => id.slice(id.indexOf(".") + 1);

function entityHandle(scope: () => Scope, id: string): Entity<string> {
  const read = (): Observed | undefined => {
    const s = scope();
    s.reads.add(id);
    return s.get(id);
  };
  const pred = (label: string, result: boolean): boolean => {
    scope().trace.push(`${short(id)} ${label}${result ? "" : " ✗"}`);
    return result;
  };
  return {
    id,
    get state() {
      return read()?.state;
    },
    get value() {
      return read()?.value;
    },
    get since() {
      return read()?.since ?? 0;
    },
    is: (...states) => {
      const o = read();
      return pred(`is ${states.join("|")}`, o !== undefined && states.includes(o.state));
    },
    above: (n) => {
      const v = read()?.value;
      return pred(`> ${n}`, typeof v === "number" && v > n);
    },
    below: (n) => {
      const v = read()?.value;
      return pred(`< ${n}`, typeof v === "number" && v < n);
    },
    attr: (name) => read()?.attributes[name],
    to: (value) => ({ [WANT]: true, entity: id, value: value as Desired | Keep | Release }),
    toString: () => id,
  };
}

/** A fact's name as kebab-case, for a reason: nobodyNear and nobody_near read "nobody-near". */
export const factLabel = (name: string): string => name.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const fmtJson = (v: Json | undefined): string => (typeof v === "string" ? v : JSON.stringify(v ?? null));

function factHandle(scope: () => Scope, name: string): Fact {
  const read = (): FactReading | undefined => {
    const s = scope();
    s.factReads.add(name);
    return s.fact(name);
  };
  return {
    id: name,
    get value() {
      return read()?.value;
    },
    get since() {
      return read()?.since ?? 0;
    },
    is: (...values) => {
      const r = read();
      const ok = r !== undefined && values.some((v) => sameJson(v, r.value));
      scope().trace.push(`${factLabel(name)} is ${values.map(fmtJson).join("|")}${ok ? "" : " ✗"}`);
      return ok;
    },
    toString: () => name,
  };
}

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

function haProxy(scope: () => Scope): { ha: Ha; entity: (id: string) => Entity } {
  const handles = new Map<string, Entity>();
  const entity = (id: string): Entity => {
    if (!ENTITY_ID.test(id)) throw new Error(`not an entity id: ${JSON.stringify(id)}`);
    let h = handles.get(id);
    if (h === undefined) handles.set(id, (h = entityHandle(scope, id)));
    return h;
  };
  const domains = new Map<string, Record<string, Entity>>();
  const factHandles = new Map<string, Fact>();
  const facts = new Proxy({} as Record<string, Fact>, {
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      let h = factHandles.get(name);
      if (h === undefined) factHandles.set(name, (h = factHandle(scope, name)));
      return h;
    },
  });
  const ha = new Proxy({} as Ha, {
    get(_t, domain) {
      if (typeof domain !== "string") return undefined;
      if (domain === "facts") return facts;
      let d = domains.get(domain);
      if (d === undefined) {
        d = new Proxy({} as Record<string, Entity>, {
          get: (_u, objectId) => (typeof objectId === "string" ? entity(`${domain}.${objectId}`) : undefined),
        });
        domains.set(domain, d);
      }
      return d;
    },
  });
  return { ha, entity };
}

/** Entity ids written as ha.domain.object_id or ha.domain["object_id"] in a rule's source. */
export function entitiesInSource(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bha\.([a-z_]+)\.([a-z0-9_]+)\b/g)) if (m[1] !== "facts") out.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/\bha\.([a-z_]+)\[\s*["']([a-z0-9_]+)["']\s*\]/g)) if (m[1] !== "facts") out.add(`${m[1]}.${m[2]}`);
  return [...out];
}

/** Fact names written as ha.facts.name or ha.facts["name"] in a rule's or a fact's source. */
export function factsInSource(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bha\.facts\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\bha\.facts\[\s*["']([A-Za-z0-9_-]+)["']\s*\]/g)) out.add(m[1]!);
  return [...out];
}

// ---- time conditions ----

/** FNV-1a, enough to key a condition by its source text and the entities it read. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const fmtMs = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

/**
 * Evaluate cond() in a sub-scope: its predicates form one label, its reads count as
 * the rule's reads, and the latest last_changed among them bounds when it last flipped.
 */
function sub(s: Scope, cond: () => boolean): { value: boolean; label: string; changedAt: number; key: string } {
  const outer = s.trace;
  const inner: string[] = [];
  s.trace = inner;
  const readsHere = new Set<string>();
  const factsHere = new Set<string>();
  const get = s.get;
  const fact = s.fact;
  s.get = (id) => {
    readsHere.add(id);
    return get(id);
  };
  s.fact = (name) => {
    factsHere.add(name);
    return fact(name);
  };
  let value: boolean;
  try {
    value = Boolean(cond());
  } finally {
    s.trace = outer;
    s.get = get;
    s.fact = fact;
  }
  const facts = [...factsHere].sort();
  const ids = [...readsHere].sort();
  const changedAt = Math.min(s.now, Math.max(0, ...ids.map((id) => get(id)?.since ?? 0), ...facts.map((f) => fact(f)?.since ?? 0)));
  return { value, label: inner.map(asFact).join(" & ") || "condition", changedAt, key: hash(`${cond.toString()}|${[...ids, ...facts.map((f) => `fact:${f}`)].join(",")}`) };
}

/**
 * A predicate's trace line as the fact it found: "door is on ✗" (the predicate was
 * false) reads "door is not on". A condition's label is the facts it saw, so
 * held(() => !motion.is("on")) is labelled "motion is not on", not "motion is on".
 */
function asFact(line: string): string {
  if (!line.endsWith(" ✗")) return line;
  const l = line.slice(0, -2);
  const m = /^(.*) (is|>|<|between) (.*)$/.exec(l);
  if (m === null) return `not (${l})`;
  const [, subject, op, rest] = m;
  const neg = { is: "is not", ">": "≤", "<": "≥", between: "not between" }[op as "is" | ">" | "<" | "between"];
  return `${subject} ${neg} ${rest}`;
}

function held(s: Scope, cond: () => boolean, ms: number): boolean {
  const c = sub(s, cond);
  const key = `held:${c.key}`;
  const prev = s.track[key];
  if (!c.value) {
    s.touched.set(key, null);
    s.trace.push(`${c.label} for ${fmtMs(ms)} ✗`);
    return false;
  }
  const since = prev?.on ? prev.at : c.changedAt;
  s.touched.set(key, { on: true, at: since });
  const ok = s.now - since >= ms;
  if (!ok) s.wakes.push(since + ms);
  s.trace.push(`${c.label} for ${fmtMs(ms)}${ok ? "" : " ✗"}`);
  return ok;
}

function within(s: Scope, cond: () => boolean, ms: number): boolean {
  const c = sub(s, cond);
  const key = `within:${c.key}`;
  const prev = s.track[key];
  if (c.value) {
    s.touched.set(key, { on: true, at: prev?.on ? prev.at : c.changedAt });
    s.trace.push(`${c.label} (within ${fmtMs(ms)})`);
    return true;
  }
  // Fell since the last evaluation: it was true until its inputs last changed. The
  // tracking is journaled, so this holds across restarts (a fall while the add-on was
  // down is dated by last_changed). Never seen true: false.
  const fell = prev === undefined ? undefined : prev.on ? c.changedAt : prev.at;
  const ok = fell !== undefined && s.now - fell < ms;
  s.touched.set(key, ok ? { on: false, at: fell! } : null);
  if (ok) s.wakes.push(fell! + ms);
  s.trace.push(`${c.label} within ${fmtMs(ms)}${ok ? "" : " ✗"}`);
  return ok;
}

function between(s: Scope, from: string, to: string): boolean {
  const a = parseHhMm(from);
  const b = parseHhMm(to);
  const m = localMinutes(s.now, houseZone(s.house));
  const inside = a <= b ? m >= a && m < b : m >= a || m < b;
  // Next boundary, at the start of that minute; DST shifts are corrected on the next evaluation.
  const minuteStart = s.now - (s.now % 60_000);
  const until = (t: number): number => ((t - m + 1440) % 1440 || 1440) * 60_000;
  s.wakes.push(minuteStart + Math.min(until(a), until(b)));
  s.trace.push(`between ${from}–${to}${inside ? "" : " ✗"}`);
  return inside;
}

// ---- desired state → service calls ----

const ON_OFF = new Set(["light", "switch", "fan", "input_boolean", "media_player", "humidifier", "siren", "remote"]);

const stateOf = (d: Json): string | undefined =>
  typeof d === "string" ? d : typeof d === "object" && d !== null && !Array.isArray(d) && typeof d["state"] === "string" ? d["state"] : undefined;

const attrsOf = (d: Json): Record<string, Json> => {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return {};
  const { state: _s, ...rest } = d;
  return rest;
};

const sameJson = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The calls that take an entity from desired value `from` to `to`. */
export function actionsFor(entity: string, from: Json | undefined, to: Json): Action[] {
  const domain = entity.slice(0, entity.indexOf("."));
  const call = (service: string, data?: Record<string, Json>): Action =>
    data !== undefined && Object.keys(data).length > 0
      ? { kind: "call", service: `${domain}.${service}`, entities: [entity], data }
      : { kind: "call", service: `${domain}.${service}`, entities: [entity] };
  const st = stateOf(to);
  const attrs = attrsOf(to);

  if (ON_OFF.has(domain)) {
    const on = st === undefined ? Object.keys(attrs).length > 0 : st === "on";
    if (st !== undefined && st !== "on" && st !== "off") throw new Error(`${entity}: desired state must be "on" or "off", got "${st}"`);
    if (!on) return [call("turn_off")];
    // Still on: only the attributes that changed.
    const prev = attrsOf(from ?? null);
    const wasOn = from !== undefined && (stateOf(from) ?? "on") === "on";
    const changed = wasOn ? Object.fromEntries(Object.entries(attrs).filter(([k, v]) => !sameJson(prev[k], v))) : attrs;
    return [call("turn_on", changed)];
  }
  switch (domain) {
    case "cover":
      if (st === "open") return [call("open_cover")];
      if (st === "closed") return [call("close_cover")];
      if (typeof attrs["position"] === "number") return [call("set_cover_position", { position: attrs["position"] })];
      break;
    case "valve":
      if (st === "open") return [call("open_valve")];
      if (st === "closed") return [call("close_valve")];
      if (typeof attrs["position"] === "number") return [call("set_valve_position", { position: attrs["position"] })];
      break;
    case "lock":
      if (st === "locked") return [call("lock")];
      if (st === "unlocked") return [call("unlock")];
      break;
    case "climate": {
      const out: Action[] = [];
      const mode = st ?? (typeof attrs["hvac_mode"] === "string" ? attrs["hvac_mode"] : undefined);
      if (mode !== undefined && mode !== (stateOf(from ?? null) ?? attrsOf(from ?? null)["hvac_mode"])) out.push(call("set_hvac_mode", { hvac_mode: mode }));
      const { hvac_mode: _m, ...rest } = attrs;
      const prev = attrsOf(from ?? null);
      const changed = Object.fromEntries(Object.entries(rest).filter(([k, v]) => !sameJson(prev[k], v)));
      if (Object.keys(changed).length > 0) out.push(call("set_temperature", changed));
      return out;
    }
    case "number":
    case "input_number":
      if (typeof to === "number") return [call("set_value", { value: to })];
      break;
    case "select":
    case "input_select":
      if (typeof to === "string") return [call("select_option", { option: to })];
      break;
  }
  throw new Error(`${entity}: no way to reach desired ${JSON.stringify(to)}`);
}

/**
 * Whether an entity already is in a desired state: to reconcile at start, and to see
 * drift when enforcing. An attribute HA does not report (brightness_pct, transition)
 * cannot be checked and counts as matching.
 */
function already(o: Observed | undefined, to: Json): boolean {
  if (o === undefined) return false;
  if (typeof to === "number") return Number(o.state) === to;
  const st = stateOf(to);
  if (st !== undefined && o.state !== st) return false;
  if (st === "off" || st === "closed") return true;
  for (const [k, v] of Object.entries(attrsOf(to))) {
    if (k === "hvac_mode") {
      if (o.state !== v) return false;
      continue;
    }
    const actual = o.attributes[k === "position" ? "current_position" : k];
    if (actual === undefined) continue;
    if (typeof v === "number" ? Number(actual) !== v || actual === null : !sameJson(actual as Json, v)) return false;
  }
  return true;
}

/** already(), but a switch or light that is on counts as matching whatever attributes it has. */
function alreadyState(entity: string, o: Observed | undefined, to: Json): boolean {
  if (o === undefined || !ON_OFF.has(entity.slice(0, entity.indexOf(".")))) return already(o, to);
  const st = stateOf(to) ?? (Object.keys(attrsOf(to)).length > 0 ? "on" : undefined);
  return st !== undefined && o.state === st;
}

const fmtDesired = (d: Json): string => (typeof d === "string" ? d : JSON.stringify(d));

/** What differs between an entity and a desired value, for the why. */
function describeDrift(o: Observed, to: Json): string {
  const st = stateOf(to);
  if (st !== undefined && o.state !== st) return `is ${o.state}`;
  const diffs = Object.entries(attrsOf(to))
    .filter(([k, v]) => k !== "hvac_mode" && o.attributes[k === "position" ? "current_position" : k] !== v)
    .map(([k]) => `${k} ${String(o.attributes[k === "position" ? "current_position" : k])}`);
  return diffs.join(", ") || `is ${o.state}`;
}

/** The (entity, value) pairs a rule returned: one Want, or an array (undefined entries skipped). */
function wantsOf(rule: string, result: unknown): Array<[string, Desired | Keep | Release]> {
  const list = result === undefined ? [] : Array.isArray(result) ? result : [result];
  const out = new Map<string, Desired | Keep | Release>();
  for (const w of list) {
    if (w === undefined) continue;
    if (typeof w !== "object" || w === null || (w as Want)[WANT] !== true) {
      throw new Error(`rule ${rule} must return entity.to(value), or an array of them`);
    }
    const { entity, value } = w as Want;
    if (out.has(entity)) throw new Error(`rule ${rule} returned two values for ${entity}`);
    out.set(entity, value);
  }
  return [...out];
}

/**
 * A rule's state as recovered: a snapshot taken while the instance was still a
 * hand-written decider (the same id, before it became a rule) has another shape.
 */
function asRuleState(state: unknown): RuleState {
  const s = (typeof state === "object" && state !== null ? state : {}) as Partial<RuleState>;
  return {
    desired: s.desired ?? {},
    track: s.track ?? {},
    unwatched: s.unwatched ?? [],
    ...(s.sent !== undefined ? { sent: s.sent } : {}),
    ...(s.yielded !== undefined ? { yielded: s.yielded } : {}),
  };
}

// ---- rule() → HeuristicDef ----

/**
 * The World a rule or a fact is evaluated against, reading through `scope()`: the
 * scope of the evaluation running now (an error outside one).
 */
export function createWorld(scope: () => Scope): World {
  const { ha, entity } = haProxy(scope);
  return {
    ha,
    entity: entity as World["entity"],
    held: (cond, ms) => held(scope(), cond, ms),
    within: (cond, ms) => within(scope(), cond, ms),
    between: (from, to) => between(scope(), from, to),
    // Each reading is read when used (inside held() it counts as that condition's input),
    // so destructuring ({ outdoor }) is fine.
    outdoor: Object.defineProperties(
      {},
      Object.fromEntries(
        (["temperature", "humidity", "windSpeed", "windGust", "windBearing", "condition"] as const).map((k) => [
          k,
          {
            enumerable: true,
            get: () => {
              const s = scope();
              return readOutdoor((e) => {
                s.reads.add(e);
                return s.get(e);
              }, s.house.outdoor)[k];
            },
          },
        ]),
      ),
    ) as Outdoor,
    sun: {
      get belowHorizon() {
        return entity("sun.sun").is("below_horizon");
      },
      get elevation() {
        const e = entity("sun.sun").attr("elevation");
        return typeof e === "number" ? e : undefined;
      },
    },
    keep,
  };
}

/** A fresh evaluation scope. */
export function newScope(now: number, house: HouseFacts, get: Scope["get"], fact: Scope["fact"], track: Record<string, Track>): Scope {
  return { now, house, get, fact, trace: [], reads: new Set(), factReads: new Set(), wakes: [], track, touched: new Map() };
}

/** held/within bookkeeping after an evaluation: touched conditions update, untouched ones are forgotten. */
export function trackChanges(track: Record<string, Track>, touched: Scope["touched"]): { set: Record<string, Track>; clear: string[] } {
  const set: Record<string, Track> = {};
  const clear: string[] = [];
  for (const [k, t] of touched) {
    if (t === null) {
      if (track[k] !== undefined) clear.push(k);
    } else if (!sameJson(track[k] as unknown as Json, t as unknown as Json)) set[k] = t;
  }
  for (const k of Object.keys(track)) if (!touched.has(k)) clear.push(k);
  return { set, clear };
}

export function rule<P = void>(id: string, fn: RuleFn<P>, opts: RuleOptions<P> = {}): AnyHeuristic {
  let current: Scope | undefined;
  const scope = (): Scope => {
    if (current === undefined) throw new Error(`rule ${id}: entities can only be read while the rule evaluates`);
    return current;
  };
  const world = createWorld(scope);

  const evaluate = (params: P, now: number, get: Scope["get"], track: Record<string, Track>, house: HouseFacts = {}, fact: Scope["fact"] = () => undefined) => {
    const s = newScope(now, house, get, fact, track);
    current = s;
    try {
      return { result: fn(world, params), scope: s };
    } finally {
      current = undefined;
    }
  };

  // A first evaluation over an empty house tells which entities the rule sets and reads.
  const probes = new Map<unknown, { owns: string[]; reads: string[]; facts: string[] }>();
  const probe = (params: P) => {
    let p = probes.get(params);
    if (p === undefined) {
      const { result, scope: s } = evaluate(params, 0, () => undefined, {});
      p = { owns: wantsOf(id, result).map(([e]) => e), reads: [...s.reads], facts: [...s.factReads] };
      probes.set(params, p);
    }
    return p;
  };
  const source = fn.toString();
  const sourceIds = entitiesInSource(source);
  const sourceFacts = factsInSource(source);
  const usesOutdoor = /\boutdoor\b/.test(source);
  const enforcing = (params: P): { graceMs: number; yieldToUsers: boolean } | undefined => {
    const e = opts.enforce?.(params);
    return e === undefined || e === false
      ? undefined
      : { graceMs: (e === true ? 60 : (e.graceSec ?? 60)) * 1000, yieldToUsers: e !== true && e.yieldToUsers === true };
  };
  const settling = (params: P): boolean => opts.settle?.(params) === true;
  // Owned ids in the source are usually just the targets of .to(); an owned entity the
  // rule actually reads is watched through the probe (re-evaluating sends nothing new).
  const watchOf = (params: P): string[] => {
    const owned = new Set(owns(params));
    const scanned = sourceIds.filter((e) => !owned.has(e));
    // An enforcing rule watches what it owns, to see it drift.
    const drift = enforcing(params) ? [...owned] : [];
    return [...new Set([...(opts.watch?.(params) ?? []), ...scanned, ...probe(params).reads, ...drift])];
  };
  const owns = (params: P): string[] => [...new Set([...probe(params).owns, ...(opts.owns?.(params) ?? [])])];

  return {
    id,
    kind: "rule",
    ...(opts.pattern !== undefined ? { pattern: opts.pattern } : {}),
    ...(usesOutdoor ? { usesOutdoor: true } : {}),
    watchAttributes: (params: P) => [...new Set([...(enforcing(params) ? owns(params) : []), ...(opts.watchAttributes?.(params) ?? [])])],
    title: opts.title ?? id,
    description: opts.description ?? "Desired-state rule",
    ...(opts.guarantees !== undefined ? { guarantees: opts.guarantees } : {}),
    ...(opts.params !== undefined ? { params: opts.params } : {}),
    watch: watchOf,
    // Facts read: woken by their changes as by a watched entity's.
    facts: (params: P) => [...new Set([...sourceFacts, ...probe(params).facts])],
    actuates: owns,
    ...(opts.view !== undefined ? { view: (state: RuleState, ctx: ViewCtx<P>) => opts.view!({ desired: asRuleState(state).desired }, ctx) } : {}),
    initial: (): RuleState => ({ desired: {}, track: {}, unwatched: [] }),

    decide(recovered: RuleState, input, ctx: DecideCtx<P>): Decision<RuleEvent> | undefined {
      if (input.kind === "outcome") return undefined;
      const state = asRuleState(recovered);
      const { result, scope: s } = evaluate(ctx.params, ctx.now, (e) => ctx.get(e), state.track, ctx.house, (name) => (ctx.fact as (n: string) => FactReading | undefined)(name));
      const enforce = enforcing(ctx.params);

      const events: RuleEvent[] = [];
      const actions: Action[] = [];
      const changes: string[] = [];
      const settled: string[] = [];
      for (const [entityId, value] of wantsOf(id, result)) {
        if (value === keep) continue;
        const from = state.desired[entityId];
        if (value === release) {
          if (from !== undefined && from !== null) events.push({ tag: "DesiredChanged", entity: entityId, from, to: null });
          continue;
        }
        const to = value as Json;
        if (sameJson(from, to)) {
          // Unchanged answer: an enforcing rule sets a drifted entity back.
          if (enforce === undefined) continue;
          const o = ctx.get(entityId);
          if (o === undefined || o.state === "unavailable" || o.state === "unknown") continue;
          const yieldedTo = state.yielded?.[entityId];
          if (already(o, to)) {
            if (yieldedTo !== undefined) events.push({ tag: "Yielded", entity: entityId, user: null });
            continue;
          }
          if (yieldedTo !== undefined) continue;
          // A user changed it through HA: theirs until the answer changes.
          if (enforce.yieldToUsers && input.kind === "signal" && input.entity === entityId && input.user !== undefined) {
            events.push({ tag: "Yielded", entity: entityId, user: input.user });
            changes.push(`${short(entityId)} left at ${describeDrift(o, to)} (changed by a user)`);
            continue;
          }
          const last = state.sent?.[entityId] ?? 0;
          if (ctx.now - last < enforce.graceMs) {
            s.wakes.push(last + enforce.graceMs);
            continue;
          }
          events.push({ tag: "Reasserted", entity: entityId, to, was: o.state, at: ctx.now });
          actions.push(...actionsFor(entityId, undefined, to));
          changes.push(`${short(entityId)} back to ${fmtDesired(to)} (drifted: ${describeDrift(o, to)})`);
          continue;
        }
        // First opinion on an entity at start, or any new answer of a settling rule: leave
        // it alone when it already is there.
        const settles = settling(ctx.params);
        if (
          (settles && alreadyState(entityId, ctx.get(entityId), to)) ||
          (input.kind === "start" && from === undefined && already(ctx.get(entityId), to))
        ) {
          events.push({ tag: "DesiredChanged", entity: entityId, from: null, to });
          settled.push(`${short(entityId)} already ${fmtDesired(to)}`);
          continue;
        }
        events.push({ tag: "DesiredChanged", entity: entityId, from: from ?? null, to, ...(enforce !== undefined ? { at: ctx.now } : {}) });
        actions.push(...actionsFor(entityId, from, to));
        changes.push(`${short(entityId)} → ${fmtDesired(to)}`);
      }

      // held/within bookkeeping: touched conditions update, untouched ones are forgotten.
      const { set, clear } = trackChanges(state.track, s.touched);
      if (Object.keys(set).length > 0 || clear.length > 0) events.push({ tag: "Tracked", set, clear });

      const watched = new Set([...watchOf(ctx.params), ...(usesOutdoor ? outdoorEntities(ctx.house.outdoor) : [])]);
      const stray = [...s.reads].filter((e) => !watched.has(e) && !state.unwatched.includes(e));
      if (stray.length > 0) events.push({ tag: "UnwatchedRead", entities: stray });

      // One timer: the earliest moment a time condition can flip.
      const timers: TimerOp[] = [];
      const wake = s.wakes.filter((t) => t > ctx.now).reduce((a, b) => Math.min(a, b), Infinity);
      const armed = input.kind === "timer" && input.timer === EVAL ? undefined : ctx.timer(EVAL);
      if (wake !== Infinity && wake !== armed) timers.push(setTimer(EVAL, wake));
      else if (wake === Infinity && armed !== undefined) timers.push(cancelTimer(EVAL));

      if (events.length === 0 && timers.length === 0) return undefined;
      const because = s.trace.join(", ");
      const head =
        changes.length + settled.length > 0 ? [...changes, ...settled].join(", ") : timers.some((t) => t.op === "set") ? "waiting" : "no change";
      return { why: because ? `${head} · ${because}` : head, events, actions, timers };
    },

    evolve(recovered: RuleState, event: RuleEvent): RuleState {
      const state = asRuleState(recovered);
      switch (event.tag) {
        case "DesiredChanged": {
          const next: RuleState = {
            ...state,
            desired: { ...state.desired, [event.entity]: event.to },
            ...(event.at !== undefined ? { sent: { ...state.sent, [event.entity]: event.at } } : {}),
          };
          // A new answer: a user's earlier change no longer stands.
          if (next.yielded?.[event.entity] !== undefined) {
            const { [event.entity]: _, ...rest } = next.yielded;
            next.yielded = rest;
          }
          return next;
        }
        case "Yielded": {
          const { [event.entity]: _, ...rest } = state.yielded ?? {};
          return { ...state, yielded: event.user === null ? rest : { ...rest, [event.entity]: event.user } };
        }
        case "Reasserted":
          return { ...state, sent: { ...state.sent, [event.entity]: event.at } };
        case "Tracked": {
          const track = { ...state.track, ...event.set };
          for (const k of event.clear) delete track[k];
          return { ...state, track };
        }
        case "UnwatchedRead":
          return { ...state, unwatched: [...state.unwatched, ...event.entities] };
        default:
          // Events of a heuristic this rule replaced, in an older journal.
          return state;
      }
    },
  };
}
