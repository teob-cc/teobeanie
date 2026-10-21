// simulate.ts — run a heuristic against a scripted world on a virtual clock, through
// the same decideStep/applyEvent the live kernel uses. No teob-ts runtime, no HA, no
// wall clock: a test reads like a timeline.
//
//   const sim = simulate(stairsLight, params, { "binary_sensor.stairs": "off" });
//   sim.set("binary_sensor.stairs", "on");
//   sim.advance(minutes(5));
//   expect(sim.calls()).toEqual(["light.turn_on light.stairs", "light.turn_off light.stairs"]);

import { normalizeState } from "@lambda-house/teob-ts/ha";
import { OUTDOOR_ATTRIBUTES, commandArgs, outdoorEntities, type Action, type AnyHeuristic, type CommandSource, type HouseFacts, type Observed } from "./heuristic.js";
import type { Mode, Verdict } from "./actuator.js";
import { applyEvent, decideStep, type KState, type Stamped } from "./step.js";
import { validateParams } from "./params.js";
import { instanceCard, type InstanceCard } from "./card.js";

export interface SimEntry {
  at: number;
  event: { tag: string };
}

export interface Sim<S> {
  readonly now: number;
  readonly state: S;
  readonly timers: KState<S>["timers"];
  /** Every journaled event, in order. */
  readonly journal: SimEntry[];
  /** Set an entity's state (string as HA reports it); delivers a signal when watched and changed. */
  /**
   * A change of a watched entity; `user` stands for the HA user who made it (none: the device itself).
   * `force`: the same state written again with force_update, as some meters do: last_changed moves,
   * but the bridge drops it as no change, so no signal.
   */
  set(entity: string, state: string, attributes?: Record<string, unknown>, opts?: { user?: string; force?: boolean }): Sim<S>;
  /** Advance the virtual clock, firing due timers in order. */
  advance(ms: number): Sim<S>;
  start(): Sim<S>;
  trigger(id: string, data?: Record<string, unknown>): Sim<S>;
  /** Send a named command, as Telegram or the panel would; `choices` as the host passes them (default: this instance's commandArg). */
  command(name: string, args?: string[], from?: CommandSource, choices?: string[]): Sim<S>;
  /** Actions that would have reached HA, as "service entity,entity" / "notify: text". */
  calls(): string[];
  actions(): Array<{ at: number; action: Action; disposition: "requested" | "suppressed" | "refused"; reason?: string }>;
  whys(): string[];
  /** The instance's card as the House page would get it now (view() over the state and the world). */
  card(): InstanceCard;
}

export interface SimOptions {
  t0?: number;
  mode?: Exclude<Mode, "off">;
  vet?: (action: Action, now: number) => Verdict;
  instance?: string;
  /** Facts about the house, e.g. where the outdoor conditions come from. */
  house?: HouseFacts;
  /** The house's time zone (rules' between, local times); overrides house.timeZone. Default UTC. */
  timeZone?: string;
}

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0); // a Monday, noon UTC

export const describeAction = (a: Action): string =>
  a.kind === "notify" ? `notify: ${a.text}` : `${a.service} ${a.entities.join(",")}`;

