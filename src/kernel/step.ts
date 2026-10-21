// step.ts — the pure half of the kernel: journal shapes, decideStep and applyEvent.
// No runtime, no I/O and no Node APIs, so the same code decides in the house (via
// kernel.ts), in the simulator and in the Studio's browser tests.

import type { Action, AnyHeuristic, DecideCtx, Decision, HouseFacts, Input, Json, Observed, TimerOp, Value } from "./heuristic.js";
import type { ActionOutcome, Mode, Verdict } from "./actuator.js";

// ---- journal shapes ----

export interface InputSummary {
  kind: Input["kind"];
  entity?: string;
  value?: Value;
  state?: string;
  timer?: string;
  trigger?: string;
  command?: string;
  args?: string[];
  from?: string;
  actionId?: string;
  ok?: boolean;
}

export type KernelEvent =
  | { tag: "Decided"; input: InputSummary; why?: string; reads: Record<string, Value>; mode: Mode }
  | { tag: "DecideFailed"; input: InputSummary; error: string }
  | { tag: "TimerSet"; timer: string; at: number; data?: Json; eid: string }
  | { tag: "TimerCancelled"; timer: string }
  /** at: the decision's time (absent in journals from before notices were resent). */
  | { tag: "ActionRequested"; actionId: string; action: Action; at?: number }
  | { tag: "ActionSuppressed"; actionId: string; action: Action }
  | { tag: "ActionRefused"; actionId: string; action: Action; reason: string }
  | { tag: "ActionCompleted"; actionId: string; ok: boolean; error?: string; haContextId?: string }
  /** A notice a restart cut off, sent once more under a new actionId. */
  | { tag: "ActionResent"; actionId: string; of: string; action: Action; at: number }
  /** A notice a restart cut off that is not sent again, and why. */
  | { tag: "ResendDropped"; actionId: string; reason: string };

const KERNEL_TAGS = new Set<string>([
  "Decided",
  "DecideFailed",
  "TimerSet",
  "TimerCancelled",
  "ActionRequested",
  "ActionSuppressed",
  "ActionRefused",
  "ActionCompleted",
  "ActionResent",
  "ResendDropped",
]);

export const isKernelEvent = (e: { tag: string }): e is KernelEvent => KERNEL_TAGS.has(e.tag);

export interface KState<S> {
  s: S;
  timers: Record<string, { at: number; data?: Json; eid: string }>;
  /** Requested in active mode, not yet completed. */
  pending: Record<string, Pending>;
}

export interface Pending {
  action: Action;
  /** When it was decided (absent in old journals). */
  at?: number;
  /** The action this one resends. */
  of?: string;
}

/** The outcome of an action a restart cut off. */
export const INTERRUPTED = "interrupted by restart";

/** How long after its decision a notice a restart cut off is still sent (HeuristicDef.resendWithinMs). */
export const RESEND_WITHIN_MS = 10 * 60_000;

export type KCommand =
  | { tag: "Input"; input: Input }
  /**
   * No-op. teob-ts starts entities lazily and a crashed entity's timers stay silent
   * until its next command; the host sends Wake periodically so recovery (and the
   * timer re-arm in onRecoveryComplete) happens without waiting for an input.
   */
  | { tag: "Wake" }
  | { tag: "Fire"; timer: string; at: number }
  | ({ tag: "Outcome"; actionId: string; at: number } & ActionOutcome)
  /** Recovery found this action requested and never completed: settle it, and resend it if it is a notice. */
  | { tag: "Interrupted"; actionId: string; at: number };

// ---- pure step ----

export interface Stamped {
  event: KernelEvent | { tag: string; [field: string]: unknown };
  eventId: string;
  causationId?: string;
}

export interface StepResult {
  events: Stamped[];
  timers: TimerOp[];
  fire: Array<{ actionId: string; action: Action }>;
}

export interface StepGate {
  mode: Mode;
  vet(action: Action, now: number): Verdict;
}

const EMPTY: StepResult = { events: [], timers: [], fire: [] };

function summarize(input: Input): InputSummary {
  switch (input.kind) {
    case "start":
      return { kind: "start" };
    case "signal":
      return { kind: "signal", entity: input.entity, value: input.value, state: input.state };
    case "timer":
      return { kind: "timer", timer: input.timer };
    case "trigger":
      return { kind: "trigger", trigger: input.trigger };
    case "outcome":
      return { kind: "outcome", actionId: input.actionId, ok: input.ok };
    case "command":
      return { kind: "command", command: input.command, ...(input.args.length > 0 ? { args: input.args } : {}), from: input.from.channel };
  }
}

