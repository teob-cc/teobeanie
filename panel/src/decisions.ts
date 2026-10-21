// decisions.ts — folds heuristic journal rows into decision cards, and matches each
// shadow/active call against the audited call_service traffic of everyone but Teobeanie
// (people, other add-ons, automations, devices; Node-RED on rows from before
// attribution).
//
// Journal grammar (docs/heuristics.md): Decided is the head of a batch; the batch's
// domain events, TimerSet/TimerCancelled and Action* rows carry causationId = the
// Decided eventId; ActionCompleted carries causationId = the action's eventId.

import type { JournalRow } from "./api";
import { originOf } from "./origin";

export interface HeuristicInstance {
  key: string;
  heuristic: string;
  id: string;
  title: string;
  mode: "off" | "shadow" | "active";
  configuredMode: "off" | "shadow" | "active";
  watch: string[];
  reads: string[];
  actuates: string[];
  /** Entities another instance owns and shares, which this one operates too. */
  uses?: string[];
  commands?: string[];
  pattern?: string;
  triggers: string[];
  params: unknown;
  /** The instance this one is a shadow twin of. */
  twinOf?: string;
}

export type Action =
  | { kind: "call"; service: string; entities: string[]; data?: Record<string, unknown> }
  | { kind: "notify"; channel: string; text: string };

export interface ActionView {
  actionId: string;
  action: Action;
  disposition: "requested" | "suppressed" | "refused";
  reason?: string;
  completed?: { ok: boolean; error?: string; haContextId?: string };
  /** A notice a restart cut off: sent once more (and how that went), or dropped and why. */
  resend?: { dropped?: string; completed?: { ok: boolean; error?: string } };
  /** A call_service by someone else doing the same thing within MATCH_WINDOW_MS. */
  seen?: { at: number; delta: number; by: string };
}

export interface Decision {
  eventId: string;
  at: number;
  /** "occupancy-light/stairs" */
  key: string;
  heuristic: string;
  instance: string;
  why?: string;
  failed?: string;
  input: {
    kind: string;
    entity?: string;
    value?: unknown;
    state?: string;
    timer?: string;
    trigger?: string;
    actionId?: string;
    ok?: boolean;
    /** A command: its name, arguments and channel (telegram, panel). */
    command?: string;
    args?: string[];
    from?: string;
  };
  reads: Record<string, unknown>;
  mode?: string;
  causationId?: string;
  events: Array<{ tag: string; [k: string]: unknown }>;
  timers: Array<{ op: "set" | "cancel"; timer: string; at?: number }>;
  actions: ActionView[];
}

/** An audited call_service made by someone other than Teobeanie. */
export interface ObservedCall {
  eventId?: string;
  at: number;
  domain: string;
  service: string;
  /** Targeted entity ids, with device targets expanded when the device map is known. */
  entityIds: string[];
  deviceIds: string[];
  /** Who made it (origin.ts). */
  by: string;
}

/** device_id values of a call_service audit payload (some callers target devices). */
export function deviceIdsOf(payload: unknown): string[] {
  const d = (payload as { serviceData?: { device_id?: unknown } } | null)?.serviceData?.device_id;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : typeof d === "string" ? [d] : [];
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ms timestamp encoded in a ULID's first 10 chars; journal ts is only seconds. */
export function ulidMs(id: string | undefined): number | undefined {
  if (id === undefined || id.length < 10) return undefined;
  let t = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) return undefined;
    t = t * 32 + v;
  }
  return t;
}

export const rowAt = (r: JournalRow): number => ulidMs(r.envelope?.eventId) ?? r.ts * 1000;

export const MATCH_WINDOW_MS = 15_000;

/**
 * Fold journal rows (any order, any categories) into decisions, newest first.
 * Rows whose category is not a heuristic are ignored; the calls others made are
 * returned separately and matched against the decisions' calls. Teobeanie's own audited
 * calls are left out: they are the decisions' actions, not a second opinion.
 */
