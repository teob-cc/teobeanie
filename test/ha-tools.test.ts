// The explore tools (ha_registry, ha_states, ha_history, ha_services, suggest) over a
// fake Home Assistant: their shapes, limits and paging, the registry refresh, the
// audit row, and house_state's cards.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import { houseScope } from "../src/allowlist.js";
import { createHaRegistry } from "../src/ha-registry.js";
import type { InstanceInfo } from "../src/kernel/host.js";
import { HISTORY_PAGE, createHaTools } from "../src/mcp/ha-tools.js";
import { mountMcp } from "../src/mcp/index.js";
import type { ToolCalled } from "../src/mcp/journal.js";
import { INSTRUCTIONS, createHouseTools } from "../src/mcp/tools.js";
import { starterPackages } from "../src/packages/library.js";

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0); // 14:00 in the house (Amsterdam, CEST)
const TZ = "Europe/Amsterdam";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const st = (id: string, state: string, attributes: Record<string, unknown> = {}, changedAgo = 5 * MIN): HaEntityState =>
  ({ entity_id: id, state, attributes, last_changed: new Date(T0 - changedAgo).toISOString(), last_updated: new Date(T0 - changedAgo).toISOString(), context: { id: "c" } }) as HaEntityState;

const states = new Map<string, HaEntityState>(
  [
    st("light.hall", "on", { friendly_name: "Hall light", brightness: 120 }),
    st("binary_sensor.hall_motion", "off", { friendly_name: "Hall motion", device_class: "motion" }),
    st("binary_sensor.front_door", "off", { friendly_name: "Front door", device_class: "door" }),
    st("sensor.kitchen_temperature", "21.5", { friendly_name: "Kitchen temperature", device_class: "temperature", unit_of_measurement: "°C" }),
    st("binary_sensor.bath_leak", "off", { friendly_name: "Bath leak", device_class: "moisture" }),
    st("valve.main_water", "open", { friendly_name: "Main water" }),
    st("switch.alpha_plug", "off", { friendly_name: "Plug identify" }),
    st("sun.sun", "above_horizon", { friendly_name: "Sun" }),
  ].map((s) => [s.entity_id, s]),
);

type Handler = (raw: { event: unknown; timeFired: number }) => void;
function fakeHa() {
  const sent: Array<Record<string, unknown>> = [];
  const events = new Map<string, Handler[]>();
  let areas = [
    { area_id: "hall", name: "Hall" },
    { area_id: "kitchen", name: "Kitchen", floor_id: "ground" },
    { area_id: "bath", name: "Bathroom" },
  ];
  let history: Array<{ s: string; lu: number }> = [];
  const ha = {
    sent,
    setAreas: (a: typeof areas) => (areas = a),
    setHistory: (h: typeof history) => (history = h),
    emit: (type: string) => (events.get(type) ?? []).forEach((h) => h({ event: {}, timeFired: T0 })),
    onEvent: (type: string, h: Handler) => {
      events.set(type, [...(events.get(type) ?? []), h]);
      return () => {};
    },
    async send<T>(m: Record<string, unknown>): Promise<T> {
      sent.push(m);
      switch (m["type"]) {
        case "config/area_registry/list":
          return areas as T;
        case "config/device_registry/list":
          return [
            { id: "dev-hall", name: "Hall hub", name_by_user: null, manufacturer: "Acme", model: "H1", area_id: "hall" },
            { id: "dev-plug", name: "Plug", name_by_user: "Kitchen plug", manufacturer: "Acme", model: "P2", area_id: "kitchen" },
          ] as T;
        case "config/entity_registry/list":
          return [
            { entity_id: "light.hall", platform: "hue", device_id: "dev-hall", area_id: null },
            { entity_id: "binary_sensor.hall_motion", platform: "zha", device_id: "dev-hall" },
            { entity_id: "binary_sensor.front_door", platform: "zha", area_id: "hall" },
            { entity_id: "sensor.kitchen_temperature", platform: "zha", area_id: "kitchen" },
            { entity_id: "binary_sensor.bath_leak", platform: "zha", area_id: "bath" },
            { entity_id: "valve.main_water", platform: "zha" },
            { entity_id: "switch.alpha_plug", platform: "zha", device_id: "dev-plug", entity_category: "config", hidden_by: "user" },
            { entity_id: "switch.printer", platform: "zha", device_id: "dev-plug", disabled_by: "user", original_name: "Old plug" },
          ] as T;
        case "homeassistant/expose_entity/list":
          return { exposed_entities: { "light.hall": { conversation: true }, "binary_sensor.front_door": { conversation: false } } } as T;
        case "history/history_during_period":
          return { [String((m["entity_ids"] as string[])[0])]: history } as T;
        case "get_services":
          return {
            light: { turn_on: { name: "Turn on", description: "Turns a light on.", target: { entity: [{ domain: ["light"] }] }, fields: { brightness: { required: false, example: 120, selector: { number: {} } } } }, turn_off: {} },
            notify: { notify: { fields: {} } },
          } as T;
      }
      throw new Error(`unexpected ${String(m["type"])}`);
    },
  };
  return ha;
}