function causeOf<S>(ks: KState<S>, input: Input): string | undefined {
  switch (input.kind) {
    case "signal":
      return input.obsId;
    case "timer":
      return ks.timers[input.timer]?.eid;
    case "outcome":
      return input.actionId;
    default:
      return undefined;
  }
}

/** Nothing to journal: no effects and no explanation. A why-only decision is a journaled "declined". */
const isEmpty = <E>(d: Decision<E> | undefined): boolean =>
  d === undefined ||
  (d.why === undefined && (d.events?.length ?? 0) === 0 && (d.actions?.length ?? 0) === 0 && (d.timers?.length ?? 0) === 0);

/**
 * Run one input through a heuristic. Pure apart from newId() and gate.vet()
 * (whose rate-limit window is the actuator's, and whose verdict is journaled).
 */
export function decideStep<S>(
  def: AnyHeuristic,
  params: unknown,
  instance: string,
  ks: KState<S>,
  input: Input,
  /** Live (or simulated) state of any entity, read at decision time. Every read is journaled. */
  observe: (entity: string) => Observed | undefined,
  gate: StepGate,
  newId: () => string,
  house: HouseFacts = {},
): StepResult {
  if (gate.mode === "off") return EMPTY;

  const events: Stamped[] = [];
  const cause = causeOf(ks, input);

  if (input.kind === "outcome") {
    events.push({
      event: {
        tag: "ActionCompleted",
        actionId: input.actionId,
        ok: input.ok,
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.haContextId !== undefined ? { haContextId: input.haContextId } : {}),
      },
      eventId: newId(),
      causationId: input.actionId,
    });
  }

  const reads: Record<string, Value> = {};
  const get = (entity: string): Observed | undefined => {
    const o = observe(entity);
    reads[entity] = o === undefined ? null : o.value;
    return o;
  };
  const ctx: DecideCtx<unknown> = {
    now: input.at,
    params,
    instance,
    get,
    value: (entity) => get(entity)?.value,
    timer(id) {
      return ks.timers[id]?.at;
    },
    house,
  };

  let decision: Decision<{ tag: string }> | undefined;
  try {
    decision = def.decide(ks.s, input, ctx);
  } catch (err) {
    events.push({
      event: { tag: "DecideFailed", input: summarize(input), error: (err as Error).message ?? String(err) },
      eventId: newId(),
      ...(cause !== undefined ? { causationId: cause } : {}),
    });
    return { events, timers: [], fire: [] };
  }

  // A fired timer must leave state even when nothing else happens, so it always journals.
  if (isEmpty(decision) && input.kind !== "timer") return { events, timers: [], fire: [] };

  const decidedId = newId();
  events.push({
    event: {
      tag: "Decided",
      input: summarize(input),
      ...(decision?.why !== undefined ? { why: decision.why } : {}),
      reads,
      mode: gate.mode,
    },
    eventId: decidedId,
    ...(cause !== undefined ? { causationId: cause } : {}),
  });

  for (const e of decision?.events ?? []) {
    if (KERNEL_TAGS.has(e.tag)) throw new Error(`heuristic ${def.id} emitted reserved event tag "${e.tag}"`);
    events.push({ event: e, eventId: newId(), causationId: decidedId });
  }

  const timers: TimerOp[] = [];
  for (const op of decision?.timers ?? []) {
    if (op.op === "set") {
      const eid = newId();
      events.push({
        event: { tag: "TimerSet", timer: op.timer, at: op.at, ...(op.data !== undefined ? { data: op.data } : {}), eid },
        eventId: eid,
        causationId: decidedId,
      });
    } else {
      events.push({ event: { tag: "TimerCancelled", timer: op.timer }, eventId: newId(), causationId: decidedId });
    }
    timers.push(op);
  }

  const fire: StepResult["fire"] = [];
  for (const decided of decision?.actions ?? []) {
    const action: Action = input.kind === "command" && decided.kind === "notify" ? { ...decided, reply: true } : decided;
    const actionId = newId();
    const verdict = gate.vet(action, input.at);
    if (!verdict.ok) {
      events.push({ event: { tag: "ActionRefused", actionId, action, reason: verdict.reason }, eventId: actionId, causationId: decidedId });
    } else if (gate.mode === "shadow") {
      events.push({ event: { tag: "ActionSuppressed", actionId, action }, eventId: actionId, causationId: decidedId });
    } else {
      events.push({ event: { tag: "ActionRequested", actionId, action, at: input.at }, eventId: actionId, causationId: decidedId });
      fire.push({ actionId, action });
    }
  }

  return { events, timers, fire };
}

