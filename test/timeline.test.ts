// The record read back: causation chains, signal ranges and the merged timeline, over
// a real sqlite journal and signal store holding one made-up evening in the hall.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { CategoryId, EntityId, SequenceNr, ulid, type Codec } from "@lambda-house/teob-ts/core";
import { createSignalStore, type SignalRow } from "@lambda-house/teob-ts/ha";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import { houseScope } from "../src/allowlist.js";
import type { UserDirectory } from "../src/attribution.js";
import type { InstanceInfo } from "../src/kernel/host.js";
import { CONFIG_CATEGORY, createHouseRecord, mountTimeline, parseTime, type TimelineRow } from "../src/mcp/timeline.js";
import { INSTRUCTIONS, createHouseTools } from "../src/mcp/tools.js";

const TZ = "America/New_York";
const T0 = Date.UTC(2026, 9, 12, 19, 0, 0); // 15:00 in the house (EDT)
const NOW = T0 + 60 * 60_000;
const MIN = 60_000;

const dir = mkdtempSync(join(tmpdir(), "teobeanie-timeline-"));
const journal = createSqliteJournal({ path: join(dir, "journal.db") });
const store = createSignalStore({ path: join(dir, "signals.db") });
afterAll(() => {
  journal.close();
  store.close();
});

// ---- writing the evening ----

const passthrough: Codec<{ tag: string }> = { manifest: (e) => e.tag, encode: (e) => e, decode: (_m, d) => d as { tag: string } };
const seqs = new Map<string, number>();
/** One event as the runtime writes it, stamped as written at `at`; returns its event id. */
function write(category: string, entity: string, at: number, event: { tag: string; [k: string]: unknown }, causationId?: string): string {
  const key = `${category}:${entity}`;
  const seq = seqs.get(key) ?? 0;
  const eventId = ulid(at);
  journal.persistEvents(CategoryId(category), EntityId(entity), [event], SequenceNr(seq), passthrough, [
    { eventId, ...(causationId !== undefined ? { causationId } : {}), v: 1 },
  ]);
  seqs.set(key, seq + 1);
  journal.db.prepare("UPDATE journal SET timestamp = ? WHERE event_id = ?").run(Math.floor(at / 1000), eventId);
  return eventId;
}
let obs = 0;
function signal(entityId: string, at: number, state: string, context: object, value: unknown = state === "on"): string {
  const obsId = `obs-${++obs}`;
  store.append({ obsId, entityId, at, haTimeFired: at, raw: { state, context }, normalized: { value, unit: typeof value === "number" ? "W" : null }, origin: "ha", haVersion: null, policyVersion: 1 } as SignalRow);
  return obsId;
}
const call = (domain: string, service: string, entityIds: string[], at: number, haContextId: string, haUserId: string | null, by: string) =>
  write("ha-audit", "nodered", at, { tag: "HaCallServiceObserved", domain, service, entityIds, serviceData: {}, at, haContextId, haUserId, by }, haContextId);
const turnOn = { kind: "call", service: "light.turn_on", entities: ["light.hall"] };

