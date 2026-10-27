// heuristic.ts — the authoring surface. A heuristic is a pure decider + evolver over
// its own state; everything it wants done (domain facts, HA service calls,
// notifications, timers) comes back as DATA. The kernel (aggregate.ts) journals it,
// arms the timers durably, and hands the actions to the SafeActuator.
//
// Determinism rule: decide() never reads the wall clock or HA directly. Time is
// ctx.now (stamped on the input), the world is ctx.get() (read at decision time, and
// every read is journaled with the decision), so a recorded run replays to identical
// decisions.

import type { Schema } from "./params.js";
import type { FactId, FactValueOf } from "./rule.js";

export type Value = number | string | boolean | null;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** An HA entity as a heuristic sees it: normalized value + raw state + last_changed. */
export interface Observed {
  /** on/open/home → true, off/closed → false, numbers parsed, unavailable/unknown → null. */
  value: Value;
  /** The raw HA state string. */
  state: string;
  /** last_changed, ms epoch. */
  since: number;
  attributes: Record<string, unknown>;
}

export type Input =
  /** Boot (or instance enabled): reconcile with the current snapshot. */
  | { kind: "start"; at: number }
  /** A watched entity changed (on-change routed signal; obsId points into signals.db). */
  | {
      kind: "signal";
      at: number;
      obsId: string;
      entity: string;
      value: Value;
      state: string;
      origin: string;
      /** The HA user whose call made this change (context.user_id); absent when the device or its cloud changed it. */
      user?: string;
    }
  /** A timer this instance set came due. */
  | { kind: "timer"; at: number; timer: string; data?: Json }
  /** A fact this instance reads (HeuristicDef.facts) changed: its new value, since when, and the FactChanged event. */
  | { kind: "fact"; at: number; fact: string; value: Json; since: number; eventId: string }
  /** A declared HA trigger (time, sun, ...) fired. */
  | { kind: "trigger"; at: number; trigger: string; data: Record<string, unknown> }
  /** An action this instance requested completed (active mode only). */
  | { kind: "outcome"; at: number; actionId: string; action: Action; ok: boolean; error?: string; haContextId?: string }
  /** A named command this instance answers to (from Telegram, the panel, ...). */
  | {
      kind: "command";
      at: number;
      command: string;
      args: string[];
      from: CommandSource;
      /** Every answering instance's commandArg(s) for this command, sorted: the first arguments someone answers for. */
      choices?: string[];
    };

/** Who sent a command, and through which channel. */
export interface CommandSource {
  channel: string;
  user?: string;
  /** What the command came from, when that is journaled elsewhere: "voice:<id>" (a voice message). */
  ref?: string;
}

/** Where the house's outdoor conditions come from (allowlist.json "outdoor"). */
export interface OutdoorSources {
  /** A weather.* entity: its attributes give whatever no sensor below measures (and wind). */
  weather?: string;
  /** Sensors measuring outdoors, preferred over the weather entity's values. */
  temperature?: string;
  humidity?: string;
  wind?: string;
}

/** Facts about the house a decision may use, beyond its own parameters. */
export interface HouseFacts {
  outdoor?: OutdoorSources;
  /** The house's IANA time zone (HA's configuration, or the time_zone option); absent: UTC (clock.ts houseZone). */
  timeZone?: string;
  /**
   * The SafeActuator's bounds: the code's, then the house's own (allowlist.json "bounds"),
   * which can only narrow them, since every bound that matches must pass.
   */
  bounds?: HouseBound[];
}

/** A service-data field's range for the entities with an id prefix ("climate.", "temperature"). */
export interface HouseBound {
  entityPrefix: string;
  field: string;
  min: number;
  max: number;
}

/** The range every matching bound allows for an entity's field: the narrowest; undefined when none applies. */
export function boundFor(house: HouseFacts, entity: string, field: string): { min: number; max: number } | undefined {
  let out: { min: number; max: number } | undefined;
  for (const b of house.bounds ?? []) {
    if (b.field !== field || !entity.startsWith(b.entityPrefix)) continue;
    out = out === undefined ? { min: b.min, max: b.max } : { min: Math.max(out.min, b.min), max: Math.min(out.max, b.max) };
  }
  return out;
}

