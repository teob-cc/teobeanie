// MCP: the access check, the house tools over a made-up house, and the endpoint.

import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { JournalQuery, JournalQueryRow } from "@lambda-house/teob-ts/core";
import type { SignalRow } from "@lambda-house/teob-ts/ha";
import { houseScope } from "../src/allowlist.js";
import type { InstanceInfo } from "../src/kernel/host.js";
import { DEFAULT_MCP_NETWORKS, TAILSCALE_NETWORKS, checkAccess, clientAddress, mcpNetworks, networks } from "../src/mcp/access.js";
import { currentCaller, mountMcp } from "../src/mcp/index.js";
import { INSTRUCTIONS, createHouseTools, localTime } from "../src/mcp/tools.js";
import type { ToolCalled } from "../src/mcp/journal.js";
import { loadLibrary } from "../src/packages/library.js";

const root = join(import.meta.dirname, "..");
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0); // 08:00 in the house (New York, EDT)
const TZ = "America/New_York";
const MIN = 60_000;

describe("mcp access", () => {
  const tailnet = networks(TAILSCALE_NETWORKS);
  const h = (headers: Record<string, string>) => (n: string) => headers[n];

  it("the client is the last forwarded hop outside the Supervisor's network", () => {
    expect(clientAddress("100.101.102.103")).toBe("100.101.102.103");
    expect(clientAddress("100.101.102.103, 172.30.32.1")).toBe("100.101.102.103");
    // A LAN client claiming a tailnet address: HA appends the real one after it.
    expect(clientAddress("100.101.102.103, 192.168.1.20")).toBe("192.168.1.20");
    expect(clientAddress(undefined)).toBeUndefined();
  });

  it("add-on: only through ingress, only from the allowed networks", () => {
    const ok = checkAccess("addon", "172.30.32.2", h({ "x-forwarded-for": "100.101.102.103", "x-remote-user-name": "alex", "x-remote-user-id": "u1" }), tailnet);
    expect(ok).toEqual({ ok: true, caller: { via: "ingress", address: "100.101.102.103", user: "alex", userId: "u1" } });
    expect(checkAccess("addon", "172.30.32.2", h({ "x-forwarded-for": "192.168.1.20" }), tailnet)).toMatchObject({ ok: false });
    expect(checkAccess("addon", "172.30.33.4", h({ "x-forwarded-for": "100.101.102.103" }), tailnet)).toMatchObject({ ok: false }); // another add-on
    expect(checkAccess("addon", "172.30.32.2", h({ "x-forwarded-for": "fd7a:115c:a1e0::1234" }), tailnet)).toMatchObject({ ok: true });
    expect(checkAccess("standalone", "::ffff:127.0.0.1", h({}), tailnet)).toMatchObject({ ok: true });
    expect(checkAccess("standalone", "192.168.1.20", h({}), tailnet)).toMatchObject({ ok: false });
  });

  it("by default a LAN or tailnet client gets through ingress, a public address does not", () => {
    const allowed = networks(mcpNetworks(undefined, undefined));
    const via = (xff: string) => checkAccess("addon", "172.30.32.2", h({ "x-forwarded-for": xff }), allowed);
    for (const lan of ["192.168.1.20", "10.0.0.7", "172.16.0.9", "fd12:3456::1", "fe80::1c2b:3cff:fe4d:5e6f", "100.101.102.103", "fd7a:115c:a1e0::1234"]) {
      expect(via(lan), lan).toMatchObject({ ok: true, caller: { address: lan } });
    }
    for (const pub of ["203.0.113.9", "8.8.8.8", "172.32.0.1", "2001:db8::1"]) expect(via(pub), pub).toMatchObject({ ok: false });
    // A public client cannot pass by prefixing a LAN address of its own.
    expect(via("192.168.1.20, 203.0.113.9")).toMatchObject({ ok: false });
    // Only the Supervisor's own hops: no client to check.
    expect(via("172.30.32.1")).toMatchObject({ ok: false });
  });

  it("MCP_NETWORKS overrides the add-on option, which overrides the default; empty closes MCP", () => {
    expect(mcpNetworks(undefined, undefined)).toEqual([...DEFAULT_MCP_NETWORKS]);
    expect(mcpNetworks(undefined, ["192.168.1.0/24"])).toEqual(["192.168.1.0/24"]);
    expect(mcpNetworks(" 100.64.0.0/10 , 10.0.0.0/16 ", ["192.168.1.0/24"])).toEqual(["100.64.0.0/10", "10.0.0.0/16"]);
    expect(mcpNetworks("", ["192.168.1.0/24"])).toEqual(["192.168.1.0/24"]);
    const closed = networks(mcpNetworks(undefined, []));
    expect(checkAccess("addon", "172.30.32.2", h({ "x-forwarded-for": "192.168.1.20" }), closed)).toMatchObject({ ok: false });
  });
});