// 15:00 motion; the hall instance turns the light on, HA's call carries its context.
const o1 = signal("binary_sensor.hall_motion", T0, "on", { id: "c-dev" });
const d1 = write("occupancy-light", "hall", T0 + 100, { tag: "Decided", input: { kind: "signal", entity: "binary_sensor.hall_motion", value: true, state: "on" }, why: "hall motion on", reads: {}, mode: "active" }, o1);
const a1 = write("occupancy-light", "hall", T0 + 100, { tag: "ActionRequested", actionId: "", action: turnOn, at: T0 }, d1);
const c1 = call("light", "turn_on", ["light.hall"], T0 + 300, "c-teob", "u-sup", "teob");
signal("light.hall", T0 + 350, "on", { id: "c-teob", user_id: "u-sup" });
write("occupancy-light", "hall", T0 + 400, { tag: "ActionCompleted", actionId: a1, ok: true, haContextId: "c-teob" }, a1);
// 15:10 someone pauses everything; 15:20 the hall empties, a timer is set.
const p1 = write("teob-control", "pause", T0 + 10 * MIN, { tag: "Paused", at: T0 + 10 * MIN, by: "person:alex", reason: "guests" });
const o2 = signal("binary_sensor.hall_motion", T0 + 20 * MIN, "off", { id: "c-dev2" });
const d2 = write("occupancy-light", "hall", T0 + 20 * MIN, { tag: "Decided", input: { kind: "signal", entity: "binary_sensor.hall_motion", value: false, state: "off" }, why: "hall vacant, off in 5 min", reads: {}, mode: "active" }, o2);
const t1 = write("occupancy-light", "hall", T0 + 20 * MIN, { tag: "TimerSet", timer: "vacant", at: T0 + 25 * MIN, eid: "" }, d2);
// 15:22 a person turns it off by hand; 15:25 the timer finds it off.
const c2 = call("light", "turn_off", ["light.hall"], T0 + 22 * MIN, "c-alex", "u-alex", "person:alex");
const o3 = signal("light.hall", T0 + 22 * MIN + 200, "off", { id: "c-alex", user_id: "u-alex" });
signal("light.hall", T0 + 22 * MIN + 900, "off", { id: "c-attr" }); // an attribute-only update
const d3 = write("occupancy-light", "hall", T0 + 25 * MIN, { tag: "Decided", input: { kind: "timer", timer: "vacant" }, why: "already off", reads: {}, mode: "active" }, t1);
// 15:30 a config edit, as a row from before the instance keys (global).
const k1 = write(CONFIG_CATEGORY, "heuristics.json", T0 + 30 * MIN, { tag: "ConfigChanged", at: T0 + 30 * MIN, file: "heuristics.json", by: "person:alex", summary: "occupancy-light/hall offAfterMin 5 → 10" });
// Elsewhere: the porch instance (shadow), power readings every minute.
const d4 = write("occupancy-light", "porch", T0 + 5 * MIN, { tag: "Decided", input: { kind: "signal", entity: "binary_sensor.porch_motion", state: "on" }, why: "porch motion", reads: {}, mode: "shadow" });
write("occupancy-light", "porch", T0 + 5 * MIN, { tag: "ActionSuppressed", actionId: "", action: { ...turnOn, entities: ["light.porch"] } }, d4);
const power = [0, 1, 2, 3, 4].map((i) => signal("sensor.power", T0 + i * MIN, String(400 + i), { id: `c-p${i}` }, 400 + i));
// After the evening's window.
signal("light.hall", T0 + 50 * MIN, "on", { id: "c-late" });

// ---- the house ----

const scope = houseScope(["binary_sensor.hall_motion", "sensor.power", "binary_sensor.porch_motion"], ["light.hall", "light.porch"]);
const instance = (id: string): InstanceInfo => ({
  key: `occupancy-light/${id}`, heuristic: "occupancy-light", id, title: "Occupancy light", mode: id === "hall" ? "active" : "shadow", configuredMode: id === "hall" ? "active" : "shadow",
  watch: [`binary_sensor.${id}_motion`], reads: [], actuates: [`light.${id}`], uses: [], commands: [], triggers: [], params: { offAfterMin: 5 }, alerts: false, notifyPerHour: 6,
});
const users: UserDirectory = {
  originOf: async (id) => (id === "u-alex" ? "person:alex" : id === "u-sup" ? "system:Supervisor" : `user:${id.slice(0, 8)}`),
  refresh: async () => {},
};
const deps = { scope, signals: store, journal, users, instances: () => [instance("hall"), instance("porch")], house: { timeZone: TZ }, now: () => NOW };
const record = createHouseRecord(deps);
const tools = createHouseTools({ ...deps, liveState: () => undefined, ha: { send: async () => [] as never }, configDir: dir, caller: () => undefined });
const tool = async (name: string, args: Record<string, unknown>) => {
  const r = await tools.find((t) => t.name === name)!.execute(args);
  if (!r.success) throw new Error(r.error);
  return r.output as never;
};
const evening = { fromMs: T0 - MIN, toMs: T0 + 40 * MIN, limit: 100 };

