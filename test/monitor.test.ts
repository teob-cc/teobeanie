// monitor: Teobeanie watching itself in the chat — each trigger, one message per problem
// until it clears, the hourly limit, HA down and back, the daily summary and its
// schedule across midnight and DST, the options off. Fake clock, fake notifier, a
// journal over an array.

import { describe, expect, it } from "vitest";
import type { JournalQuery, JournalQueryRow } from "@lambda-house/teob-ts/core";
import { createMonitor, summaryMinutes, type MonitorClock, type MonitorOptions } from "../src/monitor.js";
import { localTimeOn, nextLocalTime } from "../src/kernel/clock.js";
import type { Action } from "../src/kernel/heuristic.js";
import type { Mode } from "../src/kernel/actuator.js";

const TZ = "Europe/Amsterdam";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wed 14 Oct 2026, 12:00 in Amsterdam (CEST). */
const T0 = Date.UTC(2026, 9, 14, 10, 0);

/** A clock whose timers run when advance() passes them. */
function fakeClock(start: number): MonitorClock & { advance(ms: number): void; to(at: number): void; pending(): number } {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    to(at: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= at).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = at;
    },
    advance(ms: number) {
      clock.to(now + ms);
    },
    pending: () => timers.size,
  };
  return clock;
}

/** A journal over an array, answering the queries the monitor makes. Add rows in time order. */
function fakeJournal() {
  const rows: JournalQueryRow[] = [];
  return {
    rows,
    add(category: string, entityId: string, at: number, payload: { tag: string; [k: string]: unknown }) {
      rows.push({ globalSeq: rows.length + 1, category, entityId, sequenceNr: 0, manifest: payload.tag, payload, ts: Math.floor(at / 1000), envelope: null });
    },
    queryEvents(q: JournalQuery): JournalQueryRow[] {
      const asc = q.order === "asc";
      const hits = rows
        .filter((r) => (q.category === undefined || r.category === q.category) && (q.entityId === undefined || r.entityId === q.entityId))
        .filter((r) => q.sinceMs === undefined || r.ts >= Math.floor(q.sinceMs / 1000))
        .filter((r) => q.cursor === undefined || (asc ? r.globalSeq > q.cursor : r.globalSeq < q.cursor))
        .sort((a, b) => (asc ? a.globalSeq - b.globalSeq : b.globalSeq - a.globalSeq));
      return hits.slice(0, q.limit ?? 100);
    },
  };
}

interface Inst {
  key: string;
  heuristic: string;
  id: string;
  mode: Mode;
  actuates: string[];
  uses: string[];
}
const inst = (key: string, mode: Mode, actuates: string[], uses: string[] = []): Inst => {
  const [heuristic, id] = key.split("/") as [string, string];
  return { key, heuristic, id, mode, actuates, uses };
};
const INSTANCES = [
  inst("sensor-light/porch", "active", ["light.porch"]),
  inst("climate/attic", "active", ["climate.attic"]),
  inst("relay-pulse/gate", "active", [], ["switch.gate_relay"]),
  inst("door-nag/shed", "shadow", ["light.shed"]),
];

function harness(options: Partial<MonitorOptions> = {}, opts: { start?: number; tz?: string } = {}) {
  const clock = fakeClock(opts.start ?? T0);
  const journal = fakeJournal();
  const sent: string[] = [];
  const logs: string[] = [];
  const monitor = createMonitor({
    notifier: { send: async (text) => void sent.push(text) },
    options: { alerts: true, ...options },
    instances: () => INSTANCES,
    journal,
    timeZone: opts.tz ?? TZ,
    log: (level, msg) => void logs.push(`${level} ${msg}`),
    clock,
  });
  /** One persisted batch of an instance's (or the audit's) events. */
  const persist = (key: string, ...events: Array<{ tag: string; [k: string]: unknown }>) => {
    const [category, entityId] = key.split("/") as [string, string];
    monitor.onPersisted({ category, entityId, records: events.map((encoded) => ({ encoded })), at: clock.now() });
  };
  return { clock, journal, sent, logs, monitor, persist };
}