// ---- a made-up house ----

const scope = houseScope(["binary_sensor.hall_motion", "sensor.power", "light.porch"], ["light.hall"]);
const states: Record<string, { state: string; attributes: Record<string, unknown>; last_changed: string }> = {
  "binary_sensor.hall_motion": { state: "off", attributes: { friendly_name: "Hall motion" }, last_changed: new Date(T0 - 2 * MIN).toISOString() },
  "light.hall": { state: "on", attributes: { friendly_name: "Hall light" }, last_changed: new Date(T0 - 5 * MIN).toISOString() },
  "light.porch": { state: "off", attributes: {}, last_changed: new Date(T0 - 300 * MIN).toISOString() },
  "sensor.power": { state: "412", attributes: { unit_of_measurement: "W" }, last_changed: new Date(T0 - MIN).toISOString() },
  "camera.garden": { state: "idle", attributes: {}, last_changed: new Date(T0).toISOString() },
};
const sig = (entityId: string, at: number, state: string, context: object, value: unknown = state === "on"): SignalRow =>
  ({ obsId: `${entityId}${at}`, entityId, at, haTimeFired: at, raw: { state, context }, normalized: { value, unit: null }, origin: "ha", haVersion: null, policyVersion: 1 }) as SignalRow;
const signals: SignalRow[] = [
  sig("binary_sensor.hall_motion", T0 - 10 * MIN, "on", { id: "c-dev" }),
  sig("light.hall", T0 - 10 * MIN + 500, "on", { id: "c-teob" }),
  sig("binary_sensor.hall_motion", T0 - 2 * MIN, "off", { id: "c-dev2" }),
  sig("light.porch", T0 - 8 * MIN, "on", { id: "c-app", user_id: "u-alex" }),
  sig("light.porch", T0 - 7 * MIN, "off", { id: "c-nr" }),
  sig("light.porch", T0 - 6 * MIN, "on", { id: "c-auto", parent_id: "p1" }),
  sig("sensor.power", T0 - MIN, "412", { id: "c-p" }, 412),
];

let seq = 0;
const row = (category: string, entityId: string, payload: Record<string, unknown>, env: { eventId?: string; causationId?: string } = {}): JournalQueryRow =>
  ({ globalSeq: ++seq, category, entityId, sequenceNr: seq, manifest: String(payload["tag"]), payload, ts: Math.floor((payload["tag"] !== "TimerSet" ? ((payload["at"] as number) ?? T0) : T0) / 1000), envelope: env as never }) as JournalQueryRow;