describe("chain", () => {
  it("walks a call Teobeanie made back through its HA context to the decision and the signal that started it", async () => {
    const c = await record.chain(c1, (ms) => new Date(ms).toISOString());
    expect(c.hops.map((h) => [h.event_id, h.tag, h.instance, h.via])).toEqual([
      [c1, "HaCallServiceObserved", "ha-audit/nodered", undefined],
      [a1, "ActionRequested", "occupancy-light/hall", "ha_context"],
      [d1, "Decided", "occupancy-light/hall", undefined],
    ]);
    expect(c.hops.map((h) => h.summary)).toEqual(["light.turn_on light.hall by Teobeanie", "requested light.turn_on light.hall", "binary_sensor.hall_motion → on: hall motion on"]);
    expect(c.origin).toEqual({ obs_id: o1, entity: "binary_sensor.hall_motion", state: "on", at: T0, by: { by: "device" } });
  });

  it("follows a fired timer to the decision that set it; the MCP tool gives house time and the effects", async () => {
    const c = (await tool("chain", { event_id: d3 })) as { hops: Array<{ event_id: string; at: string; summary: string }>; origin: { obs_id: string; by: string } };
    expect(c.hops.map((h) => [h.event_id, h.at, h.summary])).toEqual([
      [d3, "2026-10-12 15:25:00", "timer vacant: already off"],
      [t1, "2026-10-12 15:20:00", "timer vacant set for 2026-10-12 15:25:00"],
      [d2, "2026-10-12 15:20:00", "binary_sensor.hall_motion → off: hall vacant, off in 5 min"],
    ]);
    expect(c.origin).toMatchObject({ obs_id: o2, by: "device" });
    const d = (await tool("chain", { event_id: d1 })) as { effects: Array<{ event_id: string; tag: string }> };
    expect(d.effects.map((e) => [e.event_id, e.tag])).toEqual([[a1, "ActionRequested"]]);
    await expect(tool("chain", { event_id: "nope" })).rejects.toThrow(/no journal event nope/);
  });
});