const call = (service: string, ...entities: string[]): Action => ({ kind: "call", service, entities });
const notice: Action = { kind: "notify", channel: "telegram", text: "Shed door still open" };
const decided = (mode: Mode = "active") => ({ tag: "Decided", input: { kind: "signal", entity: "binary_sensor.porch_motion" }, reads: {}, mode });
const audit = (by: string, service: string, ...entityIds: string[]) => ({
  tag: "HaCallServiceObserved",
  domain: service.split(".")[0],
  service: service.split(".")[1],
  entityIds,
  serviceData: {},
  at: 0,
  haContextId: "c1",
  haUserId: "u1",
  by,
});

describe("Home Assistant connection", () => {
  it("reports HA unreachable after the configured minutes, and back again", () => {
    const h = harness({ haDownMin: 5 });
    h.monitor.start();
    h.monitor.onConnection(true);
    h.clock.advance(HOUR);
    h.monitor.onConnection(false);
    h.clock.advance(4 * MIN);
    expect(h.sent).toEqual([]);
    h.clock.advance(MIN);
    expect(h.sent).toEqual(["Teobeanie: Home Assistant has been unreachable for 5 min. Heuristics cannot see or switch anything until it is back."]);
    h.clock.advance(7 * MIN);
    h.monitor.onConnection(true);
    expect(h.sent[1]).toBe("Teobeanie: Home Assistant is reachable again, after 12 min.");
  });

  it("says nothing about a short drop, and nothing resolved that was never reported", () => {
    const h = harness();
    h.monitor.start();
    h.monitor.onConnection(true);
    h.monitor.onConnection(false);
    h.clock.advance(2 * MIN);
    h.monitor.onConnection(true);
    h.clock.advance(HOUR);
    expect(h.sent).toEqual([]);
    expect(h.clock.pending()).toBe(0);
  });

  it("counts from start when HA never connects", () => {
    const h = harness({ haDownMin: 10 });
    h.monitor.start();
    h.clock.advance(10 * MIN);
    expect(h.sent).toEqual(["Teobeanie: Home Assistant has been unreachable for 10 min. Heuristics cannot see or switch anything until it is back."]);
  });

  it("reports each outage once, however long it lasts", () => {
    const h = harness();
    h.monitor.start();
    h.clock.advance(3 * HOUR);
    expect(h.sent).toHaveLength(1);
    h.monitor.onConnection(true);
    h.monitor.onConnection(false);
    h.clock.advance(5 * MIN);
    expect(h.sent).toHaveLength(3);
    expect(h.sent[1]).toBe("Teobeanie: Home Assistant is reachable again, after 180 min.");
  });
});