const journalRows: JournalQueryRow[] = [
  // Rows from before attribution: no `by`, attributed when read.
  row("ha-audit", "nodered", { tag: "HaCallServiceObserved", domain: "light", service: "turn_on", entityIds: ["light.porch"], at: T0 - 8 * MIN, haContextId: "c-app", haUserId: "u-alex" }),
  row("ha-audit", "nodered", { tag: "HaCallServiceObserved", domain: "light", service: "turn_off", entityIds: ["light.porch", "camera.garden"], at: T0 - 7 * MIN, haContextId: "c-nr", haUserId: "u-sup" }),
  row("ha-audit", "nodered", { tag: "HaCallServiceObserved", domain: "camera", service: "snapshot", entityIds: ["camera.garden"], at: T0 - 3 * MIN, haContextId: "c-cam", haUserId: "u-sup" }),
  // Attributed rows.
  row("ha-audit", "nodered", { tag: "HaCallServiceObserved", domain: "light", service: "turn_on", entityIds: ["light.hall"], at: T0 - 10 * MIN + 200, haContextId: "c-teob", haUserId: "u-sup", by: "teob" }),
  row("ha-audit", "nodered", { tag: "HaCallServiceObserved", domain: "light", service: "turn_on", entityIds: ["light.porch"], at: T0 - 5 * MIN, haContextId: "c-u", haUserId: "0123456789abcdef", by: "user:01234567" }),
  row("ha-audit", "nodered", { tag: "HaCallServiceObserved", domain: "light", service: "turn_off", entityIds: ["light.porch"], at: T0 - 4 * MIN, haContextId: "c-dev3", haUserId: null, by: "device" }),
  row("occupancy-light", "hall", { tag: "Decided", at: T0 - 10 * MIN, input: { kind: "signal", entity: "binary_sensor.hall_motion" }, why: "hall motion on", mode: "active" }, { eventId: "d1" }),
  row("occupancy-light", "hall", { tag: "ActionRequested", actionId: "a1", action: { kind: "call", service: "light.turn_on", entities: ["light.hall"] } }, { eventId: "a1", causationId: "d1" }),
  row("occupancy-light", "hall", { tag: "ActionCompleted", actionId: "a1", ok: true, haContextId: "c-teob" }, { eventId: "x1", causationId: "a1" }),
  row("occupancy-light", "hall", { tag: "Decided", at: T0 - 2 * MIN, input: { kind: "signal", entity: "binary_sensor.hall_motion" }, why: "hall vacant, off in 5 min", mode: "active" }, { eventId: "d2" }),
  row("occupancy-light", "hall", { tag: "TimerSet", timer: "vacant", at: T0 + 3 * MIN, eid: "t1" }, { eventId: "t1", causationId: "d2" }),
  row("occupancy-light", "porch", { tag: "Decided", at: T0 - 6 * MIN, input: { kind: "signal" }, why: "porch motion", mode: "shadow" }, { eventId: "d3" }),
  row("occupancy-light", "porch", { tag: "ActionSuppressed", actionId: "a3", action: { kind: "call", service: "light.turn_on", entities: ["light.porch"] } }, { eventId: "a3", causationId: "d3" }),
];
const journal = {
  queryEvents: (q: JournalQuery) => {
    let rs = journalRows.filter(
      (r) => (!q.category || r.category === q.category) && (!q.entityId || r.entityId === q.entityId) && (q.sinceMs === undefined || r.ts * 1000 >= q.sinceMs),
    );
    const asc = q.order === "asc";
    rs = rs.sort((a, b) => (asc ? a.globalSeq - b.globalSeq : b.globalSeq - a.globalSeq));
    if (q.cursor !== undefined) rs = rs.filter((r) => (asc ? r.globalSeq > q.cursor! : r.globalSeq < q.cursor!));
    return rs.slice(0, q.limit ?? 100);
  },
  eventByEventId: () => undefined,
  causationChain: () => [],
};
const instances: InstanceInfo[] = ["hall", "porch"].map((id) => ({
  key: `occupancy-light/${id}`, heuristic: "occupancy-light", id, title: "Occupancy light", mode: id === "hall" ? "active" : "shadow", uses: [], commands: [],
  configuredMode: id === "hall" ? "active" : "shadow", watch: [`binary_sensor.${id}_motion`], reads: [], actuates: [`light.${id}`], triggers: [], params: { offAfterMin: 5 },
}));
const sent: Array<Record<string, unknown>> = [];
let zone: string | undefined = TZ;

// The starter packages as a folder without its own would load them (the CLI's view).
const starterPackages = (await loadLibrary(join(root, "examples", "rules"), () => {}, undefined, { withStarter: true })).packages;

