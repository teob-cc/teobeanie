// twins.ts — a shadow twin beside an active instance: a package upgrade, new params or a
// rewritten rule, deciding on the same inputs as the original without acting. Here the
// two are compared: per input signal (its obsId) and per fact change (its FactChanged,
// which both hear: a twin reads the same facts), the actions each decided, and where
// they differ. Promote swaps them in one edit of heuristics.json, so it is one revision
// and a rollback undoes it.
//
// compareTwin and promoteTwin are plain functions: the panel's API calls them, and an
// agent's tools can too.

import type { JournalQueryRow, JournalReader } from "@lambda-house/teob-ts/core";
import type { Hono } from "hono";
import type { Action } from "./kernel/heuristic.js";
import type { InstanceInfo } from "./kernel/host.js";
import type { InputSummary } from "./kernel/step.js";
import { requestUser } from "./pause.js";
import type { Reloader, ReloadOutcome } from "./reload.js";
import { mayWrite } from "./studio/files.js";
import { promoteTwinText } from "./working-set.js";

/** What one side decided on an input. */
export interface TwinSide {
  why?: string;
  actions: Action[];
}

/** An input on which the twin and its original decided different actions. */
export interface TwinDifference {
  /** The input's shared id: the signal's obsId, or the FactChanged's event id. */
  obsId: string;
  /** When it was decided (the journal row's time, ms). */
  at: number;
  input: InputSummary;
  /** Absent: that side journaled no decision on it (nothing to do, nothing to say). */
  original?: TwinSide;
  twin?: TwinSide;
}

export interface TwinComparison {
  twin: string;
  original: string;
  from: number;
  to: number;
  /** Signals and fact changes either decided on since the twin's first decision. */
  compared: number;
  /** Of those, the ones on which both decided the same actions. */
  same: number;
  /** The rest, newest first (at most `limit`). */
  differences: TwinDifference[];
  /** Decisions on inputs that have no shared id (start, timers, triggers, commands): counted, not compared. */
  other: { original: number; twin: number };
}

const DECISION_ACTIONS = new Set(["ActionRequested", "ActionSuppressed", "ActionRefused"]);
const MAX_ROWS = 20_000;

