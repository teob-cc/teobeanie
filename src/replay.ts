// replay.ts — run a heuristic over the house's recorded history, as shadow mode
// would have, and set what it would have done next to what actually happened to the
// entities it owns. A new parameter set (or a new heuristic for an existing
// instance) can be checked against last week before it runs anywhere.
//
// Two ways to see the world:
//   - shadow (default): the owned entities' states are the recorded ones, whatever
//     drove them, exactly as a shadow instance sees them live. A heuristic that reads
//     its targets (and does not repeat a switch someone already made) stays quiet
//     wherever the automation it is meant to replace got there first.
//   - drive: Teobeanie's calls take effect at once, and the recorded changes of the owned
//     entities are replayed only where `keep` says so (people, devices; not the
//     automation Teobeanie replaces). This is the house as it would have been.
// `cli.js replay` fetches the history and prints the comparison.

import { houseZone } from "./kernel/clock.js";
import { outdoorEntities, type Action, type AnyHeuristic, type HouseFacts } from "./kernel/heuristic.js";
import { planFacts, type AnyFact } from "./kernel/fact.js";
import { simulate } from "./kernel/simulate.js";

export interface Recorded {
  entity: string;
  /** ms epoch: last_changed, or last_updated for an attribute-only change. */
  at: number;
  state: string;
  attributes: Record<string, unknown>;
}

/** A recorded change of an owned entity, and who made it when known (a user's name, an automation, "device"). */
export interface HouseChange {
  entity: string;
  at: number;
  state: string;
  by?: string;
}

export interface ReplayCall {
  at: number;
  service: string;
  entity: string;
  why: string;
}

export interface ReplayOptions {
  /** Where the outdoor conditions come from, and the house's time zone (HA's configuration). */
  house?: HouseFacts;
  /** Drive the owned entities: calls take effect at once; a recorded change of an owned entity is replayed only when keep() is true. */
  drive?: { keep(r: Recorded): boolean };
  /** The facts the heuristic reads (factsFor): evaluated over the recorded changes as the host would have. */
  facts?: AnyFact[];
}

/**
 * The facts an instance reads, with the facts those read in turn, out of the library's
 * facts; and the entities they re-evaluate on, whose history a replay needs too. A fact
 * it names that the library does not define is in `unknown` (the replay then refuses,
 * as the loader would).
 */
export function factsFor(def: AnyHeuristic, params: unknown, all: readonly AnyFact[], house: HouseFacts = {}): { facts: AnyFact[]; entities: string[]; unknown: string[] } {
  const named = def.facts?.(params) ?? [];
  if (named.length === 0) return { facts: [], entities: [], unknown: [] };
  const plan = planFacts(all, house.outdoor !== undefined ? { outdoor: house.outdoor } : {});
  const unknown = named.filter((n) => !plan.aliases.has(n));
  const wanted = new Set<string>();
  const add = (id: string): void => {
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const d of plan.deps.get(id) ?? []) add(d);
  };
  for (const n of named) if (plan.aliases.has(n)) add(plan.aliases.get(n)!);
  const facts = plan.facts.filter((f) => wanted.has(f.id));
  const entities = [...new Set(facts.flatMap((f) => plan.entities.get(f.id) ?? []))];
  return { facts, entities, unknown };
}

/** The entities a replay of an instance needs the history of: what it watches, owns and reads, the outdoor sources it uses, and its facts' inputs. */
export function replayEntities(def: AnyHeuristic, params: unknown, house: HouseFacts = {}, factEntities: string[] = []): string[] {
  return [
    ...new Set([
      ...def.watch(params),
      ...def.actuates(params),
      ...(def.reads?.(params) ?? []),
      ...(def.watchAttributes?.(params) ?? []),
      ...(def.usesOutdoor ? outdoorEntities(house.outdoor) : []),
      ...factEntities,
    ]),
  ];
}

