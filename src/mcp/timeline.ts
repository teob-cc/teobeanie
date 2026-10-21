// timeline.ts — the record read back, for "why did this happen" and "what happened
// here": a journal event's causation chain, an entity's signal rows over a range with
// who caused each, and one timeline that merges the signals (what changed), the audited
// calls (who called what), the decisions (why, and what became of each action), the
// pause and the config changes in time order. Shared by the MCP tools (tools.ts) and
// the read API (api/timeline); times here are epoch ms, the callers format them.

import type { Hono } from "hono";
import { ulidTime, type JournalQuery, type JournalQueryRow, type JournalReader } from "@lambda-house/teob-ts/core";
import type { HaEntityState, SignalQuery, SignalRow } from "@lambda-house/teob-ts/ha";
import type { HouseScope } from "../allowlist.js";
import { AUDIT_CATEGORY } from "../audit.js";
import { LEGACY_ORIGIN, OWN_ORIGIN, type UserDirectory } from "../attribution.js";
import { houseZone, localInstant, localTimeOn } from "../kernel/clock.js";
import type { Action, HouseFacts } from "../kernel/heuristic.js";
import type { InstanceInfo } from "../kernel/host.js";
import type { InputSummary } from "../kernel/step.js";
import { CONTROL_CATEGORY } from "../pause.js";
import { CONFIG_CATEGORY } from "../working-set.js";
import { callerLabel, type Caller } from "./access.js";

/**
 * Where the working set's edits are journaled, as `ConfigChanged { at, file, by, summary,
 * instances? }` (working-set.ts): the timeline shows them between the decisions before
 * and after them.
 */
export { CONFIG_CATEGORY };

const MINUTE = 60_000;
/** The window when a timeline or a signals query names no start. */
export const DEFAULT_WINDOW_MS = 6 * 60 * MINUTE;
/** Rows read per source and query: what bounds a wide window. */
const MAX_READ = 20_000;

export interface RecordDeps {
  scope: HouseScope;
  signals: { query(q: SignalQuery): SignalRow[] };
  journal: JournalReader;
  users: UserDirectory;
  instances(): InstanceInfo[];
  house: HouseFacts;
  now?: () => number;
}

// ---- journal rows ----

export const payload = (r: JournalQueryRow) => r.payload as { tag: string; [k: string]: unknown };

/**
 * When a journal row happened, in ms: the payload's own time (a TimerSet's is when it is
 * due), else its event id's (a ULID minted at decision time), else the row's second.
 */
export function rowTime(r: JournalQueryRow): number {
  const p = payload(r);
  if (typeof p["at"] === "number" && p.tag !== "TimerSet") return p["at"];
  const id = r.envelope?.eventId;
  if (id !== undefined) {
    try {
      const t = ulidTime(id);
      if (Math.abs(t - r.ts * 1000) <= 5000) return t;
    } catch {
      // not a ULID
    }
  }
  return r.ts * 1000;
}

