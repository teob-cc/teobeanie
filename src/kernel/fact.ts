// fact.ts — derived state. A fact is a pure function of the house's entities (and
// time, and other facts) with a value and a since:
//
//   export default fact("nobody-near-garage", ({ ha, held }) =>
//     held(() => ha.binary_sensor.garage_motion.is("off"), minutes(10)), { title: "Nobody near the garage" });
//
// It is written like a rule (rule.ts gives the World: ha, held, within, between, sun,
// outdoor) and its inputs are found the same way: the entities in its source and those
// a probe evaluation reads. The host evaluates a fact when one of its inputs changes,
// or when a held/within condition can flip, and journals FactChanged only when its
// value changes (stream teob-fact/<id>). Rules read facts as ha.facts.<name>, deciders
// as ctx.fact(id) with the fact declared in HeuristicDef.facts; a change reaches them
// as a fact input.
//
// Pure: no I/O, no Node APIs. The engine below runs in the host (with the journal), in
// the simulator and in the Studio's browser tests.

import { outdoorEntities, type HouseFacts, type Json, type Observed, type OutdoorSources } from "./heuristic.js";
import { createWorld, entitiesInSource, factsInSource, newScope, trackChanges, type FactReading, type Scope, type Track, type World } from "./rule.js";

/** The journal category of the facts' streams; the entity is the fact id. */
export const FACT_CATEGORY = "teob-fact";

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

export interface FactOptions {
  /** What the House view and the tools call it. Default: the id. */
  title?: string;
  description?: string;
  /** The unit of a number ("°C", "min"). */
  unit?: string;
  /** Entities whose changes re-evaluate the fact, in addition to those found in its source and first evaluation. */
  watch?: string[];
}

/** One evaluation of a fact: its value, the reason, what it read, its held/within bookkeeping. */
export interface FactEvaluation {
  value: Json;
  why: string;
  reads: string[];
  /** Facts read, by the name they were read with. */
  facts: string[];
  set: Record<string, Track>;
  clear: string[];
  /** The earliest time a time condition can flip. */
  wake?: number;
}

/** The value a fact function's result is stored as: undefined reads as null. */
export type Stored<T> = Exclude<T, undefined> | (undefined extends T ? null : never);

export interface FactDef<Id extends string = string, T = Json> {
  readonly kind: "fact";
  readonly id: Id;
  readonly title: string;
  readonly description?: string;
  readonly unit?: string;
  /** Reads the outdoor conditions: their entities are watched too. */
  readonly usesOutdoor: boolean;
  /** Entities whose changes re-evaluate it. */
  watch(): string[];
  /** Facts it reads, as written (an id, or its camelCase or snake_case name). */
  facts(): string[];
  evaluate(now: number, house: HouseFacts, get: Scope["get"], fact: Scope["fact"], track: Record<string, Track>): FactEvaluation;
  /** Never set: carries the value's type, for ha.d.ts (FactValueIn). */
  readonly valueType?: Stored<T>;
}

/** Type-erased, as the library and the host hold them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFact = FactDef<string, any>;

/**
 * The type of a fact's value, from its definition: the generated ha.d.ts types
 * ha.facts and ctx.fact with it (`FactValue<typeof import("./x").quiet>`).
 */
export type FactValue<F> = F extends { readonly kind: "fact"; readonly valueType?: infer V } ? Exclude<V, undefined> : Json;

/** JSON-safe: undefined and non-finite numbers become null. */
function toJson(v: unknown): Json {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return JSON.parse(JSON.stringify(v)) as Json;
}