/** Run def with params from `from` to `to` over the recorded changes (any order). */
export function replay(def: AnyHeuristic, params: unknown, recorded: Recorded[], span: { from: number; to: number }, opts: ReplayOptions = {}): ReplayCall[] {
  const sorted = [...recorded].sort((a, b) => a.at - b.at);
  const owned = new Set(def.actuates(params));
  const world: Record<string, { state: string; attributes: Record<string, unknown>; since: number }> = {};
  for (const r of sorted) if (r.at <= span.from) world[r.entity] = { state: r.state, attributes: r.attributes, since: r.at };
  const sim = simulate(def, params, world, {
    t0: span.from,
    mode: "shadow",
    ...(opts.house ? { house: opts.house } : {}),
    ...(opts.facts !== undefined && opts.facts.length > 0 ? { facts: opts.facts } : {}),
    instance: "replay",
  });
  // The owned entities as Teobeanie would have left them (drive mode).
  const targets = new Map(Object.entries(world).filter(([e]) => owned.has(e)));
  let seen = 0;
  const takeEffect = (): void => {
    if (opts.drive === undefined) return;
    while (seen < sim.journal.length) {
      const e = sim.journal[seen++]!.event as { tag: string; action?: Action };
      if (e.tag !== "ActionSuppressed" || e.action?.kind !== "call") continue;
      const state = resultOf(e.action.service);
      if (state === undefined) continue;
      for (const entity of e.action.entities) {
        const was = targets.get(entity);
        if (!owned.has(entity) || was?.state === state) continue;
        const now = { state, attributes: was?.attributes ?? {}, since: sim.now };
        targets.set(entity, now);
        sim.set(entity, state, now.attributes);
      }
    }
  };
  /** Advance to t, letting each due timer's calls take effect at its own time. */
  const advanceTo = (t: number): void => {
    for (let guard = 0; guard < 10_000; guard++) {
      const due = Object.values(sim.timers)
        .map((x) => x.at)
        .filter((at) => at <= t)
        .reduce((a, b) => Math.min(a, b), Infinity);
      if (due === Infinity) break;
      sim.advance(Math.max(0, due - sim.now));
      takeEffect();
    }
    sim.advance(Math.max(0, t - sim.now));
    takeEffect();
  };

  sim.start();
  takeEffect();
  for (const r of sorted) {
    if (r.at <= span.from) continue;
    if (r.at > span.to) break;
    advanceTo(r.at);
    if (opts.drive !== undefined && owned.has(r.entity)) {
      if (!opts.drive.keep(r)) continue;
      targets.set(r.entity, { state: r.state, attributes: r.attributes, since: r.at });
    }
    sim.set(r.entity, r.state, r.attributes);
    takeEffect();
  }
  advanceTo(span.to);

  const calls: ReplayCall[] = [];
  let why = "";
  for (const { at, event } of sim.journal) {
    const e = event as { tag: string; why?: string; action?: Action };
    if (e.tag === "Decided") why = e.why ?? "";
    if ((e.tag === "ActionSuppressed" || e.tag === "ActionRequested") && e.action?.kind === "call") {
      for (const entity of e.action.entities) calls.push({ at, service: e.action.service, entity, why });
    }
  }
  return calls;
}

/** The state a service call leaves an entity in, where there is one to compare. */
const RESULT: Record<string, string> = {
  turn_on: "on",
  turn_off: "off",
  open_cover: "open",
  close_cover: "closed",
  open_valve: "open",
  close_valve: "closed",
  lock: "locked",
  unlock: "unlocked",
};
const resultOf = (service: string): string | undefined => RESULT[service.slice(service.indexOf(".") + 1)];

/** The owned entities' recorded state changes (to a state a call can cause). */
export function houseChanges(recorded: Recorded[], owned: string[]): HouseChange[] {
  const results = new Set(Object.values(RESULT));
  const last = new Map<string, string>();
  const out: HouseChange[] = [];
  for (const r of [...recorded].sort((a, b) => a.at - b.at)) {
    if (!owned.includes(r.entity)) continue;
    const prev = last.get(r.entity);
    last.set(r.entity, r.state);
    if (prev !== undefined && prev !== r.state && results.has(r.state)) out.push({ entity: r.entity, at: r.at, state: r.state });
  }
  return out;
}

export interface EntityParity {
  entity: string;
  calls: ReplayCall[];
  changes: HouseChange[];
  matched: number;
  /** Calls with no change to the same state within the window; offset = this call minus the nearest such change, ms. */
  teobOnly: Array<{ call: ReplayCall; offset?: number }>;
  /** Changes with no call to the same state within the window; offset = the change minus the nearest such call, ms. */
  houseOnly: Array<{ change: HouseChange; offset?: number }>;
  /** Calls that set something other than a state (a brightness, a setpoint): not compared. */
  uncompared: ReplayCall[];
}