export function foldDecisions(
  rows: JournalRow[],
  heuristics: Set<string>,
  deviceEntities: Record<string, string[]> = {},
): { decisions: Decision[]; others: ObservedCall[]; matched: Set<ObservedCall> } {
  const asc = [...rows].sort((a, b) => a.globalSeq - b.globalSeq);
  const decisions = new Map<string, Decision>();
  const actionOwner = new Map<string, ActionView>();
  /** A resent notice's actionId → the original action's view. */
  const resendOwner = new Map<string, ActionView>();
  const others: ObservedCall[] = [];

  for (const r of asc) {
    const p = (r.payload ?? {}) as Record<string, any>;
    const eid = r.envelope?.eventId;
    const cause = r.envelope?.causationId;
    if (r.category === "ha-audit") {
      const by = originOf(p);
      if (r.manifest === "HaCallServiceObserved" && by !== "teob") {
        const deviceIds = deviceIdsOf(p);
        const entityIds = [...(p.entityIds ?? []), ...deviceIds.flatMap((d) => deviceEntities[d] ?? [])];
        others.push({ eventId: eid, at: typeof p.at === "number" ? p.at : r.ts * 1000, domain: p.domain, service: p.service, entityIds, deviceIds, by });
      }
      continue;
    }
    if (!heuristics.has(r.category)) continue;

    if (r.manifest === "Decided" || r.manifest === "DecideFailed") {
      if (eid === undefined) continue;
      decisions.set(eid, {
        eventId: eid,
        at: rowAt(r),
        key: `${r.category}/${r.entityId}`,
        heuristic: r.category,
        instance: r.entityId,
        ...(p.why !== undefined ? { why: p.why } : {}),
        ...(r.manifest === "DecideFailed" ? { failed: p.error } : {}),
        input: p.input ?? { kind: "?" },
        reads: p.reads ?? {},
        mode: p.mode,
        ...(cause !== undefined ? { causationId: cause } : {}),
        events: [],
        timers: [],
        actions: [],
      });
      continue;
    }
    if (r.manifest === "ActionCompleted") {
      const a = cause !== undefined ? actionOwner.get(cause) : undefined;
      if (a) a.completed = { ok: p.ok, ...(p.error ? { error: p.error } : {}), ...(p.haContextId ? { haContextId: p.haContextId } : {}) };
      const resend = cause !== undefined ? resendOwner.get(cause)?.resend : undefined;
      if (resend) resend.completed = { ok: p.ok, ...(p.error ? { error: p.error } : {}) };
      continue;
    }
    // ActionResent / ResendDropped carry causationId = the interrupted action's eventId.
    if (r.manifest === "ActionResent" || r.manifest === "ResendDropped") {
      const a = cause !== undefined ? actionOwner.get(cause) : undefined;
      if (a === undefined) continue;
      a.resend = r.manifest === "ResendDropped" ? { dropped: p.reason } : {};
      if (r.manifest === "ActionResent") resendOwner.set(p.actionId, a);
      continue;
    }
    const d = cause !== undefined ? decisions.get(cause) : undefined;
    if (d === undefined) continue; // head row outside the loaded window
    switch (r.manifest) {
      case "TimerSet":
        d.timers.push({ op: "set", timer: p.timer, at: p.at });
        break;
      case "TimerCancelled":
        d.timers.push({ op: "cancel", timer: p.timer });
        break;
      case "ActionRequested":
      case "ActionSuppressed":
      case "ActionRefused": {
        const view: ActionView = {
          actionId: p.actionId,
          action: p.action,
          disposition: r.manifest === "ActionRequested" ? "requested" : r.manifest === "ActionSuppressed" ? "suppressed" : "refused",
          ...(p.reason ? { reason: p.reason } : {}),
        };
        d.actions.push(view);
        actionOwner.set(p.actionId, view);
        break;
      }
      default:
        d.events.push(p as Decision["events"][number]);
    }
  }

  // Shadow parity: did someone else make the same call around the same time? One Teobeanie
  // call can stand for several of theirs (Node-RED often called once per entity), so every
  // overlapping call in the window counts as matched; the nearest is shown on the card.
  const matched = new Set<ObservedCall>();
  for (const d of decisions.values()) {
    for (const a of d.actions) {
      if (a.action.kind !== "call") continue;
      const [domain, service] = a.action.service.split(".");
      const want = new Set(a.action.entities);
      let best: { at: number; delta: number; by: string } | undefined;
      for (const n of others) {
        if (n.domain !== domain || n.service !== service) continue;
        if (!n.entityIds.some((e) => want.has(e))) continue;
        const delta = n.at - d.at;
        if (Math.abs(delta) > MATCH_WINDOW_MS) continue;
        matched.add(n);
        if (best === undefined || Math.abs(delta) < Math.abs(best.delta)) best = { at: n.at, delta, by: n.by };
      }
      if (best) a.seen = best;
    }
  }

  return { decisions: [...decisions.values()].sort((a, b) => b.at - a.at), others, matched };
}