const tools = createHouseTools({
  scope,
  liveState: (id) => (states[id] ? ({ entity_id: id, last_updated: "", ...states[id] } as never) : undefined),
  signals: { query: (q) => signals.filter((s) => s.entityId === q.entityId && s.at >= (q.sinceMs ?? 0)).sort((a, b) => a.at - b.at) },
  journal,
  ha: {
    send: async <T,>(m: Record<string, unknown>): Promise<T> => {
      sent.push(m);
      if (m["type"] === "config/auth/list")
        return [{ id: "u-alex", name: "alex", system_generated: false }, { id: "u-sup", name: "Supervisor", system_generated: true }] as T;
      return { "light.porch": [{ s: "off", lu: (T0 - 60 * MIN) / 1000 }, { s: "on", lu: (T0 - 8 * MIN) / 1000 }] } as T;
    },
  },
  instances: () => instances,
  configDir: join(root, "examples", "rules"),
  // The zone as HA last gave it: read on every call.
  house: {
    get timeZone() {
      return zone;
    },
  },
  packages: () => starterPackages,
  caller: () => ({ via: "ingress", user: "alex", address: "100.101.102.103" }),
  now: () => T0,
});
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await tools.find((t) => t.name === name)!.execute(args);
  if (!r.success) throw new Error(r.error);
  return r.output as never;
};