// ---- typed commands: what a voice (or a form) may fill in ----

/** One argument of a command, in the order the command takes them. */
export type CommandArgSpec =
  /** One of a few words: a room, home or away. Instances sharing the command merge their choices. */
  | { name: string; kind: "choice"; choices: string[]; doc?: string; optional?: boolean }
  /** A number, sent as written ("21.5"); min and max are what the instance accepts. */
  | {
      name: string;
      kind: "number";
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      /** Words the argument may be instead of a number: "off" ends what the number started. */
      or?: string[];
      doc?: string;
      optional?: boolean;
    }
  /** A duration, sent as "2h" or "90m" (parseDuration); absent: defaultMin. */
  | { name: string; kind: "duration"; maxMin?: number; defaultMin?: number; doc?: string; optional?: boolean };

/** A command as a typed call: what it does and its arguments. */
export interface CommandSchema {
  /** One or two sentences, generic and in English: what the command does. */
  doc: string;
  args: CommandArgSpec[];
}

/** "2h", "90m", "1.5 h", "2" (hours) → ms; anything else (or ≤ 0) → undefined. */
export function parseDuration(text: string | undefined): number | undefined {
  const m = text?.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(h|m|min)?$/);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return m[2] === "m" || m[2] === "min" ? Math.round(n * 60_000) : Math.round(n * 3_600_000);
}

/** ms → "2h" (whole hours) or "90m": what parseDuration reads back. */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min % 60 === 0 ? `${min / 60}h` : `${min}m`;
}

/** Outdoor conditions now. Undefined where no source gives a value. */
export interface Outdoor {
  /** °C */
  temperature?: number;
  /** % */
  humidity?: number;
  /** In the weather entity's unit (usually km/h). */
  windSpeed?: number;
  windGust?: number;
  /** Degrees, where the wind comes from. */
  windBearing?: number;
  /** The weather entity's state: sunny, rainy, partlycloudy, ... */
  condition?: string;
}

/** The entities the outdoor conditions are read from. */
export const outdoorEntities = (o: OutdoorSources | undefined): string[] =>
  o === undefined ? [] : [...new Set([o.weather, o.temperature, o.humidity, o.wind].filter((e): e is string => e !== undefined))];

/** Weather-entity attributes that are outdoor readings: a change of one is a signal. */
export const OUTDOOR_ATTRIBUTES = ["temperature", "humidity", "wind_speed", "wind_gust_speed", "wind_bearing"] as const;