export function fact<const Id extends string, T>(id: Id, fn: (w: World) => T, opts: FactOptions = {}): FactDef<Id, T> {
  if (!KEBAB.test(id)) throw new Error(`fact id must be kebab-case (got ${JSON.stringify(id)})`);
  let current: Scope | undefined;
  const scope = (): Scope => {
    if (current === undefined) throw new Error(`fact ${id}: entities can only be read while the fact evaluates`);
    return current;
  };
  const world = createWorld(scope);
  const run = (s: Scope): unknown => {
    current = s;
    try {
      return fn(world);
    } finally {
      current = undefined;
    }
  };
  // A first evaluation over an empty house tells which entities and facts it reads.
  const probe = newScope(0, {}, () => undefined, () => undefined, {});
  try {
    run(probe);
  } catch {
    // reads before the throw still count; the rest comes from the source
  }
  const source = fn.toString();
  const watch = [...new Set([...(opts.watch ?? []), ...entitiesInSource(source), ...probe.reads])];
  const facts = [...new Set([...factsInSource(source), ...probe.factReads])];
  return {
    kind: "fact",
    id,
    title: opts.title ?? id,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
    usesOutdoor: /\boutdoor\b/.test(source),
    watch: () => watch,
    facts: () => facts,
    evaluate(now, house, get, factOf, track) {
      const s = newScope(now, house, get, factOf, track);
      const value = toJson(run(s));
      const { set, clear } = trackChanges(track, s.touched);
      const wake = s.wakes.filter((t) => t > now).reduce((a, b) => Math.min(a, b), Infinity);
      return { value, why: s.trace.join(", "), reads: [...s.reads], facts: [...s.factReads], set, clear, ...(wake !== Infinity ? { wake } : {}) };
    },
  };
}

/** Whether a default export is a fact definition. */
export const isFact = (d: unknown): d is AnyFact => typeof d === "object" && d !== null && (d as { kind?: unknown }).kind === "fact";

// ---- names ----

/** nobody-near-garage → nobodyNearGarage */
export const camelOf = (id: string): string => id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** nobody-near-garage → nobody_near_garage */
export const snakeOf = (id: string): string => id.replace(/-/g, "_");
/** The names a fact is read by: its id, camelCase and snake_case. */
export const factNames = (id: string): string[] => [...new Set([id, camelOf(id), snakeOf(id)])];

// ---- journal shapes ----

/** What made a fact re-evaluate. */
export type FactInput = { kind: "start" } | { kind: "signal"; entity: string } | { kind: "time" } | { kind: "fact"; fact: string };

export type FactEvent =
  /** The value changed. inputs: what it read (entity → value, "fact:<id>" → value); why: the conditions it found. */
  | { tag: "FactChanged"; fact: string; value: Json; since: number; inputs: Record<string, Json>; why?: string; input: FactInput }
  /** held/within bookkeeping changed without the value changing (so a restart keeps it). */
  | { tag: "FactTracked"; fact: string; set: Record<string, Track>; clear: string[] };

export const FACT_TAGS = ["FactChanged", "FactTracked"] as const;

/** A fact as it stands: its value (undefined: never evaluated), since when, its bookkeeping. */
export interface FactRecord {
  value?: Json;
  since: number;
  track: Record<string, Track>;
  /** The latest event of its stream: what a time-caused change points back to. */
  lastEventId?: string;
  /** When a time condition can flip next (not journaled: found again on start). */
  wake?: number;
}

export const EMPTY_FACT: FactRecord = { since: 0, track: {} };

export function foldFact(rec: FactRecord, e: FactEvent, eventId?: string): FactRecord {
  const last = eventId !== undefined ? { lastEventId: eventId } : {};
  if (e.tag === "FactChanged") return { ...rec, value: e.value, since: e.since, track: rec.track, ...last };
  if (e.tag === "FactTracked") {
    const track = { ...rec.track, ...e.set };
    for (const k of e.clear) delete track[k];
    return { ...rec, track, ...last };
  }
  return rec;
}

// ---- the plan: which facts run, in which order ----

export interface FactPlan {
  /** The facts that run, each after the facts it reads. */
  facts: AnyFact[];
  /** Facts left out, with the reason. */
  problems: string[];
  /** id, camelCase and snake_case name → id. */
  aliases: Map<string, string>;
  /** id → the fact ids it reads. */
  deps: Map<string, string[]>;
  /** id → the facts that read it. */
  dependents: Map<string, string[]>;
  /** id → the entities whose changes re-evaluate it (with the outdoor sources). */
  entities: Map<string, string[]>;
}

/**
 * Check a set of facts: unique ids and names, every fact it reads defined, no cycle, and
 * (with `observes`) every entity it reads in the house scope. A fact that fails, and any
 * fact that reads one, is left out with the reason.
 */