describe("refused and failed actions", () => {
  it("reports a refusal once until the same action is accepted", () => {
    const h = harness();
    const refused = { tag: "ActionRefused", actionId: "a1", action: call("light.turn_on", "light.porch"), reason: "rate limit: light.porch already actuated 30× in the last hour" };
    h.persist("sensor-light/porch", decided(), refused);
    h.persist("sensor-light/porch", decided(), { ...refused, actionId: "a2" });
    expect(h.sent).toEqual(["Teobeanie: refused light.turn_on light.porch for sensor-light/porch: rate limit: light.porch already actuated 30× in the last hour"]);
    h.persist("sensor-light/porch", decided(), { tag: "ActionRequested", actionId: "a3", action: call("light.turn_off", "light.porch"), at: 0 });
    h.persist("sensor-light/porch", decided(), { ...refused, actionId: "a4" });
    expect(h.sent).toHaveLength(2);
  });

  it("marks a shadow instance's refusal and skips routine ones", () => {
    const h = harness();
    h.persist("door-nag/shed", decided("shadow"), { tag: "ActionRefused", actionId: "a1", action: call("light.toggle", "light.shed"), reason: "toggle is banned: only absolute-state services retry safely" });
    h.persist("door-nag/shed", decided(), { tag: "ActionRefused", actionId: "a2", action: notice, reason: "notification rate limit (12/h)" });
    h.persist("door-nag/shed", decided(), { tag: "ActionRefused", actionId: "a3", action: call("light.turn_on", "light.shed"), reason: "all heuristics paused" });
    expect(h.sent).toEqual(["Teobeanie: refused light.toggle light.shed for door-nag/shed (shadow): toggle is banned: only absolute-state services retry safely"]);
  });

  it("reports a failed call and a failed notice, not one a restart interrupted", () => {
    const h = harness();
    h.persist("climate/attic", decided(), { tag: "ActionRequested", actionId: "a1", action: call("climate.set_hvac_mode", "climate.attic"), at: 0 });
    h.persist("climate/attic", { tag: "ActionCompleted", actionId: "a1", ok: false, error: "Entity climate.attic is unavailable" });
    h.persist("door-nag/shed", decided(), { tag: "ActionRequested", actionId: "a2", action: notice, at: 0 });
    h.persist("door-nag/shed", { tag: "ActionCompleted", actionId: "a2", ok: false, error: "telegram sendMessage 502: Bad Gateway" });
    h.persist("sensor-light/porch", decided(), { tag: "ActionRequested", actionId: "a3", action: call("light.turn_on", "light.porch"), at: 0 });
    h.persist("sensor-light/porch", { tag: "ActionCompleted", actionId: "a3", ok: false, error: "interrupted by restart" });
    expect(h.sent).toEqual([
      "Teobeanie: climate.set_hvac_mode climate.attic for climate/attic failed: Entity climate.attic is unavailable",
      "Teobeanie: a notice from door-nag/shed could not be sent: telegram sendMessage 502: Bad Gateway",
    ]);
  });

  it("reports the next failure only after a success in between", () => {
    const h = harness();
    const fail = (id: string) => {
      h.persist("climate/attic", decided(), { tag: "ActionRequested", actionId: id, action: call("climate.turn_on", "climate.attic"), at: 0 });
      h.persist("climate/attic", { tag: "ActionCompleted", actionId: id, ok: false, error: "timeout" });
    };
    fail("a1");
    fail("a2");
    expect(h.sent).toHaveLength(1);
    h.persist("climate/attic", decided(), { tag: "ActionRequested", actionId: "a3", action: call("climate.turn_on", "climate.attic"), at: 0 });
    h.persist("climate/attic", { tag: "ActionCompleted", actionId: "a3", ok: true, haContextId: "c" });
    fail("a4");
    expect(h.sent).toHaveLength(2);
  });

  it("names an action it did not see requested (before a restart) generically", () => {
    const h = harness();
    h.persist("climate/attic", { tag: "ActionCompleted", actionId: "old", ok: false, error: "timeout" });
    expect(h.sent).toEqual(["Teobeanie: an action for climate/attic failed: timeout"]);
  });
});

describe("another automation on Teobeanie's entities", () => {
  it("reports a system user's call on an entity an active instance controls", () => {
    const h = harness();
    h.persist("ha-audit/nodered", audit("system:Supervisor", "light.turn_off", "light.porch", "light.kitchen"));
    expect(h.sent).toEqual([
      "Teobeanie: Supervisor (a system user) called light.turn_off on light.porch, which sensor-light/porch controls. Another automation may be working against Teobeanie.",
    ]);
  });

  it("counts entities an instance uses, not only those it owns", () => {
    const h = harness();
    h.persist("ha-audit/nodered", audit("system:Supervisor", "switch.turn_on", "switch.gate_relay"));
    expect(h.sent[0]).toContain("which relay-pulse/gate controls");
  });

  it("ignores people, devices, voice assistants, Teobeanie and shadow instances' entities", () => {
    const h = harness();
    h.persist("ha-audit/nodered", audit("person:Alex", "light.turn_off", "light.porch"));
    h.persist("ha-audit/nodered", audit("device", "light.turn_off", "light.porch"));
    h.persist("ha-audit/nodered", audit("teob", "light.turn_off", "light.porch"));
    h.persist("ha-audit/nodered", audit("system:Home Assistant Cloud", "light.turn_off", "light.porch"));
    h.persist("ha-audit/nodered", audit("system:Supervisor", "light.turn_on", "light.shed"));
    h.persist("ha-audit/nodered", audit("nodered", "light.turn_on", "light.porch"));
    expect(h.sent).toEqual([]);
  });

  it("reports again only after an hour without a recurrence", () => {
    const h = harness();
    const fight = () => h.persist("ha-audit/nodered", audit("system:Supervisor", "climate.turn_on", "climate.attic"));
    fight();
    h.clock.advance(40 * MIN);
    fight();
    h.clock.advance(40 * MIN);
    fight();
    expect(h.sent).toHaveLength(1);
    h.clock.advance(61 * MIN);
    fight();
    expect(h.sent).toHaveLength(2);
  });
});