/** Read the outdoor conditions through a lookup (every read journaled by the caller). */
export function readOutdoor(get: (entity: string) => Observed | undefined, o: OutdoorSources | undefined): Outdoor {
  if (o === undefined) return {};
  const w = o.weather === undefined ? undefined : get(o.weather);
  const attr = (k: string): number | undefined => {
    const v = w?.attributes[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const sensor = (e: string | undefined): number | undefined => {
    const v = e === undefined ? undefined : get(e)?.value;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const out: Outdoor = {};
  const set = <K extends keyof Outdoor>(k: K, v: Outdoor[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("temperature", sensor(o.temperature) ?? attr("temperature"));
  set("humidity", sensor(o.humidity) ?? attr("humidity"));
  set("windSpeed", sensor(o.wind) ?? attr("wind_speed"));
  set("windGust", attr("wind_gust_speed"));
  set("windBearing", attr("wind_bearing"));
  if (w !== undefined && w.state !== "unavailable" && w.state !== "unknown") out.condition = w.state;
  return out;
}

export type Action =
  | { kind: "call"; service: string; entities: string[]; data?: Record<string, Json> }
  /**
   * reply: decided on a command, so an answer to whoever asked (set by the kernel). info: nothing
   * to act on, a report (set by the heuristic). Neither is copied to the alerts chat.
   */
  | { kind: "notify"; channel: "telegram"; text: string; reply?: true; info?: true };

export type TimerOp =
  | { op: "set"; timer: string; at: number; data?: Json }
  | { op: "cancel"; timer: string };

/**
 * What decide() returns. undefined = nothing to say (not journaled). A why with no
 * effects is a journaled "declined" — the answer to "why didn't it ...?".
 */
export interface Decision<E> {
  /** One line for the timeline: why this decision was taken. */
  why?: string;
  events?: E[];
  actions?: Action[];
  timers?: TimerOp[];
}

export interface DecideCtx<P> {
  readonly now: number;
  readonly params: P;
  readonly instance: string;
  /** Snapshot read of a declared (watched or read) entity. Every read is journaled with the decision. */
  get(entity: string): Observed | undefined;
  value(entity: string): Value | undefined;
  /** Due time of a pending timer of this instance, if any. */
  timer(id: string): number | undefined;
  /**
   * A fact's value and since when it holds (by id, or its camelCase or snake_case name);
   * undefined while it has none. Declare the facts a heuristic reads (HeuristicDef.facts):
   * their changes come as fact inputs. Every read is journaled with the decision.
   */
  fact<Id extends FactId>(id: Id): { value: FactValueOf<Id>; since: number } | undefined;
  /** Facts about the house: where its outdoor conditions come from, its time zone. */
  readonly house: HouseFacts;
}

// ---- cards: what an instance shows on the House page ----

/** One value on a card. */
export interface CardField {
  label: string;
  value: Value;
  unit?: string;
  /** Since when it holds (ms epoch): the panel says how long ago. */
  since?: number;
  /** How it reads at a glance (default: plain). */
  tone?: "ok" | "warn" | "bad";
}

/** A button that runs one of the instance's own commands, as the panel's HA user. */
export interface CardButton {
  label: string;
  command: string;
  args?: string[];
  /** Asked before it runs ("Close the garage door?"). */
  confirm?: string;
  /** Shown but not pressable (what it would tell already holds). */
  disabled?: boolean;
}

/** An instance's state card: a title, a few values and its command buttons. */
export interface Card {
  title: string;
  fields: CardField[];
  buttons?: CardButton[];
}

/**
 * What view() may read: the instance's params and the live values of the entities it
 * declares (watch, reads). No clock, no I/O: the same state and values give the same card.
 */
export interface ViewCtx<P> {
  readonly params: P;
  readonly instance: string;
  /** A declared entity as it is now; anything else is undefined. */
  get(entity: string): Observed | undefined;
  value(entity: string): Value | undefined;
}

/** The meta control pattern a heuristic implements (see docs/heuristics.md). */
export type Pattern = "momentary" | "trigger" | "hold" | "button" | "command" | "notice" | "guard";

export interface HeuristicDef<P, S, E extends { tag: string }> {
  /** Stable id; also the journal category. kebab-case. */
  id: string;
  /** "rule" for desired-state rules (rule.ts); absent for hand-written deciders. */
  kind?: "rule";
  /** Which meta control pattern this is, for the panel and the docs. */
  pattern?: Pattern;
  title: string;
  description: string;
  /**
   * What it promises the people in the house, in a sentence or two of plain English
   * ("a light switched by hand is left alone until the room empties"): the panel's
   * catalogue shows it next to the description.
   */
  guarantees?: string;
  /**
   * The parameters an instance takes (params.ts): heuristics.json's params are checked
   * against it, and the panel's instance editor is built from it. None: any params.
   */
  params?: Schema<P>;
  /** Entities whose changes are delivered as signal inputs. */
  watch(params: P): string[];
  /** Entities decide() may ctx.get() without being woken by them. */
  reads?(params: P): string[];
  /** Facts (fact ids) decide() reads with ctx.fact(): each change is delivered as a fact input. */
  facts?(params: P): string[];
  /** Entities this heuristic may actuate — its ownership claim in the SafeActuator. */
  actuates(params: P): string[];
  /** Owned entities other instances may operate too (declaring them in uses): a momentary relay others press. */
  shares?(params: P): string[];
  /** Entities owned by another instance that shares them, which this one operates too. */
  uses?(params: P): string[];
  /** Entities whose attribute-only changes (a setpoint, a brightness) are delivered as signals too. */
  watchAttributes?(params: P): string[];
  /** Command names this instance answers to (input kind "command"). */
  commands?(params: P): string[];
  /**
   * Per command several instances share, the first argument this instance answers for
   * (`/climate_waive bedroom`). The host hands every instance the whole list (the
   * command's `choices`), so an argument nobody answers for gets one reply, not none.
   * Several: every first argument it takes (the cat tunnel's home, away and their
   * aliases), so a chat runs each of them rather than offering the keyboard.
   */
  commandArg?(params: P): Record<string, string | string[]>;
  /**
   * The bot's command menu: per command, a short description, generic and in English
   * ("Open the garage door"). An instance may set its own (commandHelp in heuristics.json).
   */
  commandHelp?(params: P): Record<string, string>;
  /**
   * Per command with a commandArg, the arguments a chat keyboard offers for this
   * instance now, one button each (default: its commandArg(s)). The climate guard
   * adds "bedroom off" while a waiver runs there.
   */
  commandButtons?(params: P, state: S): Record<string, string[]>;
  /**
   * Per command, its arguments typed (see CommandSchema): the voice lane offers a command
   * to the language model only through this, and checks a call against it before it is
   * sent. The house's facts give the bounds a number must keep to.
   */
  commandSchema?(params: P, house: HouseFacts): Record<string, CommandSchema>;
  /** Reads the outdoor conditions: their entities are watched and read. */
  usesOutdoor?: boolean;
  /** Services nobody may call automatically on these entities — enforced for every instance. */
  forbids?(params: P): Array<{ entity: string; service: string; reason: string }>;
  /** HA triggers (automation trigger schema) delivered as trigger inputs, by id. */
  triggers?(params: P): Record<string, Record<string, unknown>>;
  /** Notifications per hour this instance may send (default 12; an instance can set its own in heuristics.json). */
  notifyPerHour?: number;
  /** A notice a restart cut off is sent once more on start when decided within this (ms, default 10 min; 0: never). */
  resendWithinMs?: number;
  /**
   * The instance's card on the House page, from its state (pure: see ViewCtx). None:
   * no card. Its buttons may only run the instance's own commands.
   */
  view?(state: S, ctx: ViewCtx<P>): Card | undefined;
  initial(params: P): S;
  decide(state: S, input: Input, ctx: DecideCtx<P>): Decision<E> | undefined;
  evolve(state: S, event: E): S;
}

/** Type-erased definition, as the library and host hold them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHeuristic = HeuristicDef<any, any, any>;

/** A commandArg entry as a list: the first arguments an instance answers for. */
export const commandArgs = (arg: string | string[] | undefined): string[] => (arg === undefined ? [] : Array.isArray(arg) ? arg : [arg]);

export function defineHeuristic<P, S, E extends { tag: string }>(def: HeuristicDef<P, S, E>): HeuristicDef<P, S, E> {
  return def;
}

// ---- decision helpers ----

export const call = (service: string, entities: string | string[], data?: Record<string, Json>): Action => {
  const action: Action = { kind: "call", service, entities: Array.isArray(entities) ? entities : [entities] };
  if (data !== undefined) action.data = data;
  return action;
};

/** info: nothing to act on (a report, news that needs nobody): never copied to the alerts chat. */
export const notify = (text: string, opts: { info?: boolean } = {}): Action => ({
  kind: "notify",
  channel: "telegram",
  text,
  ...(opts.info === true ? { info: true as const } : {}),
});

export const setTimer = (timer: string, at: number, data?: Json): TimerOp =>
  data === undefined ? { op: "set", timer, at } : { op: "set", timer, at, data };

export const cancelTimer = (timer: string): TimerOp => ({ op: "cancel", timer });

export const minutes = (n: number): number => n * 60_000;
export const seconds = (n: number): number => n * 1000;
export const hours = (n: number): number => n * 3_600_000;

/**
 * When the entities have all held their current state since: the latest last_changed.
 * Startup reconciles deadlines from this, not from boot time.
 */
export const heldSince = (ctx: DecideCtx<unknown>, entities: string[]): number =>
  Math.max(0, ...entities.map((e) => ctx.get(e)?.since ?? 0));

/** True when any of the entities currently reads as on/true. */
export const anyOn = (ctx: DecideCtx<unknown>, entities: string[]): boolean =>
  entities.some((e) => ctx.value(e) === true);

/** A text with `{name}` slots filled from `vars` (a slot with no value stays as written). */
export function fill(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (slot, name: string) => (name in vars ? String(vars[name]) : slot));
}