const instances: InstanceInfo[] = [
  {
    key: "door-nag/front", heuristic: "door-nag", id: "front", title: "Door nag", mode: "shadow", configuredMode: "shadow",
    watch: ["binary_sensor.front_door"], reads: [], actuates: [], uses: [], commands: [], triggers: [], params: {}, alerts: false, notifyPerHour: 6,
  },
];

function setup(opts: { registryFails?: boolean } = {}) {
  const ha = fakeHa();
  const send = ha.send.bind(ha);
  if (opts.registryFails) ha.send = (async (m: Record<string, unknown>) => {
    if (String(m["type"]).startsWith("config/")) throw new Error("unauthorized");
    return send(m);
  }) as typeof ha.send;
  const registry = createHaRegistry({ ha, log: () => {} });
  const tools = createHaTools({
    ha,
    registry,
    states: () => states,
    scope: houseScope(["binary_sensor.front_door"], ["light.hall"]),
    house: { timeZone: TZ },
    instances: () => instances,
    starter: () => starterPackages(),
    now: () => T0,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find((t) => t.name === name)!.execute(args);
    if (!r.success) throw new Error(r.error);
    return r.output as never;
  };
  return { ha, tools, call };
}

describe("ha tools", () => {
  it("say they only read, and that nothing outside the scope is recorded", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual(["ha_registry", "ha_states", "ha_history", "ha_services", "suggest"]);
    for (const t of tools) expect(t.description, t.name).toMatch(/Read-only, and outside the house scope too: nothing it reads is recorded/);
    expect(INSTRUCTIONS).toMatch(/First call whoami/);
    expect(INSTRUCTIONS).toMatch(/ha_registry/);
  });

  it("ha_registry: areas with counts, entities with area (own or the device's), device, flags, scope; the page's devices", async () => {
    const { call } = setup();
    const r = await call("ha_registry");
    expect(r).toMatchObject({
      registry: true,
      count: 9,
      areas: [
        { id: "bath", name: "Bathroom", entities: 1 },
        { id: "hall", name: "Hall", entities: 3 },
        { id: "kitchen", name: "Kitchen", floor: "ground", entities: 2 },
      ],
    });
    const by = Object.fromEntries((r as { entities: Array<{ id: string }> }).entities.map((e) => [e.id, e]));
    expect(by["light.hall"]).toEqual({
      id: "light.hall", name: "Hall light", domain: "light", area: "Hall", area_from: "device", device: "Hall hub", device_id: "dev-hall", platform: "hue", exposed: true, in_scope: true, operable: true,
    });
    expect(by["binary_sensor.front_door"]).toMatchObject({ area: "Hall", device_class: "door", exposed: false, in_scope: true, operable: false });
    expect(by["switch.alpha_plug"]).toMatchObject({ hidden: true, category: "config", device: "Kitchen plug", area: "Kitchen" });
    expect(by["switch.printer"]).toMatchObject({ name: "Old plug", disabled: true });
    expect(by["sun.sun"]).toMatchObject({ registry: false, in_scope: false });
    expect((r as { devices: unknown[] }).devices).toEqual([
      { id: "dev-hall", name: "Hall hub", manufacturer: "Acme", model: "H1", area: "Hall" },
      { id: "dev-plug", name: "Kitchen plug", manufacturer: "Acme", model: "P2", area: "Kitchen" },
    ]);
  });

  it("ha_registry filters by area (id or name), domain, device class, search and exposed, and pages", async () => {
    const { call } = setup();
    const ids = async (a: Record<string, unknown>) => ((await call("ha_registry", a)) as { entities: Array<{ id: string }> }).entities.map((e) => e.id);
    expect(await ids({ area: "hall" })).toEqual(["binary_sensor.front_door", "binary_sensor.hall_motion", "light.hall"]);
    expect(await ids({ area: "KITCHEN", domain: "switch" })).toEqual(["switch.alpha_plug", "switch.printer"]);
    expect(await ids({ device_class: "moisture" })).toEqual(["binary_sensor.bath_leak"]);
    expect(await ids({ search: "hall hub" })).toEqual(["binary_sensor.hall_motion", "light.hall"]);
    expect(await ids({ exposed: true })).toEqual(["light.hall"]);
    await expect(call("ha_registry", { area: "attic" })).rejects.toThrow(/no area "attic"; areas: Bathroom, Hall, Kitchen/);
    const p1 = (await call("ha_registry", { limit: 4 })) as { entities: unknown[]; more?: string; devices: unknown[] };
    expect(p1.entities).toHaveLength(4);
    expect(p1.more).toBe("4");
    const p3 = (await call("ha_registry", { limit: 4, cursor: "8" })) as { entities: unknown[]; more?: string };
    expect(p3.entities).toHaveLength(1);
    expect(p3.more).toBeUndefined();
    await expect(call("ha_registry", { cursor: "x" })).rejects.toThrow(/cursor/);
  });

  it("reads the registries once, again after a registry event; says so when they cannot be read", async () => {
    const { call, ha } = setup();
    await call("ha_registry");
    await call("ha_registry", { domain: "light" });
    expect(ha.sent.filter((m) => m["type"] === "config/area_registry/list")).toHaveLength(1);
    ha.setAreas([{ area_id: "hall", name: "Entrance" }]);
    ha.emit("area_registry_updated");
    const r = (await call("ha_registry", { area: "Entrance" })) as { entities: Array<{ area: string }> };
    expect(r.entities.every((e) => e.area === "Entrance")).toBe(true);
    expect(ha.sent.filter((m) => m["type"] === "config/area_registry/list")).toHaveLength(2);

    const broken = setup({ registryFails: true });
    expect(await broken.call("ha_registry", { limit: 1 })).toMatchObject({ registry: false, note: expect.stringMatching(/could not be read/), areas: [] });
    await expect(broken.call("ha_states", { area: "Hall" })).rejects.toThrow(/registries are unavailable/);
  });

  it("ha_states: any entity's state in house time, by ids, domain or area, attributes when asked, paged", async () => {
    const { call } = setup();
    const r = (await call("ha_states", { entity_ids: ["sensor.kitchen_temperature", "light.not_listed"] })) as Record<string, unknown>;
    expect(r).toEqual({
      time_zone: TZ,
      now: "2026-10-12 14:00:00",
      count: 1,
      entities: [{ id: "sensor.kitchen_temperature", name: "Kitchen temperature", state: "21.5", unit: "°C", device_class: "temperature", last_changed: "2026-10-12 13:55:00", in_scope: false }],
      unknown: ["light.not_listed"],
    });
    const lights = (await call("ha_states", { domain: "light", attributes: true })) as { entities: Array<{ attributes: Record<string, unknown> }> };
    expect(lights.entities[0]!.attributes).toMatchObject({ brightness: 120 });
    const hall = (await call("ha_states", { area: "Hall", domain: "binary_sensor" })) as { entities: Array<{ id: string }> };
    expect(hall.entities.map((e) => e.id)).toEqual(["binary_sensor.front_door", "binary_sensor.hall_motion"]);
    const p = (await call("ha_states", { limit: 3 })) as { count: number; entities: unknown[]; more: string };
    expect(p).toMatchObject({ count: 8, more: "3" });
    expect(p.entities).toHaveLength(3);
    const last = (await call("ha_states", { limit: 3, cursor: "6" })) as { entities: unknown[]; more?: string };
    expect(last.entities).toHaveLength(2);
    expect(last.more).toBeUndefined();
    const max = (await call("ha_states", { limit: 5000 })) as { entities: unknown[] };
    expect(max.entities).toHaveLength(8);
  });

  it("ha_history: any entity, at most 7 days, pages of 2000 points in house time", async () => {
    const { call, ha } = setup();
    ha.setHistory(Array.from({ length: HISTORY_PAGE + 5 }, (_, i) => ({ s: String(i), lu: (T0 - DAY + i * 1000) / 1000 })));
    const r = (await call("ha_history", { entity: "sensor.kitchen_temperature" })) as { points: Array<{ at: string; state: string }>; total: number; more: string; unit: string; from: string; to: string };
    expect(r).toMatchObject({ entity: "sensor.kitchen_temperature", name: "Kitchen temperature", unit: "°C", from: "2026-10-11 14:00:00", to: "2026-10-12 14:00:00", total: HISTORY_PAGE + 5, more: String(HISTORY_PAGE) });
    expect(r.points).toHaveLength(HISTORY_PAGE);
    expect(r.points[0]).toEqual({ at: "2026-10-11 14:00:00", state: "0" });
    expect(ha.sent.at(-1)).toMatchObject({
      type: "history/history_during_period",
      entity_ids: ["sensor.kitchen_temperature"],
      start_time: new Date(T0 - DAY).toISOString(),
      end_time: new Date(T0).toISOString(),
      minimal_response: true,
      no_attributes: true,
    });
    const next = (await call("ha_history", { entity: "sensor.kitchen_temperature", cursor: r.more })) as { points: unknown[]; more?: string };
    expect(next.points).toHaveLength(5);
    expect(next.more).toBeUndefined();
    const range = (await call("ha_history", { entity: "light.hall", from: "2026-10-05 14:00", to: "2026-10-12 14:00" })) as { from: string };
    expect(range.from).toBe("2026-10-05 14:00:00");
    await expect(call("ha_history", { entity: "light.hall", from: "2026-10-05 13:59", to: "2026-10-12 14:00" })).rejects.toThrow(/at most 7 days/);
    await expect(call("ha_history", { entity: "light.hall", from: "12:00", to: "11:00" })).rejects.toThrow(/from is after to/);
    await expect(call("ha_history", {})).rejects.toThrow(/entity is required/);
    await expect(call("ha_history", { entity: "not an id" })).rejects.toThrow(/not an entity id/);
  });

  it("ha_services: the domains and their service names, or one domain's services with their fields", async () => {
    const { call } = setup();
    expect(await call("ha_services")).toEqual({ domains: [{ domain: "light", services: ["turn_off", "turn_on"] }, { domain: "notify", services: ["notify"] }] });
    expect(await call("ha_services", { domain: "light" })).toEqual({
      domain: "light",
      services: [
        { service: "light.turn_off", fields: {} },
        {
          service: "light.turn_on", name: "Turn on", description: "Turns a light on.", target: { entity: [{ domain: ["light"] }] },
          fields: { brightness: { required: false, example: 120, selector: { number: {} } } },
        },
      ],
    });
    await expect(call("ha_services", { domain: "lawn" })).rejects.toThrow(/no domain "lawn"/);
  });

  it("suggest: the starter packages bound to the house's entities by area; an instance's entities are skipped", async () => {
    const { call } = setup();
    const r = (await call("suggest", { limit: 50 })) as { suggestions: Array<{ heuristic: string; area: string | null; complete: boolean; bindings: Record<string, string[]>; installed: boolean }>; note: string };
    const by = new Map(r.suggestions.map((s) => [s.heuristic, s]));
    expect(by.get("sensor-light")).toMatchObject({ area: "Hall", complete: true, installed: false, bindings: { sensors: ["binary_sensor.hall_motion"], lights: ["light.hall"] } });
    expect(by.get("leak-shutoff")).toMatchObject({ area: null, complete: true, bindings: { sensors: ["binary_sensor.bath_leak"], valve: ["valve.main_water"] } });
    // The front door already has a door-nag instance; the hidden config switch is never bound.
    expect(by.get("door-nag")).toBeUndefined();
    expect(r.suggestions.flatMap((s) => Object.values(s.bindings).flat())).not.toContain("switch.alpha_plug");
    expect(r.note).toMatch(/README and example.json/);
    const hall = (await call("suggest", { area: "hall" })) as { area: string; suggestions: Array<{ area: string | null }> };
    expect(hall.area).toBe("Hall");
    expect(hall.suggestions.every((s) => s.area === "Hall")).toBe(true);
    expect(((await call("suggest", { limit: 2 })) as { suggestions: unknown[] }).suggestions).toHaveLength(2);
  });

  it("every call is journaled in mcp-audit, like the house tools", async () => {
    const { tools } = setup();
    const app = new Hono();
    const recorded: Array<Omit<ToolCalled, "tag">> = [];
    mountMcp(app, { mode: "standalone", networks: [], tools, instructions: INSTRUCTIONS, version: "test", record: (c) => recorded.push(c), log: () => {} });
    const res = await app.request(
      "/mcp",
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ha_states", arguments: { domain: "valve" } } }), headers: { "content-type": "application/json" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ count: 1, entities: [{ id: "valve.main_water", state: "open" }] });
    expect(recorded).toEqual([expect.objectContaining({ tool: "ha_states", args: '{"domain":"valve"}', ok: true, caller: { via: "local", address: "127.0.0.1" } })]);
  });
});

describe("house_state", () => {
  it("returns each instance's card", async () => {
    const tools = createHouseTools({
      scope: houseScope(["light.hall"], []),
      liveState: (id) => states.get(id),
      signals: { query: () => [] },
      journal: { queryEvents: () => [], eventByEventId: () => undefined, causationChain: () => [] } as never,
      ha: { send: async () => [] as never },
      instances: () => instances,
      configDir: "/nonexistent",
      house: { timeZone: TZ },
      cards: () => [{ key: "door-nag/front", heuristic: "door-nag", id: "front", mode: "shadow", card: { title: "Front door", values: [] } as never }],
      caller: () => undefined,
      now: () => T0,
    });
    const r = await tools.find((t) => t.name === "house_state")!.execute({});
    expect(r.output).toMatchObject({ count: 1, cards: [{ key: "door-nag/front", mode: "shadow", card: { title: "Front door" } }] });
  });
});