/** Pure state transition over kernel + domain events. */
export function applyEvent<S>(def: AnyHeuristic, ks: KState<S>, event: { tag: string }): KState<S> {
  if (!isKernelEvent(event)) return { ...ks, s: def.evolve(ks.s, event) };
  switch (event.tag) {
    case "Decided": {
      if (event.input.kind !== "timer" || event.input.timer === undefined) return ks;
      const { [event.input.timer]: _fired, ...rest } = ks.timers;
      return { ...ks, timers: rest };
    }
    case "TimerSet":
      return {
        ...ks,
        timers: { ...ks.timers, [event.timer]: { at: event.at, eid: event.eid, ...(event.data !== undefined ? { data: event.data } : {}) } },
      };
    case "TimerCancelled": {
      const { [event.timer]: _gone, ...rest } = ks.timers;
      return { ...ks, timers: rest };
    }
    case "ActionRequested":
      return { ...ks, pending: { ...ks.pending, [event.actionId]: { action: event.action, ...(event.at !== undefined ? { at: event.at } : {}) } } };
    case "ActionResent":
      return { ...ks, pending: { ...ks.pending, [event.actionId]: { action: event.action, at: event.at, of: event.of } } };
    case "ActionCompleted": {
      const { [event.actionId]: _done, ...rest } = ks.pending;
      return { ...ks, pending: rest };
    }
    default:
      return ks;
  }
}

/** Resolve the input a kernel command stands for, or undefined when it is stale. */
export function inputOf<S>(ks: KState<S>, cmd: KCommand): Input | undefined {
  switch (cmd.tag) {
    case "Wake":
      return undefined;
    case "Input":
      return cmd.input;
    case "Fire": {
      const t = ks.timers[cmd.timer];
      // Re-set or cancelled since this firing was scheduled: stale.
      if (t === undefined || t.at !== cmd.at) return undefined;
      return { kind: "timer", at: cmd.at, timer: cmd.timer, ...(t.data !== undefined ? { data: t.data } : {}) };
    }
    case "Outcome":
    case "Interrupted": {
      const p = ks.pending[cmd.actionId];
      if (p === undefined) return undefined;
      const outcome: ActionOutcome = cmd.tag === "Outcome" ? cmd : { ok: false, error: INTERRUPTED };
      return {
        kind: "outcome",
        at: cmd.at,
        actionId: cmd.actionId,
        action: p.action,
        ok: outcome.ok,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.haContextId !== undefined ? { haContextId: outcome.haContextId } : {}),
      };
    }
  }
}

// ---- a notice a restart cut off ----

/** The notice as it is sent again: marked, so it does not read as a new one. */
export const asResend = (action: Action): Action =>
  action.kind === "notify" ? { ...action, text: `${action.text}\n(resent after a restart)` } : action;

const mins = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/** Why a pending notice is not sent again, or undefined when it is. */
function noResend(p: Pending, now: number, withinMs: number): string | undefined {
  if (p.of !== undefined) return "already resent once";
  if (p.at === undefined) return "request time unknown (journaled before notices were resent)";
  if (now - p.at > withinMs) return `requested ${mins(now - p.at)} ago, older than ${mins(withinMs)}`;
  return undefined;
}

/**
 * After a restart, send a notice that was requested and never completed once more,
 * within withinMs of its decision. Calls are never replayed: heuristics re-decide
 * device state on start. Runs on the state before the batch that settles the action.
 */
export function resendStep<S>(ks: KState<S>, actionId: string, now: number, gate: StepGate, withinMs: number, newId: () => string): StepResult {
  const p = ks.pending[actionId];
  if (p === undefined || p.action.kind !== "notify" || gate.mode === "off") return EMPTY;
  const dropped = (reason: string): StepResult => ({
    events: [{ event: { tag: "ResendDropped", actionId, reason }, eventId: newId(), causationId: actionId }],
    timers: [],
    fire: [],
  });
  const why = noResend(p, now, withinMs);
  if (why !== undefined) return dropped(why);
  if (gate.mode === "shadow") return dropped("shadow mode: never sent");
  const action = asResend(p.action);
  const verdict = gate.vet(action, now);
  if (!verdict.ok) return dropped(verdict.reason);
  const resentId = newId();
  return {
    events: [{ event: { tag: "ActionResent", actionId: resentId, of: actionId, action, at: now }, eventId: resentId, causationId: actionId }],
    timers: [],
    fire: [{ actionId: resentId, action }],
  };
}