/** An instance's journal rows since `fromMs`, oldest first. */
function streamRows(journal: Pick<JournalReader, "queryEvents">, key: string, fromMs: number, toMs: number): JournalQueryRow[] {
  const slash = key.indexOf("/");
  const [category, entityId] = [key.slice(0, slash), key.slice(slash + 1)];
  const out: JournalQueryRow[] = [];
  let cursor: number | undefined;
  while (out.length < MAX_ROWS) {
    const rows = journal.queryEvents({ category, entityId, sinceMs: fromMs, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    out.push(...rows.filter((r) => r.ts * 1000 <= toMs));
    if (rows.length < 1000 || rows.at(-1)!.ts * 1000 > toMs) break;
    cursor = rows.at(-1)!.globalSeq;
  }
  return out;
}

interface Decision {
  at: number;
  input: InputSummary;
  why?: string;
  actions: Action[];
}

/** Per input signal (obsId) or fact change (FactChanged event id), what the instance decided; and how many other decisions. */
function decisionsByObs(rows: JournalQueryRow[]): { byObs: Map<string, Decision>; other: number } {
  const actions = new Map<string, Action[]>();
  for (const r of rows) {
    if (!DECISION_ACTIONS.has(r.manifest) || r.envelope?.causationId === undefined) continue;
    const a = (r.payload as { action: Action }).action;
    actions.set(r.envelope.causationId, [...(actions.get(r.envelope.causationId) ?? []), a]);
  }
  const byObs = new Map<string, Decision>();
  let other = 0;
  for (const r of rows) {
    if (r.manifest !== "Decided") continue;
    const d = r.payload as { input: InputSummary; why?: string };
    const obsId = r.envelope?.causationId;
    if ((d.input.kind !== "signal" && d.input.kind !== "fact") || obsId === undefined) {
      other++;
      continue;
    }
    byObs.set(obsId, { at: r.ts * 1000, input: d.input, ...(d.why !== undefined ? { why: d.why } : {}), actions: actions.get(r.envelope!.eventId) ?? [] });
  }
  return { byObs, other };
}

/** An action as compared: its fields in a fixed order, the reply flag aside. */
const canonical = (a: Action): string => {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  const { reply: _reply, ...rest } = a as Action & { reply?: boolean };
  return JSON.stringify(sort(rest));
};
const sameActions = (a: Action[], b: Action[]): boolean => JSON.stringify(a.map(canonical).sort()) === JSON.stringify(b.map(canonical).sort());

/**
 * Where a twin's decisions differ from its original's on the same inputs, over
 * [fromMs, toMs]: per input signal or fact change either of them decided on since the twin's first
 * journaled row, the actions each decided (requested, suppressed or refused alike).
 */
export function compareTwin(
  journal: Pick<JournalReader, "queryEvents">,
  twinKey: string,
  originalKey: string,
  range: { fromMs: number; toMs: number },
  limit = 50,
): TwinComparison {
  const twinRows = streamRows(journal, twinKey, range.fromMs, range.toMs);
  const since = twinRows[0] !== undefined ? twinRows[0].ts * 1000 : range.toMs + 1;
  const twin = decisionsByObs(twinRows);
  const original = decisionsByObs(streamRows(journal, originalKey, Math.max(range.fromMs, since), range.toMs));
  const side = (d: Decision | undefined): TwinSide | undefined => (d === undefined ? undefined : { ...(d.why !== undefined ? { why: d.why } : {}), actions: d.actions });
  const differences: TwinDifference[] = [];
  let compared = 0;
  for (const obsId of new Set([...original.byObs.keys(), ...twin.byObs.keys()])) {
    const o = original.byObs.get(obsId);
    const t = twin.byObs.get(obsId);
    const first = (o ?? t)!;
    if (first.at < since) continue;
    compared++;
    if (sameActions(o?.actions ?? [], t?.actions ?? [])) continue;
    const os = side(o);
    const ts = side(t);
    differences.push({ obsId, at: Math.min(o?.at ?? Infinity, t?.at ?? Infinity), input: first.input, ...(os !== undefined ? { original: os } : {}), ...(ts !== undefined ? { twin: ts } : {}) });
  }
  differences.sort((a, b) => b.at - a.at);
  return {
    twin: twinKey,
    original: originalKey,
    from: range.fromMs,
    to: range.toMs,
    compared,
    same: compared - differences.length,
    differences: differences.slice(0, limit),
    other: { original: original.other, twin: twin.other },
  };
}

/**
 * Promote a twin, as `by`: in one edit of heuristics.json the original is removed (its
 * stream stays in the journal) and the twin takes its id and its mode, keeping its own
 * heuristic (and so its package and version) and params. Reloaded all or nothing; one
 * revision, which a rollback undoes. Throws when it is no twin.
 */
export function promoteTwin(deps: { reloader: Reloader }, twinKey: string, by: string): Promise<ReloadOutcome> {
  return deps.reloader.edit({
    file: "heuristics.json",
    by,
    change: (text) => {
      if (text === undefined) throw new Error("no heuristics.json in the config folder");
      const r = promoteTwinText(text, twinKey);
      return { text: r.text, summary: `promote ${twinKey} over ${r.original}${r.promoted !== twinKey ? `, now ${r.promoted}` : ""}` };
    },
  });
}

const peerOf = (c: unknown): string | undefined => (c as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;

const DAY_MS = 24 * 3600_000;

/**
 * GET api/twins (each twin with its comparison over the last day), GET
 * api/twins/<heuristic>/<id> (?from=&to= in ms, default the last day), and POST
 * api/twins/<heuristic>/<id>/promote through Home Assistant ingress only.
 */
export function mountTwins(
  app: Hono,
  deps: { mode: "addon" | "standalone"; journal: Pick<JournalReader, "queryEvents">; instances: () => InstanceInfo[]; reloader: Reloader; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  const range = (from?: string, to?: string): { fromMs: number; toMs: number } => {
    const toMs = to !== undefined && /^\d+$/.test(to) ? Number(to) : now();
    return { fromMs: from !== undefined && /^\d+$/.test(from) ? Number(from) : toMs - DAY_MS, toMs };
  };

  app.get("/api/twins", (c) => {
    const r = range(c.req.query("from"), c.req.query("to"));
    const twins = deps.instances().filter((i) => i.twinOf !== undefined);
    return c.json({ twins: twins.map((t) => compareTwin(deps.journal, t.key, t.twinOf!, r, 5)) });
  });

  app.get("/api/twins/:heuristic/:id", (c) => {
    const key = `${c.req.param("heuristic")}/${c.req.param("id")}`;
    const twin = deps.instances().find((i) => i.key === key);
    if (twin?.twinOf === undefined) return c.json({ error: "NotFound", reason: `${key} is not a running twin` }, 404);
    return c.json(compareTwin(deps.journal, key, twin.twinOf, range(c.req.query("from"), c.req.query("to"))));
  });

  app.post("/api/twins/:heuristic/:id/promote", async (c) => {
    if (!mayWrite(deps.mode, peerOf(c))) return c.json({ error: "Forbidden", reason: "promote through the Home Assistant panel only" }, 403);
    const key = `${c.req.param("heuristic")}/${c.req.param("id")}`;
    try {
      const outcome = await promoteTwin(deps, key, requestUser((h) => c.req.header(h)));
      return c.json(outcome, outcome.ok ? 200 : 422);
    } catch (err) {
      const reason = (err as Error).message;
      const missing = /no instance|not a twin/.test(reason);
      return c.json({ error: missing ? "NotFound" : "BadRequest", reason }, missing ? 404 : 400);
    }
  });
}
