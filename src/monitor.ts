// monitor.ts — Teobeanie watching itself, in the household chat. Fed every journal batch
// as it is persisted (the same hook that feeds the SSE bus) and HA's connection state,
// it posts when something needs a person:
//
//   - Home Assistant unreachable for more than haDownMin minutes, and again when it is back;
//   - an action refused by the SafeActuator, or failed (a restart's "interrupted" is the
//     resend's business, a notice over its hourly limit is routine);
//   - a system user (another add-on, Node-RED) calling a service on an entity an active
//     instance controls: another automation working against Teobeanie;
//   - a heuristic throwing in decide();
//   - all heuristics paused, and resumed (pause.ts).
//
// One message per problem until it clears: by its own event (the next accepted action,
// the next decision, HA back) or after an hour without a recurrence. At most
// maxPerHour messages an hour in all; what the limit holds back is logged and counted
// in the next message. Optionally, a daily summary at a local time, read from the
// journal, so a restart during the day loses nothing.
//
// The monitor sends through the notifier directly: no heuristic's rate limit hides its
// messages, and nothing it does is journaled, so it never sees (or answers) itself.

import type { JournalQueryRow, JournalReader } from "@lambda-house/teob-ts/core";
import type { Notifier } from "./kernel/actuator.js";
import type { Action } from "./kernel/heuristic.js";
import type { InstanceInfo } from "./kernel/host.js";
import { INTERRUPTED, type InputSummary, type KernelEvent } from "./kernel/step.js";
import { localTimeOn, nextLocalTime } from "./kernel/clock.js";
import { AUDIT_CATEGORY, type AuditEvent } from "./audit.js";
import { CONTROL_CATEGORY, PAUSE_ENTITY, pauseFromJournal, type PauseEvent } from "./pause.js";

export interface MonitorOptions {
  /** Post problems as they happen. */
  alerts: boolean;
  /** "HH:MM" local time of the daily summary; undefined: no summary. */
  summaryTime?: string;
  /** Minutes HA may be unreachable before it is reported (default 5). */
  haDownMin?: number;
  /** Alert messages per rolling hour, all problems together (default 6). */
  maxPerHour?: number;
}

export interface MonitorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One persisted journal batch, as the runtime's post-persist hook hands it over. */
export interface MonitorBatch {
  category: string;
  entityId: string;
  records: ReadonlyArray<{ encoded: unknown }>;
  at: number;
}

export interface Monitor {
  onPersisted(batch: MonitorBatch): void;
  onConnection(connected: boolean): void;
  /** The house's time zone (HA's configuration); the summary is rescheduled in it. */
  setTimeZone(timeZone: string): void;
  /** Start counting HA as down until it connects, and schedule the summary. */
  start(): void;
  stop(): void;
  /** The summary of what the journal holds in [from, to), as it would be posted. */
  summary(from: number, to: number): string;
}

type Log = (level: "debug" | "info" | "warn" | "error", msg: string) => void;
type Instances = () => ReadonlyArray<Pick<InstanceInfo, "key" | "heuristic" | "id" | "mode" | "actuates" | "uses">>;

/** A problem with no clearing event of its own clears after this long without recurring. */
export const QUIET_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const PENDING_CAP = 1000;

/** Refusals that are Teobeanie working as configured, not problems. */
const ROUTINE_REFUSAL = [/^notification rate limit/, /^all heuristics paused$/];
/**
 * System users that stand for people: HA Cloud carries voice assistants' commands
 * (Google Assistant, Alexa), which a person gives.
 */