export function planFacts(defs: readonly AnyFact[], opts: { observes?: (entity: string) => boolean; outdoor?: OutdoorSources } = {}): FactPlan {
  const problems: string[] = [];
  const byId = new Map<string, AnyFact>();
  const aliases = new Map<string, string>();
  const bad = new Set<string>();
  for (const f of defs) {
    if (byId.has(f.id)) {
      problems.push(`fact ${f.id} is defined twice`);
      continue;
    }
    const clash = factNames(f.id).find((n) => aliases.has(n));
    if (clash !== undefined) {
      problems.push(`fact ${f.id}: reads as ha.facts.${clash}, as fact ${aliases.get(clash)} does`);
      continue;
    }
    byId.set(f.id, f);
    for (const n of factNames(f.id)) aliases.set(n, f.id);
  }
  const outdoor = outdoorEntities(opts.outdoor);
  const deps = new Map<string, string[]>();
  const entities = new Map<string, string[]>();
  for (const f of byId.values()) {
    const ents = [...new Set([...f.watch(), ...(f.usesOutdoor ? outdoor : [])])];
    entities.set(f.id, ents);
    const unseen = opts.observes === undefined ? [] : ents.filter((e) => !opts.observes!(e));
    if (unseen.length > 0) {
      problems.push(`fact ${f.id} is outside the house scope (allowlist.json): not listed: ${unseen.join(", ")}`);
      bad.add(f.id);
    }
    const reads: string[] = [];
    for (const name of f.facts()) {
      const id = aliases.get(name);
      if (id === undefined) {
        problems.push(`fact ${f.id} reads ha.facts.${name}, which no fact defines`);
        bad.add(f.id);
      } else if (!reads.includes(id)) reads.push(id);
    }
    deps.set(f.id, reads);
  }
  // A fact that reads a left-out fact is left out too.
  for (let again = true; again; ) {
    again = false;
    for (const [id, reads] of deps) {
      if (bad.has(id)) continue;
      const gone = reads.find((r) => bad.has(r));
      if (gone !== undefined) {
        problems.push(`fact ${id} reads fact ${gone}, which is left out`);
        bad.add(id);
        again = true;
      }
    }
  }
  // Dependency order (Kahn); what is left over reads in a cycle.
  const order: string[] = [];
  const pending = new Map([...deps].filter(([id]) => !bad.has(id)).map(([id, reads]) => [id, new Set(reads)]));
  for (let progress = true; progress; ) {
    progress = false;
    for (const [id, reads] of pending) {
      if ([...reads].every((r) => order.includes(r))) {
        order.push(id);
        pending.delete(id);
        progress = true;
      }
    }
  }
  for (const id of pending.keys()) problems.push(`fact ${id} reads facts in a cycle: ${cycleFrom(id, deps).join(" → ")}`);
  const facts = order.map((id) => byId.get(id)!);
  const dependents = new Map<string, string[]>();
  for (const id of order) for (const r of deps.get(id) ?? []) dependents.set(r, [...(dependents.get(r) ?? []), id]);
  for (const id of [...aliases.values()]) if (!order.includes(id)) for (const n of factNames(id)) aliases.delete(n);
  return { facts, problems, aliases, deps: new Map(order.map((id) => [id, deps.get(id) ?? []])), dependents, entities: new Map(order.map((id) => [id, entities.get(id) ?? []])) };
}

/** A cycle reachable from a fact, for the problem's text: a → b → a. */
function cycleFrom(start: string, deps: Map<string, string[]>): string[] {
  const path: string[] = [];
  const walk = (id: string): string[] | undefined => {
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    path.push(id);
    for (const r of deps.get(id) ?? []) {
      const c = walk(r);
      if (c !== undefined) return c;
    }
    path.pop();
    return undefined;
  };
  return walk(start) ?? [start];
}

// ---- the engine ----

export interface FactStep {
  fact: string;
  events: Array<{ event: FactEvent; eventId: string; causationId?: string }>;
  /** The value changed: the FactChanged's id, for the inputs it causes. */
  changed?: { value: Json; since: number; eventId: string };
}

export type FactTrigger = { kind: "start" } | { kind: "signal"; entity: string; obsId: string } | { kind: "time" };

export interface FactEngine {
  readonly plan: FactPlan;
  /** A fact by id or name: its value and since, once it has one. */
  reading(name: string): FactReading | undefined;
  record(id: string): FactRecord | undefined;
  /** Fold a fact's journaled events (recovery). */
  restore(id: string, events: Array<{ event: FactEvent; eventId?: string }>): void;
  /** Take a fact over as another engine had it (a reload). */
  seed(id: string, record: FactRecord): void;
  /** Evaluate the facts a trigger concerns (and the facts that read a changed one); the steps to journal, in order. */
  run(trigger: FactTrigger, now: number): FactStep[];
  /** The earliest time a fact's time condition can flip. */
  nextWake(): number | undefined;
  /** Every entity some fact reads. */
  watched(): string[];
}

