// The global pause: the actuator refusing everything but a guard's actions, the
// journaled Paused/Resumed with who gave them, the pause kept across a restart, a
// journal from before the pause loading, POST api/pause, and the MCP heuristics tool.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { categoryTypes, type JournalQueryRow } from "@lambda-house/teob-ts/core";
import { createSqliteJournal, createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import type { SignalRow } from "@lambda-house/teob-ts/ha";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { call, notify } from "../src/kernel/heuristic.js";
import { leakShutoff } from "../packages/leak-guard/leak-shutoff.ts";
import { relayPulse } from "../packages/relay-pulse/relay-pulse.ts";
import { houseScope } from "../src/allowlist.js";
import { AUDIT_CATEGORY, AUDIT_ENTITY, auditAggregate, auditEventCodec, auditStateCodec, type AuditCommand } from "../src/audit.js";
import {
  CONTROL_CATEGORY,
  PAUSE_ENTITY,
  createPauseControl,
  mountPause,
  pauseAggregate,
  pauseEventCodec,
  pauseFromJournal,
  pauseStateCodec,
  requestUser,
} from "../src/pause.js";
import { createHouseTools } from "../src/mcp/tools.js";
import type { InstanceInfo } from "../src/kernel/host.js";

const noLog = (): void => {};
const ok = async () => ({ context: { id: "ctx" } });
const tmpJournal = () => join(mkdtempSync(join(tmpdir(), "teobeanie-pause-")), "journal.db");

describe("the actuator under a pause", () => {
  it("refuses every call and notice, but an exempt instance's; a reload's reset drops the exemption", () => {
    const a = createSafeActuator({ ha: { callService: ok } });
    a.claim("relay-pulse/gate", ["switch.gate"]);
    a.claim("leak-shutoff/main", ["switch.valve"]);
    a.exemptFromPause("leak-shutoff/main");
    a.setPaused(true);
    expect(a.paused()).toBe(true);
    const refused = { ok: false, reason: "all heuristics paused" };
    expect(a.vet("relay-pulse/gate", call("switch.turn_on", "switch.gate"), 0, 10)).toEqual(refused);
    expect(a.vet("relay-pulse/gate", notify("hello"), 0, 10)).toEqual(refused);
    expect(a.vet("leak-shutoff/main", call("switch.turn_off", "switch.valve"), 0, 10)).toEqual({ ok: true });
    expect(a.vet("leak-shutoff/main", notify("leak"), 0, 10)).toEqual({ ok: true });
    // The guard's own forbids still hold through the exemption.
    a.forbid("switch.valve", "switch.turn_on", "human-only");
    expect(a.vet("leak-shutoff/main", call("switch.turn_on", "switch.valve"), 0, 10)).toEqual({ ok: false, reason: "human-only" });

    a.resetClaims();
    a.claim("leak-shutoff/main", ["switch.valve"]);
    expect(a.vet("leak-shutoff/main", call("switch.turn_off", "switch.valve"), 1, 10)).toEqual(refused);
    a.setPaused(false);
    expect(a.vet("leak-shutoff/main", call("switch.turn_off", "switch.valve"), 2, 10)).toEqual({ ok: true });
  });

  it("retries a failed guard call while paused, nobody else's", async () => {
    let n = 0;
    const a = createSafeActuator({
      ha: {
        callService: async () => {
          if (++n % 2 === 1) throw new Error("timeout");
          return { context: { id: "c" } };
        },
      },
      sleep: async () => {},
    });
    a.exemptFromPause("leak-shutoff/main");
    a.setPaused(true);
    expect(await a.execute(call("switch.turn_off", "switch.valve"), "leak-shutoff/main")).toMatchObject({ ok: true });
    expect(await a.execute(call("switch.turn_on", "switch.gate"), "relay-pulse/gate")).toEqual({ ok: false, error: "timeout (not retried: paused)" });
  });
});

describe("guards through the pause", () => {
  it("the leak shutoff closes the valve and alerts while everything else is paused", async () => {
    const callService = vi.fn(ok);
    const sent: string[] = [];
    const actuator = createSafeActuator({ ha: { callService }, notifier: { send: async (t) => void sent.push(t) } });
    const states: Record<string, string> = { "binary_sensor.leak_a": "off", "switch.valve": "on", "switch.gate": "off" };
    const host = createHeuristicHost({
      library: [leakShutoff, relayPulse],
      instances: [
        { heuristic: "leak-shutoff", id: "main", mode: "active", params: { sensors: ["binary_sensor.leak_a"], valve: "switch.valve", text: "Leak:" } },
        { heuristic: "relay-pulse", id: "gate", mode: "active", params: { relays: ["switch.gate"], pressMs: 1000, recheckMs: 5000 } },
      ],
      actuator,
      liveState: (id) => (states[id] === undefined ? undefined : ({ entity_id: id, state: states[id], attributes: {}, last_changed: "", last_updated: "" } as never)),
      scope: houseScope([], ["binary_sensor.leak_a", "switch.valve", "switch.gate"]),
      forceShadow: false,
      log: noLog,
    });
    const journal = createSqliteJournal({ path: tmpJournal() });
    host.attach(journal);
    actuator.setPaused(true);
    await host.start({ subscribeTrigger: async () => async () => {} });

    expect(actuator.vet("relay-pulse/gate", call("switch.turn_on", "switch.gate"), Date.now(), 10)).toEqual({ ok: false, reason: "all heuristics paused" });
    states["binary_sensor.leak_a"] = "on";
    const row = {
      obsId: "o1",
      entityId: "binary_sensor.leak_a",
      at: Date.now(),
      haTimeFired: Date.now(),
      raw: { state: "on" },
      normalized: { value: true },
      origin: "ha",
      haVersion: null,
      policyVersion: 1,
    } as unknown as SignalRow;
    host.onSignal(row);
    await vi.waitFor(() => expect(callService).toHaveBeenCalledWith({ domain: "switch", service: "turn_off", target: { entity_id: ["switch.valve"] } }));
    await vi.waitFor(() => expect(sent).toEqual(["Leak: binary_sensor.leak_a"]));
    expect(journal.queryEvents({ category: "leak-shutoff", limit: 100 }).some((r) => r.manifest === "ActionRefused")).toBe(false);
    await host.stop();
    journal.close();
  });

  it("an instance that is off is not exempt", () => {
    const actuator = createSafeActuator({ ha: { callService: ok } });
    createHeuristicHost({
      library: [leakShutoff],
      instances: [{ heuristic: "leak-shutoff", id: "main", mode: "off", params: { sensors: ["binary_sensor.leak_a"], valve: "switch.valve", text: "Leak:" } }],
      actuator,
      liveState: () => undefined,
      forceShadow: false,
      log: noLog,
    });
    actuator.setPaused(true);
    expect(actuator.vet("leak-shutoff/main", notify("x"), 0, 10)).toEqual({ ok: false, reason: "all heuristics paused" });
  });
});

describe("the journaled pause", () => {
  const open = (path: string) =>
    createSqliteRuntime({ path }, [registration(auditAggregate, auditEventCodec, auditStateCodec), registration(pauseAggregate, pauseEventCodec, pauseStateCodec)]);

  it("pause refuses, journaled with who; resume re-allows; a second pause of a paused house writes nothing", async () => {
    const { runtime, journal } = open(tmpJournal());
    const actuator = createSafeActuator({ ha: { callService: ok } });
    actuator.claim("relay-pulse/gate", ["switch.gate"]);
    let t = 1_000;
    const pause = createPauseControl({ runtime, journal, actuator, now: () => t });
    expect(pause.state()).toEqual({ paused: false });

    expect(await pause.set(true, "person:alex", "holiday")).toEqual({ paused: true, at: 1_000, by: "person:alex", reason: "holiday" });
    expect(actuator.vet("relay-pulse/gate", call("switch.turn_on", "switch.gate"), 0, 10)).toEqual({ ok: false, reason: "all heuristics paused" });
    t = 2_000;
    expect(await pause.set(true, "person:sam")).toMatchObject({ paused: true, by: "person:alex" });

    t = 3_000;
    expect(await pause.set(false, "person:sam")).toEqual({ paused: false, at: 3_000, by: "person:sam" });
    expect(actuator.vet("relay-pulse/gate", call("switch.turn_on", "switch.gate"), 0, 10)).toEqual({ ok: true });

    const rows = journal.queryEvents({ category: CONTROL_CATEGORY, order: "asc", limit: 10 });
    expect(rows.map((r) => [r.entityId, r.manifest, r.envelope?.origin, r.payload])).toEqual([
      ["pause", "Paused", "person:alex", { tag: "Paused", at: 1_000, by: "person:alex", reason: "holiday" }],
      ["pause", "Resumed", "person:sam", { tag: "Resumed", at: 3_000, by: "person:sam" }],
    ]);
    await runtime.shutdown();
    journal.close();
  });

  it("a restart keeps the house paused: the actuator is set from the journal before anything acts", async () => {
    const path = tmpJournal();
    const first = open(path);
    const pause = createPauseControl({ runtime: first.runtime, journal: first.journal, actuator: createSafeActuator({ ha: { callService: ok } }), now: () => 5_000 });
    await pause.set(true, "person:alex", "away");
    await first.runtime.shutdown();
    first.journal.close();

    const second = open(path);
    const actuator = createSafeActuator({ ha: { callService: ok } });
    const again = createPauseControl({ runtime: second.runtime, journal: second.journal, actuator, now: () => 9_000 });
    expect(actuator.paused()).toBe(true);
    expect(again.state()).toEqual({ paused: true, at: 5_000, by: "person:alex", reason: "away" });
    // The aggregate recovered the same state: resuming writes one event.
    expect(await again.set(false, "person:alex")).toEqual({ paused: false, at: 9_000, by: "person:alex" });
    expect(actuator.paused()).toBe(false);
    expect(second.journal.queryEvents({ category: CONTROL_CATEGORY, limit: 10 })).toHaveLength(2);
    await second.runtime.shutdown();
    second.journal.close();
  });

  it("a journal from before the pause loads: no stream, not paused, and the old streams stay", async () => {
    const path = tmpJournal();
    const old = createSqliteRuntime({ path }, [registration(auditAggregate, auditEventCodec, auditStateCodec)]);
    const cmd: AuditCommand = { tag: "RecordCallService", domain: "light", service: "turn_on", entityIds: ["light.a"], serviceData: {}, at: 1, haContextId: "c1", haParentId: null, haUserId: null, by: "device" };
    await old.runtime.tell(AUDIT_ENTITY, cmd, categoryTypes<AuditCommand, never>(AUDIT_CATEGORY));
    await vi.waitFor(() => expect(old.journal.lastGlobalSeq()).toBe(1));
    await old.runtime.shutdown();
    old.journal.close();

    const { runtime, journal } = open(path);
    const actuator = createSafeActuator({ ha: { callService: ok } });
    const pause = createPauseControl({ runtime, journal, actuator });
    expect(pause.state()).toEqual({ paused: false });
    expect(actuator.paused()).toBe(false);
    await pause.set(true, "local");
    expect(journal.queryEvents({ order: "asc", limit: 10 }).map((r) => r.manifest)).toEqual(["HaCallServiceObserved", "Paused"]);
    await runtime.shutdown();
    journal.close();
  });

  it("folds the stream up to a time", () => {
    const rows: JournalQueryRow[] = [
      { tag: "Paused", at: 10, by: "person:alex" },
      { tag: "Resumed", at: 20, by: "person:alex" },
    ].map((payload, i) => ({ globalSeq: i + 1, category: CONTROL_CATEGORY, entityId: PAUSE_ENTITY, sequenceNr: i + 1, manifest: payload.tag, payload, ts: 0, envelope: null }));
    const journal = { queryEvents: () => rows };
    expect(pauseFromJournal(journal, 15)).toEqual({ paused: true, at: 10, by: "person:alex" });
    expect(pauseFromJournal(journal)).toEqual({ paused: false, at: 20, by: "person:alex" });
  });
});

describe("api/pause", () => {
  const setup = () => {
    const { runtime, journal } = createSqliteRuntime({ path: tmpJournal() }, [registration(pauseAggregate, pauseEventCodec, pauseStateCodec)]);
    const actuator = createSafeActuator({ ha: { callService: ok } });
    const app = new Hono();
    mountPause(app, { mode: "addon", pause: createPauseControl({ runtime, journal, actuator }) });
    const post = (ip: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request("/api/pause", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }, { incoming: { socket: { remoteAddress: ip } } });
    return { app, actuator, post };
  };

  it("pauses through ingress only, as the session's HA user", async () => {
    const t = setup();
    expect((await t.post("172.30.33.4", { paused: true })).status).toBe(403);
    expect((await t.post("172.30.32.2", { paused: "yes" })).status).toBe(400);
    const res = await t.post("172.30.32.2", { paused: true, reason: "  testing  " }, { "x-remote-user-display-name": "Alex", "x-remote-user-id": "0123456789abcdef" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paused: true, by: "person:Alex", reason: "testing" });
    expect(t.actuator.paused()).toBe(true);
    expect(await (await t.app.request("/api/pause")).json()).toMatchObject({ paused: true, by: "person:Alex" });
    expect(await (await t.post("172.30.32.2", { paused: false }, { "x-remote-user-id": "0123456789abcdef" })).json()).toMatchObject({ paused: false, by: "user:01234567" });
    expect(t.actuator.paused()).toBe(false);
  });

  it("names the user as the ingress headers do", () => {
    const h = (headers: Record<string, string>) => (n: string) => headers[n];
    expect(requestUser(h({ "x-remote-user-name": "alex" }))).toBe("person:alex");
    expect(requestUser(h({}))).toBe("local");
  });
});

describe("the MCP heuristics tool", () => {
  it("says which instances the pause stops, since when and by whom", async () => {
    const info = (key: string, pattern?: string): InstanceInfo => {
      const [heuristic, id] = key.split("/") as [string, string];
      return { key, heuristic, id, title: key, mode: "active", configuredMode: "active", watch: [], reads: [], actuates: [], uses: [], commands: [], triggers: [], params: {}, alerts: false, ...(pattern ? { pattern } : {}) };
    };
    const tools = createHouseTools({
      scope: houseScope([], []),
      liveState: () => undefined,
      signals: { query: () => [] },
      journal: { queryEvents: () => [], eventByEventId: () => undefined, causationChain: () => [] } as never,
      ha: { send: async () => [] as never },
      instances: () => [info("leak-shutoff/main", "guard"), info("relay-pulse/gate", "momentary")],
      pause: () => ({ paused: true, at: Date.UTC(2026, 9, 12, 12, 0), by: "person:alex", reason: "holiday" }),
      configDir: tmpdir(),
      house: {},
      caller: () => undefined,
    });
    const r = await tools.find((t) => t.name === "heuristics")!.execute({});
    if (!r.success) throw new Error(r.error);
    const list = r.output as Array<{ key: string; paused?: unknown }>;
    expect(list.find((i) => i.key === "leak-shutoff/main")?.paused).toBeUndefined();
    expect(list.find((i) => i.key === "relay-pulse/gate")?.paused).toMatchObject({ by: "person:alex", reason: "holiday" });
  });
});