describe("house tools", () => {
  it("house_state shows only the scope, and says which asked-for entities are outside it", async () => {
    const all = (await call("house_state")) as { entities: Array<{ id: string; operable: boolean }> };
    expect(all.entities.map((e) => e.id)).toEqual(["binary_sensor.hall_motion", "light.hall", "light.porch", "sensor.power"]);
    expect(all.entities.find((e) => e.id === "light.hall")).toMatchObject({ name: "Hall light", state: "on", operable: true, since: "2026-10-12 07:55:00" });
    const asked = (await call("house_state", { entities: ["light.hall", "camera.garden"] })) as { entities: unknown[]; outside_scope: string[] };
    expect(asked.entities).toHaveLength(1);
    expect(asked.outside_scope).toEqual(["camera.garden"]);
    expect(((await call("house_state", { changed_within_min: 3 })) as { entities: Array<{ id: string }> }).entities.map((e) => e.id)).toEqual([
      "binary_sensor.hall_motion",
      "sensor.power",
    ]);
  });

  it("recent_changes says who changed what: Teobeanie, a person, a system user, an automation, the device", async () => {
    const r = (await call("recent_changes", { since_min: 30 })) as {
      changes: Array<{ entity: string; to: string; by: string }>;
      calls: Array<{ service: string; entities: string[]; by: string }>;
    };
    expect(r.changes.map((c) => `${c.entity} ${c.to} by ${c.by}`)).toEqual([
      "binary_sensor.hall_motion off by device",
      "light.porch on by automation",
      "light.porch off by system:Supervisor",
      "light.porch on by person:alex",
      "light.hall on by Teobeanie occupancy-light/hall",
      "binary_sensor.hall_motion on by device",
    ]); // sensor.power is numeric: left out
    // Calls on entities outside the scope are not shown, nor are those entities in a call.
    // Old rows (no `by`) are attributed from their user id; new rows carry their origin.
    expect(r.calls.map((c) => `${c.service} ${c.entities.join(",")} by ${c.by}`)).toEqual([
      "light.turn_off light.porch by device",
      "light.turn_on light.porch by user:01234567",
      "light.turn_off light.porch by system:Supervisor",
      "light.turn_on light.porch by person:alex",
      "light.turn_on light.hall by Teobeanie occupancy-light/hall",
    ]);
  });

  it("decisions fold each action's fate into the decision that made it", async () => {
    const d = (await call("decisions")) as Array<Record<string, unknown>>;
    expect(d.map((x) => [x["instance"], x["why"], x["actions"], x["timers"]])).toEqual([
      ["occupancy-light/hall", "hall vacant, off in 5 min", undefined, [{ timer: "vacant", at: localTime(T0 + 3 * MIN, TZ) }]],
      ["occupancy-light/porch", "porch motion", [{ action: "light.turn_on light.porch", status: "shadow: not sent", event_id: "a3" }], undefined],
      ["occupancy-light/hall", "hall motion on", [{ action: "light.turn_on light.hall", status: "done", event_id: "a1" }], undefined],
    ]);
    expect(((await call("decisions", { instance: "occupancy-light/porch" })) as unknown[]).length).toBe(1);
    expect(((await call("decisions", { actions_only: true })) as unknown[]).length).toBe(2);
  });

  it("history reads the recorder, but only inside the scope", async () => {
    const h = (await call("history", { entity: "light.porch", hours: 2 })) as { points: Array<{ state: string }> };
    expect(h.points.map((p) => p.state)).toEqual(["off", "on"]);
    expect(sent.at(-1)).toMatchObject({ type: "history/history_during_period", entity_ids: ["light.porch"] });
    await expect(call("history", { entity: "camera.garden" })).rejects.toThrow(/outside the house scope/);
  });

  it("heuristic_source lists and reads the packages' and the config folder's sources", async () => {
    const list = (await call("heuristic_source")) as { packages: Array<{ package: string; origin: string; heuristics: string[]; files: string[] }>; config_folder: string[] };
    expect(list.packages.find((p) => p.package === "door-watch")).toMatchObject({
      origin: "starter",
      heuristics: ["door-nag", "sustained-notice"],
      files: ["door-nag.ts", "door-watch.test.ts", "sustained-notice.ts"],
    });
    expect(list.config_folder).toEqual(["hallway-light.ts", "house-facts.ts", "pump-run-on.ts"]);
    const notice = (await call("heuristic_source", { name: "sustained-notice" })) as Record<string, unknown>;
    expect(notice).toMatchObject({ name: "door-watch/sustained-notice.ts", package: "door-watch", origin: "starter", modified: false, built_in: true, defines: ["sustained-notice"] });
    expect(notice["source"]).toMatch(/id: "sustained-notice"/);
    expect(((await call("heuristic_source", { name: "door-watch" })) as { name: string }).name).toBe("door-watch/door-nag.ts");
    expect(((await call("heuristic_source", { name: "door-watch/door-watch.test.ts" })) as { name: string }).name).toBe("door-watch/door-watch.test.ts");
    await expect(call("heuristic_source", { name: "door-watch/teobeanie.json" })).rejects.toThrow(/no heuristic source/);
    await expect(call("heuristic_source", { name: "door-watch/../../secrets" })).rejects.toThrow(/no heuristic source/);
    expect(((await call("heuristic_source", { name: "hallway-light" })) as { source: string }).source).toMatch(/rule\("hallway-light"/);
    await expect(call("heuristic_source", { name: "../../secrets" })).rejects.toThrow(/no heuristic source/);
  });

  it("heuristics report mode and the last decision", async () => {
    const h = (await call("heuristics")) as Array<{ key: string; mode: string; last_decision?: { why: string } }>;
    expect(h.map((i) => [i.key, i.mode, i.last_decision?.why])).toEqual([
      ["occupancy-light/hall", "active", "hall vacant, off in 5 min"],
      ["occupancy-light/porch", "shadow", "porch motion"],
    ]);
  });
});

describe("house time zone", () => {
  it("times are in the zone HA last gave, UTC while it has given none", async () => {
    const whoami = async () => (await call("whoami")) as { now: string; time_zone: string };
    expect(await whoami()).toMatchObject({ now: "2026-10-12 08:00:00", time_zone: "America/New_York" });
    zone = "Asia/Tokyo";
    expect(await whoami()).toMatchObject({ now: "2026-10-12 21:00:00", time_zone: "Asia/Tokyo" });
    expect(((await call("house_state")) as { time_zone: string }).time_zone).toBe("Asia/Tokyo");
    zone = undefined;
    expect(await whoami()).toMatchObject({ now: "2026-10-12 12:00:00", time_zone: "UTC" });
    zone = TZ;
    expect(INSTRUCTIONS).not.toMatch(/Europe|America|Asia/);
  });
});

describe("mcp endpoint", () => {
  function setup(mode: "addon" | "standalone", allowed: readonly string[] = TAILSCALE_NETWORKS) {
    const app = new Hono();
    const recorded: Array<Omit<ToolCalled, "tag">> = [];
    const whoami = tools.find((t) => t.name === "whoami")!;
    mountMcp(app, {
      mode,
      networks: allowed,
      tools: [{ ...whoami, execute: async () => ({ success: true, output: currentCaller() ?? null }) }],
      instructions: INSTRUCTIONS,
      version: "test",
      record: (c) => recorded.push(c),
      log: () => {},
    });
    const post = (body: unknown, peer: string, headers: Record<string, string> = {}) =>
      app.request("/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }, { incoming: { socket: { remoteAddress: peer } } });
    return { post, recorded };
  }

  it("serves tools through ingress from the tailnet, journals each call with its caller, refuses the rest", async () => {
    const { post, recorded } = setup("addon");
    const tailnet = { "x-forwarded-for": "100.101.102.103", "x-remote-user-name": "alex" };
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, "172.30.32.2", tailnet);
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("teobeanie");
    const listed = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "172.30.32.2", tailnet)).json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(["whoami"]);
    const who = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } }, "172.30.32.2", tailnet)).json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(who.result.content[0]!.text)).toEqual({ via: "ingress", address: "100.101.102.103", user: "alex" });
    expect(recorded).toEqual([expect.objectContaining({ tool: "whoami", ok: true, caller: { via: "ingress", address: "100.101.102.103", user: "alex" } })]);

    expect((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "172.30.32.2", { "x-forwarded-for": "192.168.1.20" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, "172.30.33.7", tailnet)).status).toBe(403);
    expect(recorded).toHaveLength(1);
  });

  it("with the default networks, a LAN client gets through ingress and a public address is refused", async () => {
    const { post, recorded } = setup("addon", mcpNetworks(undefined, undefined));
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } };
    const lan = await post(call, "172.30.32.2", { "x-forwarded-for": "192.168.1.20", "x-remote-user-name": "alex" });
    expect(lan.status).toBe(200);
    expect(JSON.parse(((await lan.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text)).toEqual({ via: "ingress", address: "192.168.1.20", user: "alex" });
    expect((await post(call, "172.30.32.2", { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
    expect(recorded).toHaveLength(1);
  });
});

describe("outdoor tool", () => {
  it("reports the readings with the entity each comes from", async () => {
    const live: Record<string, { state: string; attributes: Record<string, unknown> }> = {
      "weather.home": { state: "rainy", attributes: { temperature: 9, humidity: 88, wind_speed: 31, wind_bearing: 220 } },
      "sensor.outside_temp": { state: "11.5", attributes: { unit_of_measurement: "°C" } },
    };
    const t = createHouseTools({
      scope: houseScope(Object.keys(live), []),
      liveState: (id) => (live[id] ? ({ entity_id: id, last_changed: new Date(T0).toISOString(), last_updated: new Date(T0).toISOString(), ...live[id] } as never) : undefined),
      signals: { query: () => [] },
      journal,
      ha: { send: async () => [] as never },
      instances: () => [],
      configDir: root,
      house: { outdoor: { weather: "weather.home", temperature: "sensor.outside_temp" } },
      caller: () => undefined,
      now: () => T0,
    }).find((x) => x.name === "outdoor")!;
    const r = (await t.execute({})).output as Record<string, unknown>;
    expect(r).toMatchObject({ temperature: 11.5, humidity: 88, windSpeed: 31, windBearing: 220, condition: "rainy" });
    expect(r["sources"]).toMatchObject({ weather: { entity: "weather.home", state: "rainy" }, temperature: { entity: "sensor.outside_temp", state: "11.5" } });
  });
});