const PEOPLE_PROXIES = new Set(["system:Home Assistant Cloud"]);

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "21:00" → minutes past midnight; undefined for anything else. */
export function summaryMinutes(s: string | undefined): number | undefined {
  const m = s?.trim().match(HHMM);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "alex" for person:alex; anyone else as journaled. */
const who = (by: string): string => (by.startsWith("person:") ? by.slice("person:".length) : by);

/** "3 h 10 min", "25 min". */
function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 > 0 ? ` ${min % 60} min` : ""}`;
}

/** "light.turn_on light.hall" or "a notice". */
const actionLabel = (a: Action): string => (a.kind === "call" ? `${a.service} ${a.entities.join(", ")}` : "a notice");
/** What a problem with an action is keyed on: its entities, or the notices. */
const target = (a: Action): string => (a.kind === "call" ? [...a.entities].sort().join(",") : "notice");

function inputLabel(i: InputSummary): string {
  switch (i.kind) {
    case "signal":
      return `a change of ${i.entity ?? "?"}`;
    case "timer":
      return `timer ${i.timer ?? "?"}`;
    case "fact":
      return `a change of fact ${i.fact ?? "?"}`;
    case "command":
      return `/${i.command ?? "?"}`;
    case "trigger":
      return `trigger ${i.trigger ?? "?"}`;
    case "outcome":
      return "an action's outcome";
    case "start":
      return "start";
  }
}

export function createMonitor(deps: {
  notifier: Notifier;
  options: MonitorOptions;
  instances: Instances;
  journal: Pick<JournalReader, "queryEvents">;
  timeZone: string;
  log: Log;
  clock?: MonitorClock;
}): Monitor {
  const clock: MonitorClock = deps.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const { alerts } = deps.options;
  const haDownMs = (deps.options.haDownMin ?? 5) * 60_000;
  const maxPerHour = deps.options.maxPerHour ?? 6;
  const summaryAt = summaryMinutes(deps.options.summaryTime);
  if (deps.options.summaryTime && summaryAt === undefined) {
    deps.log("warn", `monitor: summary time "${deps.options.summaryTime}" is not HH:MM; no daily summary`);
  }
  let timeZone = deps.timeZone;

  /** Open problems: key → when it last recurred. */
  const open = new Map<string, number>();
  /** Send times of the alerts in the last hour. */
  let sent: number[] = [];
  let heldBack = 0;
  /** Requested actions not yet completed: actionId → instance and action. */
  const pending = new Map<string, { key: string; action: Action }>();
  /** Instances known to have acted before (the summary's "first action ever"). */
  const acted = new Set<string>();

  let connected = false;
  let downSince: number | undefined;
  let downTimer: unknown;
  let downReported = false;
  let summaryTimer: unknown;
  let stopped = false;

  const post = (text: string): void => {
    deps.notifier.send(text).catch((err) => deps.log("warn", `monitor: could not post: ${String(err)}`));
  };

  /** An alert, within the hourly limit. */
  const alert = (text: string): void => {
    const now = clock.now();
    sent = sent.filter((t) => t > now - HOUR_MS);
    if (sent.length >= maxPerHour) {
      heldBack++;
      deps.log("warn", `monitor: hourly limit (${maxPerHour}) reached, not posted: ${text}`);
      return;
    }
    sent.push(now);
    const more = heldBack > 0 ? `\n(${plural(heldBack, "more alert")} held back by the hourly limit; see the add-on log)` : "";
    heldBack = 0;
    deps.log("info", `monitor: ${text}`);
    post(text + more);
  };

  /** Report a problem unless it is open already. Several keys: one message, each key open. */
  const raise = (keys: string[], text: string): void => {
    if (!alerts) return;
    const now = clock.now();
    const fresh = keys.filter((k) => {
      const last = open.get(k);
      return last === undefined || now - last >= QUIET_MS;
    });
    for (const k of keys) open.set(k, now);
    if (fresh.length > 0) alert(text);
  };

  const clear = (key: string): void => {
    open.delete(key);
  };

  const instanceInfo = (key: string) => deps.instances().find((i) => i.key === key);

  function onKernel(key: string, events: KernelEvent[]): void {
    const shadow = events.some((e) => e.tag === "Decided" && e.mode === "shadow") ? " (shadow)" : "";
    for (const e of events) {
      switch (e.tag) {
        case "Decided":
          clear(`decide:${key}`);
          break;
        case "DecideFailed":
          raise([`decide:${key}`], `Teobeanie: ${key} failed deciding on ${inputLabel(e.input)}: ${e.error}`);
          break;
        case "ActionRequested":
        case "ActionResent":
          if (pending.size >= PENDING_CAP) pending.delete(pending.keys().next().value!);
          pending.set(e.actionId, { key, action: e.action });
          clear(`refused:${key}:${target(e.action)}`);
          break;
        case "ActionSuppressed":
          clear(`refused:${key}:${target(e.action)}`);
          break;
        case "ActionRefused":
          if (ROUTINE_REFUSAL.some((r) => r.test(e.reason))) break;
          raise([`refused:${key}:${target(e.action)}`], `Teobeanie: refused ${actionLabel(e.action)} for ${key}${shadow}: ${e.reason}`);
          break;
        case "ActionCompleted": {
          const p = pending.get(e.actionId);
          pending.delete(e.actionId);
          const what = p === undefined ? "any" : target(p.action);
          if (e.ok) {
            clear(`failed:${key}:${what}`);
          } else if (e.error !== INTERRUPTED) {
            const text =
              p?.action.kind === "notify"
                ? `Teobeanie: a notice from ${key} could not be sent: ${e.error ?? "unknown error"}`
                : `Teobeanie: ${p === undefined ? "an action" : actionLabel(p.action)} for ${key} failed: ${e.error ?? "unknown error"}`;
            raise([`failed:${key}:${what}`], text);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  function onAudit(e: AuditEvent): void {
    const by = String(e.by ?? "");
    if (!by.startsWith("system:") || PEOPLE_PROXIES.has(by)) return;
    const controlled = new Map<string, string>();
    for (const i of deps.instances()) {
      if (i.mode !== "active") continue;
      for (const entity of [...i.actuates, ...i.uses]) {
        if (e.entityIds.includes(entity) && !controlled.has(entity)) controlled.set(entity, i.key);
      }
    }
    if (controlled.size === 0) return;
    const entities = [...controlled.keys()];
    const owners = [...new Set(controlled.values())];
    raise(
      entities.map((x) => `fight:${x}`),
      `Teobeanie: ${by.slice("system:".length)} (a system user) called ${e.domain}.${e.service} on ${entities.join(", ")}, ` +
        `which ${owners.join(" and ")} controls. Another automation may be working against Teobeanie.`,
    );
  }

  /** The pause is a state, not a problem: one message when it starts, one when it ends. */
  function onPause(e: PauseEvent): void {
    if (!alerts) return;
    if (e.tag === "Paused") {
      alert(`Teobeanie: all heuristics paused by ${who(e.by)}${e.reason !== undefined ? ` (${e.reason})` : ""}. Nothing acts until they are resumed, except the guards (the leak shutoff).`);
      return;
    }
    const before = pauseFromJournal(deps.journal, e.at);
    const after = before.paused && before.at !== undefined ? `, after ${duration(e.at - before.at)}` : "";
    alert(`Teobeanie: heuristics resumed by ${who(e.by)}${after}.`);
  }

  // ---- Home Assistant connection ----

  const startDown = (): void => {
    if (downSince !== undefined || stopped) return;
    downSince = clock.now();
    if (!alerts) return;
    downTimer = clock.setTimeout(() => {
      downTimer = undefined;
      if (connected || downSince === undefined) return;
      downReported = true;
      open.set("ha", clock.now());
      alert(`Teobeanie: Home Assistant has been unreachable for ${Math.round((clock.now() - downSince) / 60_000)} min. Heuristics cannot see or switch anything until it is back.`);
    }, haDownMs);
  };

  // ---- daily summary ----

  /** Every row of one stream (or category) in [from, to), oldest first. */
  function rows(q: { category: string; entityId?: string }, from: number, to: number): JournalQueryRow[] {
    const out: JournalQueryRow[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = deps.journal.queryEvents({ ...q, sinceMs: from, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
      for (const r of page) {
        if (r.ts * 1000 >= to) return out;
        out.push(r);
      }
      if (page.length < 1000) return out;
      cursor = page.at(-1)!.globalSeq;
    }
  }

  /** Whether the instance requested any action before `before` (scans its stream once). */
  function actedBefore(i: { key: string; heuristic: string; id: string }, before: number): boolean {
    if (acted.has(i.key)) return true;
    let cursor: number | undefined;
    for (;;) {
      const page = deps.journal.queryEvents({ category: i.heuristic, entityId: i.id, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
      for (const r of page) {
        if (r.ts * 1000 >= before) return false;
        if ((r.payload as { tag?: string } | null)?.tag === "ActionRequested") {
          acted.add(i.key);
          return true;
        }
      }
      if (page.length < 1000) return false;
      cursor = page.at(-1)!.globalSeq;
    }
  }

  function summary(from: number, to: number): string {
    const dayTime = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    /** "Tue 21:00", house time. */
    const at = (ms: number): string => dayTime.format(new Date(ms));
    const lines = [`Teobeanie daily summary since ${at(from)}`];
    const instances = [...deps.instances()].sort((a, b) => a.key.localeCompare(b.key));
    for (const i of instances) {
      const c = { calls: 0, notices: 0, shadowCalls: 0, shadowNotices: 0, refused: 0, failed: 0, errors: 0 };
      for (const r of rows({ category: i.heuristic, entityId: i.id }, from, to)) {
        const e = r.payload as KernelEvent;
        if (e.tag === "ActionRequested") {
          if (e.action.kind === "call") c.calls++;
          else c.notices++;
        } else if (e.tag === "ActionSuppressed") {
          if (e.action.kind === "call") c.shadowCalls++;
          else c.shadowNotices++;
        } else if (e.tag === "ActionRefused") c.refused++;
        else if (e.tag === "ActionCompleted" && !e.ok && e.error !== INTERRUPTED) c.failed++;
        else if (e.tag === "DecideFailed") c.errors++;
      }
      const parts = [
        c.calls > 0 ? plural(c.calls, "call") : "",
        c.notices > 0 ? plural(c.notices, "notice") : "",
        c.shadowCalls > 0 ? plural(c.shadowCalls, "shadow call") : "",
        c.shadowNotices > 0 ? plural(c.shadowNotices, "shadow notice") : "",
        c.refused > 0 ? `${c.refused} refused` : "",
        c.failed > 0 ? `${c.failed} failed` : "",
        c.errors > 0 ? plural(c.errors, "error") : "",
        c.calls + c.notices > 0 && !actedBefore(i, from) ? "first action ever" : "",
      ].filter(Boolean);
      if (c.calls + c.notices > 0) acted.add(i.key);
      if (parts.length > 0) lines.push(`${i.key}: ${parts.join(", ")}`);
    }
    if (lines.length === 1) lines.push("No actions.");

    // The pause: each pause and resume in the window, and whether it still holds.
    const changes = rows({ category: CONTROL_CATEGORY, entityId: PAUSE_ENTITY }, from, to)
      .map((r) => r.payload as PauseEvent)
      .filter((e) => (e.tag === "Paused" || e.tag === "Resumed") && e.at >= from && e.at < to);
    const end = pauseFromJournal(deps.journal, to);
    const still = end.paused ? `still paused${end.at !== undefined && end.at < from ? ` since ${at(end.at)} by ${who(end.by ?? "?")}` : ""}, only guards act` : "";
    if (changes.length > 0 || still !== "") {
      const each = changes.map((e) => `${e.tag === "Paused" ? "paused" : "resumed"} ${at(e.at)} by ${who(e.by)}${e.tag === "Paused" && e.reason !== undefined ? ` (${e.reason})` : ""}`);
      lines.push(`Pause: ${[...each, still].filter(Boolean).join(", ")}`);
    }

    // Calls not by Teobeanie (nor a person) on what an active instance controls.
    const controlled = new Set(instances.filter((i) => i.mode === "active").flatMap((i) => [...i.actuates, ...i.uses]));
    const others = new Map<string, number>();
    if (controlled.size > 0) {
      for (const r of rows({ category: AUDIT_CATEGORY }, from, to)) {
        const e = r.payload as AuditEvent;
        const by = String(e.by ?? "");
        if (!(by === "device" || by.startsWith("system:")) || PEOPLE_PROXIES.has(by)) continue;
        for (const x of e.entityIds ?? []) {
          if (controlled.has(x)) others.set(`${x} by ${by}`, (others.get(`${x} by ${by}`) ?? 0) + 1);
        }
      }
    }
    if (others.size > 0) {
      lines.push(`Calls by others on Teobeanie's entities: ${[...others].sort().map(([k, n]) => `${k} ${n}x`).join("; ")}`);
    }
    return lines.join("\n");
  }

  const scheduleSummary = (): void => {
    if (summaryTimer !== undefined) clock.clearTimeout(summaryTimer);
    summaryTimer = undefined;
    if (summaryAt === undefined || stopped) return;
    const at = nextLocalTime(clock.now(), summaryAt, timeZone);
    const fire = (): void => {
      // A timer that fires early (a clock step) waits for its time.
      if (clock.now() < at - 1000) {
        summaryTimer = clock.setTimeout(fire, at - clock.now());
        return;
      }
      try {
        post(summary(localTimeOn(at, -1, summaryAt, timeZone), at));
      } catch (err) {
        deps.log("error", `monitor: daily summary: ${String(err)}`);
      }
      scheduleSummary();
    };
    summaryTimer = clock.setTimeout(fire, at - clock.now());
  };

  return {
    onPersisted(batch) {
      try {
        const events = batch.records.map((r) => r.encoded as { tag?: string } | null).filter((e): e is { tag: string } => typeof e?.tag === "string");
        if (batch.category === AUDIT_CATEGORY) {
          for (const e of events) if (e.tag === "HaCallServiceObserved") onAudit(e as AuditEvent);
        } else if (batch.category === CONTROL_CATEGORY && batch.entityId === PAUSE_ENTITY) {
          for (const e of events) if (e.tag === "Paused" || e.tag === "Resumed") onPause(e as PauseEvent);
        } else if (instanceInfo(`${batch.category}/${batch.entityId}`) !== undefined) {
          onKernel(`${batch.category}/${batch.entityId}`, events as KernelEvent[]);
        }
      } catch (err) {
        deps.log("error", `monitor: ${String(err)}`);
      }
    },

    onConnection(c) {
      connected = c;
      if (!c) {
        startDown();
        return;
      }
      if (downTimer !== undefined) clock.clearTimeout(downTimer);
      downTimer = undefined;
      if (downReported && downSince !== undefined) {
        open.delete("ha");
        alert(`Teobeanie: Home Assistant is reachable again, after ${Math.max(1, Math.round((clock.now() - downSince) / 60_000))} min.`);
      }
      downReported = false;
      downSince = undefined;
    },

    setTimeZone(tz) {
      if (tz === timeZone) return;
      timeZone = tz;
      scheduleSummary();
    },

    start() {
      if (!connected) startDown();
      scheduleSummary();
    },

    stop() {
      stopped = true;
      if (downTimer !== undefined) clock.clearTimeout(downTimer);
      if (summaryTimer !== undefined) clock.clearTimeout(summaryTimer);
      downTimer = summaryTimer = undefined;
    },

    summary,
  };
}