describe("signals", () => {
  it("returns an entity's rows over a range, the end included, each with who caused it", async () => {
    const p = await record.signals("light.hall", evening);
    expect(p.rows.map((r) => [r.state, r.by])).toEqual([
      ["on", { by: "teob", instance: "occupancy-light/hall", event: a1 }],
      ["off", { by: "person:alex", event: c2 }],
      ["off", { by: "device" }],
    ]);
    expect((await record.signals("light.hall", { ...evening, toMs: T0 + 350 })).rows).toHaveLength(1);
    await expect(record.signals("camera.garden", evening)).rejects.toThrow(/outside the house scope/);
  });

  it("pages with a cursor, either way", async () => {
    const asc: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await record.signals("sensor.power", { ...evening, limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      asc.push(...p.rows.map((r) => r.obs_id));
      cursor = p.more;
    } while (cursor !== undefined);
    expect(asc).toEqual(power);
    const desc = await record.signals("sensor.power", { ...evening, limit: 3, order: "desc" });
    const rest = await record.signals("sensor.power", { ...evening, limit: 3, order: "desc", cursor: desc.more! });
    expect([...desc.rows, ...rest.rows].map((r) => r.obs_id)).toEqual([...power].reverse());
    expect(rest.more).toBeUndefined();
  });

  it("the MCP tool takes house times and shows the cause as in recent_changes", async () => {
    const r = (await tool("signals", { entity: "light.hall", from: "2026-10-12 15:00", to: "15:40" })) as { from: string; to: string; rows: Array<Record<string, unknown>> };
    expect([r.from, r.to]).toEqual(["2026-10-12 15:00:00", "2026-10-12 15:40:00"]);
    expect(r.rows[0]).toEqual({ at: "2026-10-12 15:00:00", state: "on", value: true, obs_id: expect.any(String), by: "Teobeanie occupancy-light/hall", cause: a1 });
    expect(r.rows[1]).toMatchObject({ state: "off", by: "person:alex", cause: c2 });
  });
});

describe("timeline", () => {
  const brief = (r: TimelineRow): string =>
    r.kind === "change"
      ? `change ${r.entity} ${r.to} by ${r.by.by}`
      : r.kind === "call"
        ? `call ${r.service} by ${r.by.by}`
        : r.kind === "decision"
          ? `decision ${r.instance} ${String(r.why)}${r.actions ? ` [${r.actions.map((a) => a.status).join(", ")}]` : ""}`
          : `${r.kind} ${r.summary}`;

  it("merges an entity's changes, the calls on it, its instances' decisions, the pause and config edits in time order", async () => {
    const p = await record.timeline({ entity: "light.hall" }, evening);
    expect(p.rows.map(brief)).toEqual([
      "decision occupancy-light/hall hall motion on [done]",
      "call light.turn_on by teob",
      "change light.hall on by teob",
      "pause paused by person:alex: guests",
      "decision occupancy-light/hall hall vacant, off in 5 min",
      "call light.turn_off by person:alex",
      "change light.hall off by person:alex", // the attribute-only update is not a change
      "decision occupancy-light/hall already off",
      "config heuristics.json: occupancy-light/hall offAfterMin 5 → 10",
    ]);
    // Every row can be cited.
    expect(p.rows.map((r) => ("obs_id" in r ? r.obs_id : r.event_id))).toEqual([d1, c1, expect.any(String), p1, d2, c2, o3, d3, k1]);
    expect(p.more).toBeUndefined();
  });

  it("for an instance: its decisions and what it watches and owns, not the other instances'", async () => {
    const p = await record.timeline({ instance: "occupancy-light/hall" }, evening);
    expect(p.rows.filter((r) => r.kind === "change").map(brief)).toEqual([
      "change binary_sensor.hall_motion on by device",
      "change light.hall on by teob",
      "change binary_sensor.hall_motion off by device",
      "change light.hall off by person:alex",
    ]);
    expect(p.rows.some((r) => r.kind === "decision" && r.instance !== "occupancy-light/hall")).toBe(false);
    const porch = await record.timeline({ instance: "occupancy-light/porch" }, evening);
    expect(porch.rows.filter((r) => r.kind === "decision").map(brief)).toEqual(["decision occupancy-light/porch porch motion [shadow: not sent]"]);
    await expect(record.timeline({ instance: "door-nag/front" }, evening)).rejects.toThrow(/no heuristic instance/);
    await expect(record.timeline({}, evening)).rejects.toThrow(/either entity or instance/);
  });

  it("is bounded: limit and a cursor page through the same rows, in either order", async () => {
    const all = (await record.timeline({ entity: "light.hall" }, evening)).rows.map(brief);
    for (const order of ["asc", "desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const p = await record.timeline({ entity: "light.hall" }, { ...evening, limit: 4, order, ...(cursor !== undefined ? { cursor } : {}) });
        expect(p.rows.length).toBeLessThanOrEqual(4);
        seen.push(...p.rows.map(brief));
        cursor = p.more;
      } while (cursor !== undefined);
      expect(seen).toEqual(order === "asc" ? all : [...all].reverse());
    }
  });

  it("the MCP tool: house times, causes flattened, a later change outside the window left out", async () => {
    const r = (await tool("timeline", { entity: "light.hall", from: "2026-10-12 14:59", to: "2026-10-12 15:40", limit: 3 })) as {
      rows: Array<Record<string, unknown>>;
      more: string;
    };
    expect(r.rows.map((x) => [x["at"], x["kind"]])).toEqual([
      ["2026-10-12 15:00:00", "decision"],
      ["2026-10-12 15:00:00", "call"],
      ["2026-10-12 15:00:00", "change"],
    ]);
    expect(r.rows[0]).toMatchObject({ instance: "occupancy-light/hall", why: "hall motion on", actions: [{ action: "light.turn_on light.hall", status: "done", event_id: a1 }], event_id: d1 });
    expect(r.rows[1]).toMatchObject({ service: "light.turn_on", by: "Teobeanie occupancy-light/hall", cause: a1, event_id: c1 });
    const rest = (await tool("timeline", { entity: "light.hall", from: "2026-10-12 14:59", to: "2026-10-12 16:00", cursor: r.more })) as { rows: Array<Record<string, unknown>> };
    expect(rest.rows.at(-1)).toMatchObject({ at: "2026-10-12 15:50:00", kind: "change", to: "on" });
  });

  it("is served at api/timeline, times in epoch ms", async () => {
    const app = new Hono();
    mountTimeline(app, record);
    const res = await app.request(`/api/timeline?entity=light.hall&from=${T0 - MIN}&to=${T0 + 40 * MIN}&order=desc&limit=2`);
    const body = (await res.json()) as { rows: TimelineRow[]; more: string };
    expect(body.rows.map((r) => [r.kind, r.at])).toEqual([
      ["config", T0 + 30 * MIN],
      ["decision", T0 + 25 * MIN],
    ]);
    expect(typeof body.more).toBe("string");
    expect((await app.request("/api/timeline?entity=camera.garden")).status).toBe(400);
  });
});

describe("times and instructions", () => {
  it("parses house times, ISO and epoch ms", () => {
    expect(parseTime("2026-10-12 15:00", "from", TZ, NOW)).toBe(T0);
    expect(parseTime("15:00:30", "from", TZ, NOW)).toBe(T0 + 30_000);
    expect(parseTime("2026-10-12T19:00:00Z", "from", TZ, NOW)).toBe(T0);
    expect(parseTime(String(T0), "from", TZ, NOW)).toBe(T0);
    expect(parseTime(undefined, "from", TZ, NOW)).toBeUndefined();
    expect(() => parseTime("yesterday", "from", TZ, NOW)).toThrow(/from: expected/);
  });

  it("the instructions name the new tools", () => {
    for (const t of ["chain", "signals", "timeline"]) expect(INSTRUCTIONS).toContain(t);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["chain", "signals", "timeline"]));
  });
});