describe("a heuristic throwing", () => {
  it("reports DecideFailed once until the instance decides again", () => {
    const h = harness();
    const failed = { tag: "DecideFailed", input: { kind: "signal", entity: "binary_sensor.porch_motion" }, error: "Cannot read properties of undefined (reading 'x')" };
    h.persist("sensor-light/porch", failed);
    h.persist("sensor-light/porch", failed);
    expect(h.sent).toEqual(["Teobeanie: sensor-light/porch failed deciding on a change of binary_sensor.porch_motion: Cannot read properties of undefined (reading 'x')"]);
    h.persist("sensor-light/porch", decided());
    h.persist("sensor-light/porch", { ...failed, input: { kind: "timer", timer: "off" } });
    expect(h.sent[1]).toBe("Teobeanie: sensor-light/porch failed deciding on timer off: Cannot read properties of undefined (reading 'x')");
  });

  it("ignores streams that are not instances", () => {
    const h = harness();
    h.persist("mcp-audit/calls", { tag: "DecideFailed", input: { kind: "start" }, error: "x" });
    expect(h.sent).toEqual([]);
  });
});

describe("the global pause", () => {
  /** Journal the event, then hand the monitor its batch, as the runtime does. */
  const pauseEvent = (h: ReturnType<typeof harness>, e: { tag: string; at: number; by: string; reason?: string }) => {
    h.journal.add("teob-control", "pause", e.at, e);
    h.persist("teob-control/pause", e);
  };

  it("says who paused and why, and who resumed after how long", () => {
    const h = harness();
    pauseEvent(h, { tag: "Paused", at: T0, by: "person:alex", reason: "painting the hall" });
    h.clock.advance(3 * HOUR + 10 * MIN);
    pauseEvent(h, { tag: "Resumed", at: h.clock.now(), by: "person:sam" });
    expect(h.sent).toEqual([
      "Teobeanie: all heuristics paused by alex (painting the hall). Nothing acts until they are resumed, except the guards (the leak shutoff).",
      "Teobeanie: heuristics resumed by sam, after 3 h 10 min.",
    ]);
  });

  it("posts nothing with alerts off", () => {
    const h = harness({ alerts: false });
    pauseEvent(h, { tag: "Paused", at: T0, by: "person:alex" });
    expect(h.sent).toEqual([]);
  });

  it("is in the daily summary while it holds", async () => {
    const h = harness({ alerts: false });
    h.journal.add("teob-control", "pause", T0 - 2 * HOUR, { tag: "Paused", at: T0 - 2 * HOUR, by: "person:alex", reason: "away" });
    expect(await h.monitor.summary(T0)).toBe(["Teobeanie, Wed 14 Oct", "", "Needs attention:", "- All heuristics paused since 10:00 by alex: only guards act"].join("\n"));
    h.journal.add("teob-control", "pause", T0 + HOUR, { tag: "Resumed", at: T0 + HOUR, by: "person:alex" });
    expect(await h.monitor.summary(T0 + 2 * HOUR)).toBe("Teobeanie, Wed 14 Oct\n\nNothing needs attention.");
  });
});