/** Match calls to recorded changes: same entity, same resulting state, within windowMs. */
export function compare(calls: ReplayCall[], changes: HouseChange[], owned: string[], windowMs: number): EntityParity[] {
  return owned.map((entity) => {
    const mine = calls.filter((c) => c.entity === entity);
    const theirs = changes.filter((c) => c.entity === entity);
    /** Signed offset to the nearest same-state entry of `among`. */
    const nearest = (at: number, state: string, among: Array<{ at: number; state: string }>) =>
      among
        .filter((x) => x.state === state)
        .map((x) => at - x.at)
        .reduce<number | undefined>((best, d) => (best === undefined || Math.abs(d) < Math.abs(best) ? d : best), undefined);
    const compared = mine.flatMap((c) => {
      const state = resultOf(c.service);
      return state === undefined ? [] : [{ ...c, state }];
    });
    const teobOnly: EntityParity["teobOnly"] = [];
    let matched = 0;
    for (const c of compared) {
      const n = nearest(c.at, c.state, theirs);
      if (n !== undefined && Math.abs(n) <= windowMs) matched++;
      else teobOnly.push({ call: c, ...(n !== undefined ? { offset: n } : {}) });
    }
    const houseOnly: EntityParity["houseOnly"] = [];
    for (const h of theirs) {
      const n = nearest(h.at, h.state, compared);
      if (n === undefined || Math.abs(n) > windowMs) houseOnly.push({ change: h, ...(n !== undefined ? { offset: n } : {}) });
    }
    return { entity, calls: mine, changes: theirs, matched, teobOnly, houseOnly, uncompared: mine.filter((c) => resultOf(c.service) === undefined) };
  });
}

const stamps = new Map<string, Intl.DateTimeFormat>();
/** "05 Jan, 13:00" in the given zone (the house's). */
export const fmtAt = (at: number, timeZone: string): string => {
  let f = stamps.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    stamps.set(timeZone, f);
  }
  return f.format(new Date(at));
};
const fmtGap = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** Unmatched entries within this of a same-state counterpart are the same switch, at another time. */
const TIMING_MS = 15 * 60_000;
const LIST = 12;

/** The comparison as text, one block per owned entity, times in the house's zone. */
export function formatParity(rows: EntityParity[], windowMs: number, house: HouseFacts = {}): string {
  const tz = houseZone(house);
  const out: string[] = [];
  const list = (title: string, items: Array<{ text: string; offset?: number }>, other: string) => {
    if (items.length === 0) return;
    const timing = items.filter((i) => i.offset !== undefined && Math.abs(i.offset) <= TIMING_MS);
    out.push(`  ${title} (${items.length}): ${timing.length} within ${fmtGap(TIMING_MS)} of the same switch by ${other}, ${items.length - timing.length} without one`);
    for (const i of items.slice(0, LIST)) {
      const when = i.offset === undefined ? "" : ` · ${fmtGap(Math.abs(i.offset))} ${i.offset > 0 ? "after" : "before"} ${other}'s`;
      out.push(`    ${i.text}${when}`);
    }
    if (items.length > LIST) out.push(`    … ${items.length - LIST} more (--timeline lists everything)`);
  };
  for (const r of rows) {
    const who = new Map<string, number>();
    for (const c of r.changes) who.set(c.by ?? "unknown", (who.get(c.by ?? "unknown") ?? 0) + 1);
    const by = [...who].map(([k, n]) => `${k} ${n}`).join(", ");
    out.push(`${r.entity}: Teobeanie ${r.calls.length} calls, house ${r.changes.length} changes${by ? ` (${by})` : ""}, ${r.matched} matched within ${fmtGap(windowMs)}`);
    list("Teobeanie only", r.teobOnly.map((t) => ({ text: `${fmtAt(t.call.at, tz)} ${resultOf(t.call.service)}`, ...(t.offset !== undefined ? { offset: t.offset } : {}) })), "the house");
    list("house only", r.houseOnly.map((h) => ({ text: `${fmtAt(h.change.at, tz)} ${h.change.state}${h.change.by ? ` by ${h.change.by}` : ""}`, ...(h.offset !== undefined ? { offset: h.offset } : {}) })), "Teobeanie");
    if (r.uncompared.length > 0) out.push(`  ${r.uncompared.length} calls that set attributes only (not compared)`);
  }
  return out.join("\n");
}