export function createFactEngine(
  plan: FactPlan,
  deps: {
    observe(entity: string): Observed | undefined;
    house: HouseFacts;
    newId(): string;
    /** A fact threw: it keeps its value. */
    onError?(fact: string, error: string): void;
  },
): FactEngine {
  const records = new Map<string, FactRecord>(plan.facts.map((f) => [f.id, { ...EMPTY_FACT }]));
  const byEntity = new Map<string, string[]>();
  for (const [id, ents] of plan.entities) for (const e of ents) byEntity.set(e, [...(byEntity.get(e) ?? []), id]);

  const reading = (name: string): FactReading | undefined => {
    const id = plan.aliases.get(name);
    const r = id === undefined ? undefined : records.get(id);
    return r?.value === undefined ? undefined : { value: r.value, since: r.since };
  };

  return {
    plan,
    reading,
    record: (id) => records.get(id),
    restore(id, events) {
      if (!records.has(id)) return;
      let r = records.get(id)!;
      for (const e of events) r = foldFact(r, e.event, e.eventId);
      records.set(id, r);
    },
    seed(id, record) {
      if (records.has(id)) records.set(id, { ...record });
    },
    run(trigger, now) {
      const dirty = new Map<string, { input: FactInput; cause?: string }>();
      if (trigger.kind === "start") for (const f of plan.facts) dirty.set(f.id, { input: { kind: "start" } });
      else if (trigger.kind === "signal") for (const id of byEntity.get(trigger.entity) ?? []) dirty.set(id, { input: { kind: "signal", entity: trigger.entity }, cause: trigger.obsId });
      else
        for (const [id, r] of records)
          if (r.wake !== undefined && r.wake <= now) dirty.set(id, { input: { kind: "time" }, ...(r.lastEventId !== undefined ? { cause: r.lastEventId } : {}) });
      const steps: FactStep[] = [];
      for (const f of plan.facts) {
        const why = dirty.get(f.id);
        if (why === undefined) continue;
        const rec = records.get(f.id)!;
        let ev: FactEvaluation;
        try {
          ev = f.evaluate(now, deps.house, deps.observe, reading, rec.track);
        } catch (err) {
          deps.onError?.(f.id, (err as Error).message ?? String(err));
          continue;
        }
        const events: FactStep["events"] = [];
        const caused = why.cause !== undefined ? { causationId: why.cause } : {};
        let next: FactRecord = { ...rec };
        if (ev.wake !== undefined) next.wake = ev.wake;
        else delete next.wake;
        let changed: FactStep["changed"];
        if (rec.value === undefined || JSON.stringify(rec.value) !== JSON.stringify(ev.value)) {
          const inputs: Record<string, Json> = {};
          for (const e of ev.reads) inputs[e] = deps.observe(e)?.value ?? null;
          for (const n of ev.facts) {
            const id = plan.aliases.get(n);
            if (id !== undefined) inputs[`fact:${id}`] = reading(n)?.value ?? null;
          }
          const event: FactEvent = { tag: "FactChanged", fact: f.id, value: ev.value, since: now, inputs, ...(ev.why !== "" ? { why: ev.why } : {}), input: why.input };
          const eventId = deps.newId();
          events.push({ event, eventId, ...caused });
          next = foldFact(next, event, eventId);
          changed = { value: ev.value, since: now, eventId };
        }
        if (Object.keys(ev.set).length > 0 || ev.clear.length > 0) {
          const event: FactEvent = { tag: "FactTracked", fact: f.id, set: ev.set, clear: ev.clear };
          const eventId = deps.newId();
          events.push({ event, eventId, ...caused });
          next = foldFact(next, event, eventId);
        }
        records.set(f.id, next);
        if (events.length > 0) steps.push({ fact: f.id, events, ...(changed !== undefined ? { changed } : {}) });
        if (changed !== undefined) {
          for (const d of plan.dependents.get(f.id) ?? []) dirty.set(d, { input: { kind: "fact", fact: f.id }, cause: changed.eventId });
        }
      }
      return steps;
    },
    nextWake() {
      let min = Infinity;
      for (const r of records.values()) if (r.wake !== undefined && r.wake < min) min = r.wake;
      return min === Infinity ? undefined : min;
    },
    watched: () => [...byEntity.keys()],
  };
}