describe("hourly limit", () => {
  it("sends at most maxPerHour alerts, then says how many it held back", () => {
    const h = harness({ maxPerHour: 6 });
    // One problem, however often: one message.
    for (let i = 0; i < 8; i++) h.persist("ha-audit/nodered", audit("system:Supervisor", "light.turn_on", "light.porch"));
    expect(h.sent).toHaveLength(1);
    const fail = (key: string, n: number) => h.persist(key, { tag: "DecideFailed", input: { kind: "start" }, error: `e${n}` });
    fail("climate/attic", 1);
    fail("door-nag/shed", 2);
    fail("relay-pulse/gate", 3);
    h.persist("climate/attic", { tag: "ActionCompleted", actionId: "x1", ok: false, error: "e4" });
    h.persist("door-nag/shed", { tag: "ActionCompleted", actionId: "x2", ok: false, error: "e5" });
    h.persist("relay-pulse/gate", { tag: "ActionCompleted", actionId: "x3", ok: false, error: "e6" });
    h.persist("sensor-light/porch", { tag: "ActionCompleted", actionId: "x4", ok: false, error: "e7" });
    expect(h.sent).toHaveLength(6);
    expect(h.logs.filter((l) => l.includes("hourly limit"))).toHaveLength(2);
    h.clock.advance(HOUR);
    fail("sensor-light/porch", 8);
    expect(h.sent[6]).toBe(
      "Teobeanie: sensor-light/porch failed deciding on start: e8\n(2 more alerts held back by the hourly limit; see the add-on log)",
    );
  });
});

describe("options", () => {
  it("alerts off: nothing is posted, not even HA down", () => {
    const h = harness({ alerts: false });
    h.monitor.start();
    h.clock.advance(HOUR);
    h.persist("sensor-light/porch", { tag: "DecideFailed", input: { kind: "start" }, error: "x" });
    h.persist("ha-audit/nodered", audit("system:Supervisor", "light.turn_on", "light.porch"));
    h.monitor.onConnection(true);
    expect(h.sent).toEqual([]);
  });

  it("no summary time, or a bad one: no summary", () => {
    for (const summaryTime of [undefined, "9pm", "24:00"]) {
      const h = harness({ alerts: false, ...(summaryTime !== undefined ? { summaryTime } : {}) });
      h.monitor.start();
      h.clock.advance(3 * 24 * HOUR);
      expect(h.sent).toEqual([]);
      if (summaryTime !== undefined) expect(h.logs.some((l) => l.includes("is not HH:MM"))).toBe(true);
    }
  });

  it("parses HH:MM", () => {
    expect(summaryMinutes("21:00")).toBe(21 * 60);
    expect(summaryMinutes(" 7:05 ")).toBe(7 * 60 + 5);
    expect(summaryMinutes("")).toBeUndefined();
    expect(summaryMinutes("25:00")).toBeUndefined();
  });
});