/** Pending timers of one instance, from its journal (any order). */
export function pendingTimers(rows: JournalRow[]): Array<{ timer: string; at: number }> {
  const timers = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => a.globalSeq - b.globalSeq)) {
    const p = (r.payload ?? {}) as Record<string, any>;
    if (r.manifest === "TimerSet") timers.set(p.timer, p.at);
    else if (r.manifest === "TimerCancelled") timers.delete(p.timer);
    else if (r.manifest === "Decided" && p.input?.kind === "timer") timers.delete(p.input.timer);
  }
  return [...timers.entries()].map(([timer, at]) => ({ timer, at })).sort((a, b) => a.at - b.at);
}

export function describeAction(a: Action): string {
  return a.kind === "notify" ? `notify “${a.text}”` : `${a.service} ${a.entities.map(shortId).join(", ")}`;
}

/** light.hallway_ceiling → hallway_ceiling */
export const shortId = (entityId: string): string => entityId.slice(entityId.indexOf(".") + 1);

export function describeInput(i: Decision["input"]): string {
  switch (i.kind) {
    case "signal":
      return `${i.entity} → ${i.state ?? String(i.value)}`;
    case "timer":
      return `timer “${i.timer}” fired`;
    case "trigger":
      return `trigger “${i.trigger}”`;
    case "outcome":
      return `action ${i.ok ? "completed" : "failed"}`;
    case "start":
      return "start (reconcile)";
    case "command":
      return `/${i.command ?? "?"}${i.args?.length ? ` ${i.args.join(" ")}` : ""}${i.from ? ` (${i.from})` : ""}`;
    default:
      return i.kind;
  }
}

/** Why someone else's call on a Teobeanie-owned entity has no Teobeanie call within MATCH_WINDOW_MS. */
export type Miss =
  /** Every owned target was already in the state the call drives it to: a no-op re-send. */
  | { kind: "no-op"; value: boolean }
  /** Teobeanie made the same call on the same entity, just at another time. */
  | { kind: "timing"; deltaMs: number; key: string }
  | { kind: "unexplained" };

export const TIMING_WINDOW_MS = 30 * 60_000;

/** The value a service drives an entity to, where that is unambiguous. */
function drivesTo(service: string): boolean | undefined {
  return service === "turn_off" ? false : service === "turn_on" ? true : undefined;
}

/** Last recorded value of an entity strictly before `at` (rows ascending). */
function valueBefore(rows: Array<{ at: number; value: unknown }> | undefined, at: number): unknown {
  let v: unknown;
  for (const r of rows ?? []) {
    if (r.at >= at) break;
    v = r.value;
  }
  return v;
}

/**
 * Classify an unmatched call by someone else. `history` holds each owned entity's recorded
 * values (ascending); an entity without history never counts as already there.
 */
export function classifyMiss(
  n: ObservedCall,
  owned: Set<string>,
  decisions: Decision[],
  history: Record<string, Array<{ at: number; value: unknown }>>,
): Miss {
  const targets = n.entityIds.filter((e) => owned.has(e));
  const want = drivesTo(n.service);
  if (want !== undefined && targets.length > 0 && targets.every((e) => valueBefore(history[e], n.at) === want)) {
    return { kind: "no-op", value: want };
  }
  let best: { deltaMs: number; key: string } | undefined;
  for (const d of decisions) {
    const delta = d.at - n.at;
    if (Math.abs(delta) > TIMING_WINDOW_MS || (best && Math.abs(delta) >= Math.abs(best.deltaMs))) continue;
    const same = d.actions.some(
      (a) =>
        a.action.kind === "call" &&
        a.disposition !== "refused" &&
        a.action.service === `${n.domain}.${n.service}` &&
        a.action.entities.some((e) => targets.includes(e)),
    );
    if (same) best = { deltaMs: delta, key: d.key };
  }
  return best ? { kind: "timing", ...best } : { kind: "unexplained" };
}

/** 151000 → "2 min 31 s" */
export function fmtDelta(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}