export function simulate<P, S>(
  def: AnyHeuristic,
  params: P,
  /** Entity → state, or state with attributes (and when it last changed, default t0). */
  world: Record<string, string | { state: string; attributes?: Record<string, unknown>; since?: number }> = {},
  opts: SimOptions = {},
): Sim<S> {
  // Params the loader would refuse could never run: refused here too.
  const invalid = validateParams(def, params);
  if (invalid.length > 0) throw new Error(`${def.id}: ${invalid.join("; ")}`);
  let now = opts.t0 ?? T0;
  let seq = 0;
  const newId = (): string => `e${String(++seq).padStart(5, "0")}`;
  const instance = opts.instance ?? "sim";
  const gate = { mode: opts.mode ?? "active", vet: opts.vet ?? ((): Verdict => ({ ok: true })) };
  const house: HouseFacts = { ...opts.house, ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}) };
  const outdoor = def.usesOutdoor ? outdoorEntities(house.outdoor) : [];
  const watched = new Set([...def.watch(params), ...outdoor]);
  // As live: an enforced entity's attributes, and the weather entity's outdoor
  // readings, are signals even when the state stays.
  const weather = def.usesOutdoor ? house.outdoor?.weather : undefined;
  const attributeWatched = new Set(def.watchAttributes?.(params) ?? []);
  const readingsMoved = (entity: string, prev: Observed | undefined, attributes: Record<string, unknown>): boolean =>
    prev !== undefined &&
    (entity === weather
      ? OUTDOOR_ATTRIBUTES.some((k) => prev.attributes[k] !== attributes[k])
      : attributeWatched.has(entity) && JSON.stringify(prev.attributes) !== JSON.stringify(attributes));

  const entities = new Map<string, Observed>();
  const put = (entity: string, state: string, attributes: Record<string, unknown> = {}, since?: number): Observed => {
    const prev = entities.get(entity);
    const o: Observed = {
      value: normalizeState({ entity_id: entity, state, attributes, last_changed: "", last_updated: "" }).value,
      state,
      // last_changed moves only when the state does, as in HA; where attributes are the
      // signal, last_updated dates it (as the host reads it).
      since: since ?? (prev !== undefined && prev.state === state && !readingsMoved(entity, prev, attributes) ? prev.since : now),
      attributes,
    };
    entities.set(entity, o);
    return o;
  };
  for (const [e, s] of Object.entries(world)) typeof s === "string" ? put(e, s) : put(e, s.state, s.attributes, s.since);

  let ks: KState<S> = { s: def.initial(params), timers: {}, pending: {} };
  const journal: SimEntry[] = [];

  const run = (input: Parameters<typeof decideStep>[4]): void => {
    const step = decideStep(def, params, instance, ks as KState<unknown>, input, (e) => entities.get(e), gate, newId, house);
    for (const st of step.events as Stamped[]) {
      ks = applyEvent(def, ks, st.event);
      journal.push({ at: now, event: st.event });
    }
    // Active mode: outcomes come back immediately and successfully.
    for (const f of step.fire) {
      run({ kind: "outcome", at: now, actionId: f.actionId, action: f.action, ok: true });
    }
  };

  const fireDue = (until: number): void => {
    for (;;) {
      const due = Object.entries(ks.timers)
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) return;
      const [timer, t] = due;
      now = Math.max(now, t.at);
      run({ kind: "timer", at: now, timer, ...(t.data !== undefined ? { data: t.data } : {}) });
    }
  };

  const sim: Sim<S> = {
    get now() {
      return now;
    },
    get state() {
      return ks.s;
    },
    get timers() {
      return ks.timers;
    },
    journal,
    set(entity, state, attributes, opts) {
      const prev = entities.get(entity);
      const moved = readingsMoved(entity, prev, attributes ?? {});
      const o = put(entity, state, attributes, opts?.force === true ? now : undefined);
      if (watched.has(entity) && (prev?.state !== state || moved)) {
        run({ kind: "signal", at: now, obsId: `obs${++seq}`, entity, value: o.value, state, origin: "ha", ...(opts?.user !== undefined ? { user: opts.user } : {}) });
      }
      return sim;
    },
    advance(ms) {
      const until = now + ms;
      fireDue(until);
      now = until;
      return sim;
    },
    start() {
      run({ kind: "start", at: now });
      return sim;
    },
    trigger(id, data = {}) {
      run({ kind: "trigger", at: now, trigger: id, data });
      return sim;
    },
    command(name, args = [], from = { channel: "test" }, choices) {
      const own = commandArgs(def.commandArg?.(params)?.[name]);
      const all = choices ?? (own.length > 0 ? [...own].sort() : undefined);
      run({ kind: "command", at: now, command: name, args, from, ...(all !== undefined ? { choices: all } : {}) });
      return sim;
    },
    actions() {
      type Row = ReturnType<Sim<S>["actions"]>[number];
      return journal.flatMap(({ at, event }): Row[] => {
        const e = event as { tag: string; action?: Action; reason?: string };
        if (e.tag === "ActionRequested") return [{ at, action: e.action!, disposition: "requested" }];
        if (e.tag === "ActionSuppressed") return [{ at, action: e.action!, disposition: "suppressed" }];
        if (e.tag === "ActionRefused") return [{ at, action: e.action!, disposition: "refused", reason: e.reason! }];
        return [];
      });
    },
    calls() {
      return sim
        .actions()
        .filter((a) => a.disposition !== "refused")
        .map((a) => describeAction(a.action));
    },
    whys() {
      return journal.flatMap(({ event }) => {
        const e = event as { tag: string; why?: string };
        return e.tag === "Decided" && e.why !== undefined ? [e.why] : [];
      });
    },
    card() {
      const declared = [...new Set([...watched, ...(def.reads?.(params) ?? [])])];
      return instanceCard(def, { key: `${def.id}/${instance}`, id: instance, params, mode: gate.mode, entities: declared, commands: def.commands?.(params) ?? [] }, ks.s, (e) => entities.get(e));
    },
  };
  return sim;
}