/** Every journal row matching q, newest first, up to max. */
export function readJournal(journal: JournalReader, q: JournalQuery, max: number): JournalQueryRow[] {
  const out: JournalQueryRow[] = [];
  let cursor: number | undefined;
  while (out.length < max) {
    const page = journal.queryEvents({ ...q, order: "desc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    out.push(...page);
    if (page.length < 1000) break;
    cursor = page.at(-1)!.globalSeq;
  }
  return out.slice(0, max);
}

/** The journal rows matching q written from fromMs to about toMs, oldest first, up to max. */
export function readRange(journal: JournalReader, q: JournalQuery, fromMs: number, toMs: number, max: number): JournalQueryRow[] {
  const out: JournalQueryRow[] = [];
  let cursor: number | undefined;
  while (out.length < max) {
    const page = journal.queryEvents({ ...q, sinceMs: fromMs, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    // Rows are in write order; one written a minute past the end ends the range.
    const end = page.findIndex((r) => r.ts * 1000 > toMs + MINUTE);
    out.push(...(end < 0 ? page : page.slice(0, end)));
    if (end >= 0 || page.length < 1000) break;
    cursor = page.at(-1)!.globalSeq;
  }
  return out.slice(0, max);
}

// ---- descriptions ----

export const describeAction = (a: Action): string =>
  a.kind === "notify" ? `notify: ${a.text}` : `${a.service} ${a.entities.join(", ")}${a.data && Object.keys(a.data).length > 0 ? ` ${JSON.stringify(a.data)}` : ""}`;

/** What a decision answered: "binary_sensor.hall_motion → on", "timer vacant", "/status". */
export function describeInput(i: InputSummary | undefined): string {
  switch (i?.kind) {
    case "signal":
      return `${i.entity ?? "?"} → ${i.state ?? String(i.value)}`;
    case "timer":
      return `timer ${i.timer ?? "?"}`;
    case "trigger":
      return `trigger ${i.trigger ?? "?"}`;
    case "command":
      return `/${i.command ?? "?"}${i.args !== undefined ? ` ${i.args.join(" ")}` : ""}`;
    case "outcome":
      return `an action ${i.ok ? "completed" : "failed"}`;
    case "start":
      return "start";
    default:
      return "?";
  }
}

/** An audit `by` as shown: Teobeanie's own calls are journaled as "teob" (the value predates the name). */
export const shownBy = (by: string): string => (by === OWN_ORIGIN ? "Teobeanie" : by);

/** Who caused a change or a call, and the journal event that shows it (chain it). */
export interface Cause {
  /** teob, person:<name>, system:<name>, user:<id>, automation, device, unknown. */
  by: string;
  /** Teobeanie's instance, when its ActionCompleted is in range. */
  instance?: string;
  /** Teobeanie's ActionRequested, or the audited call. */
  event?: string;
}

/** A cause as one string: "Teobeanie occupancy-light/hall", "person:alex", "device". */
export const shownCause = (c: Cause): string => (c.by === OWN_ORIGIN && c.instance !== undefined ? `Teobeanie ${c.instance}` : shownBy(c.by));

interface HaContext {
  id?: string;
  parent_id?: string | null;
  user_id?: string | null;
}

// ---- rows ----

export interface ActionFate {
  action: string;
  /** shadow: not sent, refused: <reason>, sent, done, failed: <error>; "; resent" after a restart. */
  status: string;
  event_id?: string;
}

export interface DecisionRow {
  at: number;
  instance: string;
  input: InputSummary;
  why?: unknown;
  mode?: unknown;
  failed?: unknown;
  actions?: ActionFate[];
  timers?: Array<{ timer: unknown; at: number }>;
  event_id?: string;
}

export interface SignalEntry {
  at: number;
  state: string;
  value: unknown;
  unit?: string;
  by: Cause;
  obs_id: string;
  /** Absent for a change Home Assistant reported: resync or backfill. */
  origin?: string;
}

export type TimelineRow =
  | { at: number; kind: "change"; entity: string; from?: string; to: string; by: Cause; obs_id: string }
  | { at: number; kind: "call"; service: string; entities: string[]; data?: unknown; by: Cause; event_id: string }
  | ({ kind: "decision" } & DecisionRow & { event_id: string })
  | { at: number; kind: "pause" | "config"; summary: string; by?: string; event_id: string; instances?: string[] };

export interface Page<R> {
  from: number;
  to: number;
  rows: R[];
  /** Pass as `cursor` (same query otherwise) for the rows after these. */
  more?: string;
}

export interface ChainHop {
  event_id: string;
  at: number;
  category: string;
  instance: string;
  tag: string;
  summary: string;
  /** Reached through the HA context of Teobeanie's own call, not a causation id. */
  via?: "ha_context";
}

export interface Chain {
  event_id: string;
  /** The event first, then its cause, then the cause's cause. */
  hops: ChainHop[];
  /** What the last hop's causation id names when it is not an event: a signal row, or an HA context. */
  origin?: { obs_id: string; entity: string; state: string; at: number; by: Cause } | { id: string };
  /** What the event itself caused: actions, timers, outcomes. */
  effects: Array<Omit<ChainHop, "via">>;
}

// ---- cursors and times ----

const rowId = (r: { obs_id?: string; event_id?: string }): string => r.obs_id ?? r.event_id ?? "";
const encodeCursor = (r: { at: number; obs_id?: string; event_id?: string }): string => `${r.at}~${rowId(r)}`;
function decodeCursor(c: string): { at: number; id: string } {
  const i = c.indexOf("~");
  const at = Number(c.slice(0, i));
  if (i < 0 || !Number.isFinite(at)) throw new Error("cursor: not one this tool returned");
  return { at, id: c.slice(i + 1) };
}

/** Rows in order after the cursor, at most limit, and the cursor of the rest. */
function page<R extends { at: number; obs_id?: string; event_id?: string }>(rows: R[], order: "asc" | "desc", limit: number, cursor?: string): { rows: R[]; more?: string } {
  const sign = order === "asc" ? 1 : -1;
  const cmp = (a: { at: number; id: string }, b: { at: number; id: string }) => sign * (a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keyed = rows.map((r) => ({ r, k: { at: r.at, id: rowId(r) } })).sort((x, y) => cmp(x.k, y.k));
  const c = cursor === undefined ? undefined : decodeCursor(cursor);
  const after = c === undefined ? keyed : keyed.filter((x) => cmp(x.k, c) > 0);
  const out = after.slice(0, limit).map((x) => x.r);
  return { rows: out, ...(after.length > limit ? { more: encodeCursor(out.at(-1)!) } : {}) };
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A time as a caller gives it: epoch ms, "21:14" (today, house time), "2026-10-12 21:14"
 * (house time) or ISO with an offset.
 */
export function parseTime(v: unknown, key: string, timeZone: string, now: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return Number(v);
    const c = CLOCK.exec(v);
    if (c) return localTimeOn(now, 0, Number(c[1]) * 60 + Number(c[2]), timeZone) + Number(c[3] ?? 0) * 1000;
    const l = LOCAL.exec(v);
    if (l) return localInstant(Number(l[1]), Number(l[2]), Number(l[3]), Number(l[4] ?? 0) * 60 + Number(l[5] ?? 0), timeZone) + Number(l[6] ?? 0) * 1000;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new Error(`${key}: expected epoch ms, "HH:MM", "YYYY-MM-DD HH:MM" (house time) or ISO 8601`);
}

// ---- the reader ----

export interface RangeQuery {
  fromMs: number;
  toMs: number;
  limit: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export function createHouseRecord(deps: RecordDeps) {
  const now = deps.now ?? Date.now;
  const zone = (): string => houseZone(deps.house);
  const heuristicCategories = () => [...new Set(deps.instances().map((i) => i.heuristic))];
  /** The rows of q in a window; past MAX_READ one up to now keeps its newest rows, an earlier one its oldest. */
  const readWindow = (q: JournalQuery, fromMs: number, toMs: number): JournalQueryRow[] =>
    toMs >= now() - MINUTE ? readJournal(deps.journal, { ...q, sinceMs: fromMs }, MAX_READ) : readRange(deps.journal, q, fromMs, toMs, MAX_READ);

  /**
   * Who caused a change or a call in [fromMs, toMs], as the audit attributes calls
   * (attribution.ts): Teobeanie (with the instance when its ActionCompleted is in range),
   * person:<name>, system:<name>, user:<id>, device; a state change no call explains but
   * with a parent context is an automation's. Old audit rows (by "nodered") are
   * attributed here.
   */
  async function attribution(fromMs: number, toMs: number = now()) {
    const calls = new Map<string, { userId: string | null; by: string | undefined; event?: string }>();
    for (const r of readWindow({ category: AUDIT_CATEGORY }, fromMs - MINUTE, toMs + MINUTE)) {
      const p = payload(r) as { haContextId?: string | null; haUserId?: string | null; by?: string };
      if (p.haContextId) calls.set(p.haContextId, { userId: p.haUserId ?? null, by: p.by, ...(r.envelope?.eventId ? { event: r.envelope.eventId } : {}) });
    }
    const teob = new Map<string, { instance: string; event?: string }>();
    for (const category of heuristicCategories()) {
      for (const r of readWindow({ category }, fromMs - MINUTE, toMs + MINUTE)) {
        const p = payload(r) as { tag: string; haContextId?: string };
        const requested = r.envelope?.causationId;
        if (p.tag === "ActionCompleted" && p.haContextId) teob.set(p.haContextId, { instance: `${category}/${r.entityId}`, ...(requested ? { event: requested } : {}) });
      }
    }
    return async (ctx: HaContext | undefined): Promise<Cause> => {
      if (!ctx?.id) return { by: "unknown" };
      const mine = teob.get(ctx.id);
      if (mine !== undefined) return { by: OWN_ORIGIN, ...mine };
      const call = calls.get(ctx.id);
      const event = call?.event !== undefined ? { event: call.event } : {};
      if (call?.by !== undefined && call.by !== LEGACY_ORIGIN) return { by: call.by, ...event };
      const user = ctx.user_id ?? call?.userId ?? null;
      if (user) return { by: await deps.users.originOf(user), ...event };
      if (call === undefined && ctx.parent_id) return { by: "automation" };
      return { by: "device", ...event };
    };
  }

  /** An audited call's cause: from its HA context when it has one, else from what it journaled. */
  async function callCause(by: Awaited<ReturnType<typeof attribution>>, r: JournalQueryRow): Promise<Cause> {
    const p = r.payload as { haContextId: string | null; haUserId: string | null; by?: string };
    if (p.haContextId) {
      const c = await by({ id: p.haContextId, user_id: p.haUserId });
      // The call itself is the row; the cause worth chaining is Teobeanie's request.
      return c.by === OWN_ORIGIN ? c : { by: c.by };
    }
    if (p.by !== undefined && p.by !== LEGACY_ORIGIN) return { by: p.by };
    return { by: p.haUserId ? await deps.users.originOf(p.haUserId) : "device" };
  }

  /** One heuristic's rows folded into its decisions: what came in, why, each action's fate. */
  function foldDecisions(category: string, rows: JournalQueryRow[]): DecisionRow[] {
    const byCause = new Map<string, JournalQueryRow[]>();
    // A decision's actions in the order it made them, whichever way the rows were read.
    for (const r of [...rows].sort((x, y) => x.globalSeq - y.globalSeq)) {
      const c = r.envelope?.causationId;
      if (c) byCause.set(c, [...(byCause.get(c) ?? []), r]);
    }
    const out: DecisionRow[] = [];
    for (const r of rows) {
      const p = payload(r);
      if (p.tag !== "Decided" && p.tag !== "DecideFailed") continue;
      const children = byCause.get(r.envelope?.eventId ?? "") ?? [];
      const actions = children
        .filter((c) => ["ActionRequested", "ActionSuppressed", "ActionRefused"].includes(payload(c).tag))
        .map((c): ActionFate => {
          const cp = payload(c) as { tag: string; action: Action; reason?: string };
          const after = (byCause.get(c.envelope?.eventId ?? "") ?? []).map(payload);
          const done = after.find((x) => x.tag === "ActionCompleted") as { ok: boolean; error?: string } | undefined;
          // A notice a restart cut off: sent once more, or dropped with a reason.
          const resend = after.find((x) => x.tag === "ActionResent" || x.tag === "ResendDropped") as { tag: string; reason?: string } | undefined;
          const resent = resend === undefined ? "" : resend.tag === "ActionResent" ? "; resent" : `; not resent: ${resend.reason}`;
          const status =
            cp.tag === "ActionSuppressed"
              ? "shadow: not sent"
              : cp.tag === "ActionRefused"
                ? `refused: ${cp.reason}`
                : done === undefined
                  ? "sent"
                  : done.ok
                    ? "done"
                    : `failed: ${done.error ?? "unknown"}`;
          return { action: describeAction(cp.action), status: status + resent, ...(c.envelope?.eventId ? { event_id: c.envelope.eventId } : {}) };
        });
      const timers = children.map(payload).filter((x) => x.tag === "TimerSet").map((x) => ({ timer: x["timer"], at: x["at"] as number }));
      out.push({
        at: rowTime(r),
        instance: `${category}/${r.entityId}`,
        input: p["input"] as InputSummary,
        ...(p.tag === "Decided" ? { why: p["why"], mode: p["mode"] } : { failed: p["error"] }),
        ...(actions.length > 0 ? { actions } : {}),
        ...(timers.length > 0 ? { timers } : {}),
        ...(r.envelope?.eventId ? { event_id: r.envelope.eventId } : {}),
      });
    }
    return out;
  }

  /** One line for a journal row, whatever its stream. */
  function summarize(r: JournalQueryRow, local: (ms: number) => string = (ms) => new Date(ms).toISOString()): string {
    const p = payload(r);
    const action = (): string => describeAction(p["action"] as Action);
    switch (p.tag) {
      case "Decided":
        return `${describeInput(p["input"] as InputSummary)}${p["why"] !== undefined ? `: ${String(p["why"])}` : ""}${p["mode"] === "shadow" ? " (shadow)" : ""}`;
      case "DecideFailed":
        return `${describeInput(p["input"] as InputSummary)}: failed: ${String(p["error"])}`;
      case "ActionRequested":
        return `requested ${action()}`;
      case "ActionSuppressed":
        return `${action()}: shadow, not sent`;
      case "ActionRefused":
        return `${action()}: refused: ${String(p["reason"])}`;
      case "ActionCompleted":
        return p["ok"] ? "done" : `failed: ${String(p["error"] ?? "unknown")}`;
      case "ActionResent":
        return `resent ${action()}`;
      case "ResendDropped":
        return `not resent: ${String(p["reason"])}`;
      case "TimerSet":
        return `timer ${String(p["timer"])} set for ${local(p["at"] as number)}`;
      case "TimerCancelled":
        return `timer ${String(p["timer"])} cancelled`;
      case "HaCallServiceObserved": {
        // Entities outside the scope are not named, as in recent_changes.
        const ids = ((p["entityIds"] as string[] | undefined) ?? []).filter((e) => deps.scope.observes(e));
        return `${String(p["domain"])}.${String(p["service"])} ${ids.length > 0 ? ids.join(", ") : "(outside the house scope)"}${typeof p["by"] === "string" ? ` by ${shownBy(p["by"])}` : ""}`;
      }
      case "ToolCalled": {
        return `${String(p["tool"])} by ${callerLabel((p["caller"] ?? {}) as Partial<Caller>)}${p["ok"] === false ? `: ${String(p["error"])}` : ""}`;
      }
      case "AgentTokenMinted":
        return `agent token "${String(p["name"])}" minted by ${String(p["by"])}`;
      case "AgentTokenRevoked": {
        return `agent token ${String(p["id"])} revoked by ${String(p["by"])}`;
      }
      case "Paused":
        return `paused by ${String(p["by"])}${p["reason"] !== undefined ? `: ${String(p["reason"])}` : ""}`;
      case "Resumed":
        return `resumed by ${String(p["by"])}`;
      case "ConfigChanged":
        return `${String(p["file"])}: ${String(p["summary"])}`;
      default: {
        const { tag, ...rest } = p;
        const json = JSON.stringify(rest);
        return json === "{}" ? tag : `${tag} ${json.length > 120 ? `${json.slice(0, 119)}…` : json}`;
      }
    }
  }

  const hop = (r: JournalQueryRow, local: (ms: number) => string): ChainHop => ({
    event_id: r.envelope?.eventId ?? "",
    at: rowTime(r),
    category: r.category,
    instance: `${r.category}/${r.entityId}`,
    tag: payload(r).tag,
    summary: summarize(r, local),
  });

  /** Teobeanie's ActionCompleted carrying this HA context, near the call. */
  function ownCompletion(haContextId: string, at: number): JournalQueryRow | undefined {
    for (const category of heuristicCategories()) {
      const hit = readRange(deps.journal, { category }, at - MINUTE, at + MINUTE, MAX_READ).find(
        (r) => payload(r).tag === "ActionCompleted" && payload(r)["haContextId"] === haContextId,
      );
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /**
   * The causation chain of a journal event: the event, its cause, the cause's cause, up
   * to what started it. An audited call Teobeanie made continues into the action that
   * requested it (through the call's HA context); a decision a signal started ends at
   * that signal row.
   */
  async function chain(eventId: string, local: (ms: number) => string): Promise<Chain> {
    const rows = deps.journal.causationChain(eventId);
    if (rows.length === 0) throw new Error(`no journal event ${eventId}`);
    const hops = rows.map((r) => hop(r, local));
    let last = rows.at(-1)!;
    const lp = payload(last);
    if (lp.tag === "HaCallServiceObserved" && typeof lp["haContextId"] === "string") {
      const completed = ownCompletion(lp["haContextId"], rowTime(last));
      const requested = completed?.envelope?.causationId;
      const more = requested !== undefined ? deps.journal.causationChain(requested) : [];
      if (more.length > 0) {
        hops.push(...more.map((r, i) => ({ ...hop(r, local), ...(i === 0 ? { via: "ha_context" as const } : {}) })));
        last = more.at(-1)!;
      }
    }
    const cause = last.envelope?.causationId;
    let origin: Chain["origin"];
    if (cause !== undefined && deps.journal.eventByEventId(cause) === undefined) {
      const input = payload(last)["input"] as InputSummary | undefined;
      const at = rowTime(last);
      const signal =
        input?.kind === "signal" && input.entity !== undefined
          ? deps.signals.query({ entityId: input.entity, sinceMs: at - 5 * MINUTE, untilMs: at + 5000, order: "desc", limit: 500 }).find((s) => s.obsId === cause)
          : undefined;
      if (signal !== undefined) {
        const raw = signal.raw as Partial<HaEntityState> | null;
        const by = await attribution(signal.at, signal.at);
        origin = { obs_id: cause, entity: signal.entityId, state: stateOf(signal), at: signal.at, by: await by(raw?.context) };
      } else origin = { id: cause };
    }
    const effects = deps.journal
      .queryEvents({ causationId: eventId, order: "asc", limit: 100 })
      .map((r) => hop(r, local));
    return { event_id: eventId, hops, ...(origin !== undefined ? { origin } : {}), effects };
  }

  const stateOf = (s: SignalRow): string => {
    const raw = s.raw as Partial<HaEntityState> | null;
    return typeof raw?.state === "string" ? raw.state : String(s.normalized.value);
  };

  /** One entity's signal rows over a range, each with who caused it. */
  async function signals(entity: string, q: RangeQuery): Promise<Page<SignalEntry> & { entity: string }> {
    if (!deps.scope.observes(entity)) throw new Error(`${entity} is outside the house scope`);
    const order = q.order ?? "asc";
    const c = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    // The store's untilMs is exclusive; the range here includes its end.
    const range = c === undefined ? { sinceMs: q.fromMs, untilMs: q.toMs + 1 } : order === "asc" ? { sinceMs: c.at, untilMs: q.toMs + 1 } : { sinceMs: q.fromMs, untilMs: c.at + 1 };
    // Rows at the cursor's instant come back again and are dropped by page().
    const rows = deps.signals.query({ entityId: entity, ...range, order, limit: Math.min(5000, q.limit + 101) });
    if (rows.length === 0) return { entity, from: q.fromMs, to: q.toMs, rows: [] };
    const by = await attribution(Math.min(...rows.map((r) => r.at)), Math.max(...rows.map((r) => r.at)));
    const entries: SignalEntry[] = [];
    for (const r of rows) {
      const raw = r.raw as Partial<HaEntityState> | null;
      entries.push({
        at: r.at,
        state: stateOf(r),
        value: r.normalized.value,
        ...(r.normalized.unit ? { unit: r.normalized.unit } : {}),
        by: await by(raw?.context),
        obs_id: r.obsId,
        ...(r.origin !== "ha" ? { origin: r.origin } : {}),
      });
    }
    return { entity, from: q.fromMs, to: q.toMs, ...page(entries, order, q.limit, q.cursor) };
  }

  /**
   * One timeline for an entity (its changes, the calls on it, the decisions of the
   * instances that watch, read or own it) or for an instance (its decisions, the changes
   * of what it watches and owns, the calls on what it owns), with the pause and the
   * config changes, in time order.
   */
  async function timeline(target: { entity?: string; instance?: string }, q: RangeQuery): Promise<Page<TimelineRow> & { entity?: string; instance?: string }> {
    const { fromMs, toMs } = q;
    const all = deps.instances();
    let entities: string[];
    let instances: InstanceInfo[];
    if ((target.entity === undefined) === (target.instance === undefined)) throw new Error("give either entity or instance");
    if (target.entity !== undefined) {
      const e = target.entity;
      if (!deps.scope.observes(e)) throw new Error(`${e} is outside the house scope`);
      entities = [e];
      instances = all.filter((i) => i.watch.includes(e) || i.reads.includes(e) || i.actuates.includes(e) || i.uses.includes(e));
    } else {
      const k = target.instance!;
      instances = all.filter((i) => i.key === k || i.heuristic === k);
      if (instances.length === 0) throw new Error(`no heuristic instance ${k}`);
      entities = [...new Set(instances.flatMap((i) => [...i.watch, ...i.actuates, ...i.uses]))].filter((e) => deps.scope.observes(e));
    }
    const owned = target.entity !== undefined ? new Set(entities) : new Set(instances.flatMap((i) => [...i.actuates, ...i.uses]));
    const inRange = (at: number) => at >= fromMs && at <= toMs;
    const by = await attribution(fromMs, toMs);
    const rows: TimelineRow[] = [];

    // What changed: state changes (an attribute-only update is not one).
    for (const entity of entities) {
      let prev: string | undefined;
      for (const s of deps.signals.query({ entityId: entity, sinceMs: fromMs, untilMs: toMs + 1, order: "asc", limit: 5000 })) {
        const state = stateOf(s);
        if (state === prev) continue;
        const raw = s.raw as Partial<HaEntityState> | null;
        rows.push({ at: s.at, kind: "change", entity, ...(prev !== undefined ? { from: prev } : {}), to: state, by: await by(raw?.context), obs_id: s.obsId });
        prev = state;
      }
    }

    // Who called what on those entities.
    for (const r of readWindow({ category: AUDIT_CATEGORY }, fromMs, toMs)) {
      const p = r.payload as { domain: string; service: string; entityIds?: string[]; serviceData?: Record<string, unknown> };
      const hit = (p.entityIds ?? []).filter((e) => owned.has(e));
      const at = rowTime(r);
      if (hit.length === 0 || !inRange(at)) continue;
      rows.push({
        at,
        kind: "call",
        service: `${p.domain}.${p.service}`,
        entities: hit,
        ...(p.serviceData && Object.keys(p.serviceData).length > 0 ? { data: p.serviceData } : {}),
        by: await callCause(by, r),
        event_id: r.envelope?.eventId ?? "",
      });
    }

    // Why: the instances' decisions, each action with its fate.
    for (const i of instances) {
      const journaled = readWindow({ category: i.heuristic, entityId: i.id }, fromMs, toMs);
      for (const d of foldDecisions(i.heuristic, journaled)) if (inRange(d.at)) rows.push({ kind: "decision", ...d, event_id: d.event_id ?? "" });
    }

    // The pause stops every heuristic but the guards; config edits change what they do:
    // an edit that names the instances it touched shows for those only, one that does not
    // (a scope change, an old row) for all.
    const keys = new Set(instances.map((i) => i.key));
    for (const [category, kind] of [[CONTROL_CATEGORY, "pause"], [CONFIG_CATEGORY, "config"]] as const) {
      for (const r of readRange(deps.journal, { category }, fromMs, toMs, 1000)) {
        const at = rowTime(r);
        const p = payload(r);
        if (!inRange(at) || (kind === "config" && p.tag !== "ConfigChanged")) continue;
        const touched = Array.isArray(p["instances"]) ? (p["instances"] as string[]) : undefined;
        if (touched !== undefined && !touched.some((k) => keys.has(k))) continue;
        rows.push({
          at,
          kind,
          summary: summarize(r),
          ...(typeof p["by"] === "string" ? { by: p["by"] } : {}),
          event_id: r.envelope?.eventId ?? "",
          ...(touched !== undefined ? { instances: touched } : {}),
        });
      }
    }

    return { ...target, from: fromMs, to: toMs, ...page(rows, q.order ?? "asc", q.limit, q.cursor) };
  }

  return { zone, now, attribution, callCause, foldDecisions, chain, signals, timeline };
}

export type HouseRecord = ReturnType<typeof createHouseRecord>;

/**
 * GET api/timeline?entity=…|instance=…&from&to&limit&cursor&order: the same timeline
 * for the panel, times in epoch ms, each cause as { by, instance?, event? }.
 */
export function mountTimeline(app: Hono, record: HouseRecord): void {
  app.get("/api/timeline", async (c) => {
    const q = (k: string): string | undefined => c.req.query(k) || undefined;
    try {
      const now = record.now();
      const toMs = parseTime(q("to"), "to", record.zone(), now) ?? now;
      const fromMs = parseTime(q("from"), "from", record.zone(), now) ?? toMs - DEFAULT_WINDOW_MS;
      const order = q("order") ?? "asc";
      if (order !== "asc" && order !== "desc") throw new Error('order must be "asc" or "desc"');
      const limit = Math.max(1, Math.min(Number(q("limit") ?? 100) || 100, 1000));
      const entity = q("entity");
      const instance = q("instance");
      const cursor = q("cursor");
      return c.json(
        await record.timeline(
          { ...(entity !== undefined ? { entity } : {}), ...(instance !== undefined ? { instance } : {}) },
          { fromMs, toMs, limit, order, ...(cursor !== undefined ? { cursor } : {}) },
        ),
      );
    } catch (err) {
      return c.json({ error: "BadRequest", reason: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