describe("daily summary", () => {
  /** Lets the summary's reads settle, then its post. */
  const settle = () => new Promise<void>((r) => setImmediate(r));

  it("lists Teobeanie's own problems still open, and drops them once they clear", async () => {
    const h = harness({ alerts: false });
    h.persist("climate/attic", { tag: "DecideFailed", input: { kind: "start" }, error: "boom" });
    h.persist("ha-audit/nodered", audit("system:Supervisor", "light.turn_on", "light.porch"));
    expect(await h.monitor.summary(h.clock.now())).toBe(
      [
        "Teobeanie, Wed 14 Oct",
        "",
        "Needs attention:",
        "- climate/attic failed deciding on start: boom",
        "- Supervisor (a system user) called light.turn_on on light.porch, which sensor-light/porch controls. Another automation may be working against Teobeanie.",
      ].join("\n"),
    );
    h.persist("climate/attic", decided());
    // A day later the call by another is no longer recent.
    h.clock.advance(25 * HOUR);
    expect(await h.monitor.summary(h.clock.now())).toBe("Teobeanie, Thu 15 Oct\n\nNothing needs attention.");
  });

  it("says so when the energy ledger or the house cannot be read", async () => {
    const clock = fakeClock(T0);
    const monitor = createMonitor({
      notifier: { send: async () => {} },
      options: { alerts: false },
      instances: () => INSTANCES,
      journal: fakeJournal(),
      timeZone: TZ,
      log: () => {},
      clock,
      energy: async () => Promise.reject(new Error("Home Assistant connection lost")),
      house: async () => Promise.reject(new Error("no states yet")),
    });
    expect(await monitor.summary(T0)).toBe(
      ["Teobeanie, Wed 14 Oct", "Energy: the ledger could not be read (Home Assistant connection lost)", "", "Needs attention:", "- The house could not be read (no states yet)"].join("\n"),
    );
  });

  it("is posted at the local time each day, across the end of DST", async () => {
    // Sat 24 Oct 2026 12:00 CEST; DST ends Sun 25 Oct 03:00 → 02:00.
    const h = harness({ alerts: false, summaryTime: "21:00" }, { start: Date.UTC(2026, 9, 24, 10, 0) });
    h.monitor.start();
    h.clock.to(Date.UTC(2026, 9, 24, 19, 0) - 1);
    await settle();
    expect(h.sent).toEqual([]);
    h.clock.advance(1);
    await settle();
    expect(h.sent).toEqual(["Teobeanie, Sat 24 Oct\n\nNothing needs attention."]);
    // 21:00 CET on Sunday is 20:00 UTC: 25 hours later
    h.clock.to(Date.UTC(2026, 9, 25, 19, 59));
    await settle();
    expect(h.sent).toHaveLength(1);
    h.clock.to(Date.UTC(2026, 9, 25, 20, 0));
    await settle();
    expect(h.sent).toEqual(["Teobeanie, Sat 24 Oct\n\nNothing needs attention.", "Teobeanie, Sun 25 Oct\n\nNothing needs attention."]);
  });

  it("crosses midnight, and follows the house's time zone once it is known", async () => {
    // Process in UTC until HA says Amsterdam; summary at 00:15.
    const start = Date.UTC(2026, 9, 14, 21, 0); // 23:00 CEST
    const h = harness({ alerts: false, summaryTime: "00:15" }, { start, tz: "UTC" });
    h.monitor.start();
    h.monitor.setTimeZone(TZ);
    h.clock.to(Date.UTC(2026, 9, 14, 22, 15) - 1);
    await settle();
    expect(h.sent).toEqual([]);
    h.clock.advance(1);
    await settle();
    expect(h.sent).toEqual(["Teobeanie, Thu 15 Oct\n\nNothing needs attention."]);
  });

  it("lands a time the start of DST skips an hour later", async () => {
    // Sun 29 Mar 2026: 02:00 CET → 03:00 CEST; 02:30 does not exist.
    const h = harness({ alerts: false, summaryTime: "02:30" }, { start: Date.UTC(2026, 2, 28, 12, 0) });
    h.monitor.start();
    h.clock.to(Date.UTC(2026, 2, 29, 1, 30) - 1);
    await settle();
    expect(h.sent).toEqual([]);
    h.clock.advance(1);
    await settle();
    expect(h.sent).toHaveLength(1);
  });
});

describe("local time helpers", () => {
  it("finds the next local time across midnight and DST", () => {
    const at = Date.UTC(2026, 9, 24, 21, 30); // Sat 23:30 CEST
    expect(nextLocalTime(at, 21 * 60, TZ)).toBe(Date.UTC(2026, 9, 25, 20, 0)); // Sun 21:00 CET
    expect(nextLocalTime(at, 23 * 60 + 45, TZ)).toBe(Date.UTC(2026, 9, 24, 21, 45));
    expect(localTimeOn(at, -1, 21 * 60, TZ)).toBe(Date.UTC(2026, 9, 23, 19, 0));
    expect(nextLocalTime(Date.UTC(2026, 0, 1, 12), 9 * 60, "UTC")).toBe(Date.UTC(2026, 0, 2, 9));
  });
});
