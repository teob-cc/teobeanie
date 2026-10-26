// The Infra tab's view (src/infra): what it reads from Home Assistant's states and
// registries, and the alerts that follow.

import { describe, expect, it } from "vitest";
import { infraView, onInfraTab, type InfraInput, type InfraState } from "../src/infra/extract.js";
import { parseInfraConfig } from "../src/infra/service.js";
import type { RegDevice, RegEntity } from "../src/ha-registry.js";
import type { InstanceCard } from "../src/kernel/card.js";

const NOW = Date.parse("2026-01-05T12:00:00Z");
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

type StateSpec = string | { state: string; attributes?: Record<string, unknown>; minAgo?: number };
const st = (s: StateSpec): InfraState =>
  typeof s === "string" ? { state: s, attributes: {}, last_changed: ago(60) } : { state: s.state, attributes: s.attributes ?? {}, last_changed: ago(s.minAgo ?? 60) };

/** A world: devices (with their MACs) and entities (with their device, platform and keys), and the states. */
function world(opts: {
  devices?: Array<Partial<RegDevice> & { id: string; name: string }>;
  entities?: Array<Partial<RegEntity> & { id: string }>;
  states: Record<string, StateSpec>;
  cards?: InstanceCard[];
}): InfraInput {
  const devices = new Map((opts.devices ?? []).map((d) => [d.id, { macs: [], service: false, ...d } as RegDevice]));
  const entities = new Map((opts.entities ?? []).map((e) => [e.id, { disabled: false, hidden: false, ...e } as RegEntity]));
  return { now: NOW, states: new Map(Object.entries(opts.states).map(([id, s]) => [id, st(s)])), registry: { ok: true, devices, entities }, cards: opts.cards ?? [] };
}

describe("infra: the internet link", () => {
  const gateway = {
    devices: [{ id: "gw", name: "Gateway", macs: ["aa:bb:cc:00:00:01"] }],
    entities: [
      { id: "binary_sensor.gateway_wan", deviceId: "gw", platform: "upnp", translationKey: "wan_status" },
      { id: "sensor.gateway_ip", deviceId: "gw", platform: "upnp", translationKey: "external_ip" },
      { id: "sensor.gateway_down", deviceId: "gw", platform: "upnp", translationKey: "download_speed" },
      { id: "sensor.gateway_up", deviceId: "gw", platform: "upnp", translationKey: "upload_speed" },
      { id: "sensor.gateway_uptime", deviceId: "gw", platform: "upnp", translationKey: "uptime" },
    ],
  };

  it("reads a UPnP gateway by its translation keys: WAN, external IP, speeds, when it started", () => {
    const v = infraView(
      world({
        ...gateway,
        states: {
          "binary_sensor.gateway_wan": { state: "on", attributes: { device_class: "connectivity" } },
          "sensor.gateway_ip": "203.0.113.7",
          "sensor.gateway_down": { state: "35.8", attributes: { unit_of_measurement: "KiB/s" } },
          "sensor.gateway_up": { state: "55.3", attributes: { unit_of_measurement: "KiB/s" } },
          "sensor.gateway_uptime": { state: "7200", attributes: { unit_of_measurement: "s" } },
        },
      }),
    );
    expect(v.internet).toEqual({
      name: "Gateway",
      online: true,
      since: NOW - 3_600_000,
      externalIp: "203.0.113.7",
      down: { value: 35.8, unit: "KiB/s" },
      up: { value: 55.3, unit: "KiB/s" },
      upSince: NOW - 7_200_000,
    });
    expect(v.alerts).toEqual([]);
    // The gateway is the internet part, not a device; its WAN sensor is not a leftover link.
    expect(v.devices).toEqual([]);
    expect(v.ha.links).toEqual([]);
    expect(v.available).toBe(true);
  });

  it("WAN down is an alert; without translation keys the entity id's end says which is which", () => {
    const v = infraView(
      world({
        devices: gateway.devices,
        entities: [{ id: "binary_sensor.gateway_wan_status", deviceId: "gw", platform: "upnp" }],
        states: { "binary_sensor.gateway_wan_status": { state: "off", attributes: { device_class: "connectivity" }, minAgo: 4 } },
      }),
    );
    expect(v.internet).toMatchObject({ online: false, since: NOW - 4 * 60_000 });
    expect(v.alerts).toEqual([{ tone: "bad", text: "Internet down", since: NOW - 4 * 60_000, from: "internet" }]);
  });
});

describe("infra: the mesh", () => {
  const nodes = {
    devices: [
      { id: "n0", name: "Main node", macs: ["aa:bb:cc:00:01:00"] },
      { id: "n1", name: "Upstairs node", macs: ["aa:bb:cc:00:01:01"] },
    ],
    entities: [
      { id: "device_tracker.mesh_main", deviceId: "n0", platform: "tplink_deco" },
      { id: "sensor.mesh_main_cpu", deviceId: "n0", platform: "tplink_deco", uniqueId: "AA-BB-CC-00-01-00_cpu_usage" },
      { id: "sensor.mesh_main_mem", deviceId: "n0", platform: "tplink_deco", uniqueId: "AA-BB-CC-00-01-00_mem_usage" },
      { id: "sensor.mesh_main_clients", deviceId: "n0", platform: "tplink_deco", uniqueId: "AA-BB-CC-00-01-00_client_count" },
      { id: "device_tracker.mesh_satellite", deviceId: "n1", platform: "tplink_deco" },
      { id: "sensor.mesh_satellite_backhaul", deviceId: "n1", platform: "tplink_deco", uniqueId: "AA-BB-CC-00-01-01_connection_type" },
      { id: "sensor.mesh_satellite_backhaul_speed", deviceId: "n1", platform: "tplink_deco", uniqueId: "AA-BB-CC-00-01-01_backhaul_speed" },
    ],
  };
  const node = (master: boolean, state = "home", extra: Record<string, unknown> = {}) => ({
    state,
    attributes: { source_type: "router", device_type: "deco", master, internet_online: true, sw_version: "1.3.2", ...extra },
  });

  it("each node with its load, clients and backhaul; the main node first", () => {
    const v = infraView(
      world({
        ...nodes,
        states: {
          "device_tracker.mesh_satellite": node(false),
          "device_tracker.mesh_main": node(true),
          "sensor.mesh_main_cpu": { state: "4.5", attributes: { unit_of_measurement: "%" } },
          "sensor.mesh_main_mem": { state: "54.1", attributes: { unit_of_measurement: "%" } },
          "sensor.mesh_main_clients": "14",
          "sensor.mesh_satellite_backhaul": "wired",
          "sensor.mesh_satellite_backhaul_speed": { state: "2500", attributes: { unit_of_measurement: "Mbit/s" } },
        },
      }),
    );
    expect(v.mesh).toEqual([
      { name: "Main node", online: true, main: true, since: NOW - 3_600_000, internet: true, cpu: { value: 4.5, unit: "%" }, memory: { value: 54.1, unit: "%" }, clients: 14, firmware: "1.3.2" },
      { name: "Upstairs node", online: true, main: false, since: NOW - 3_600_000, internet: true, backhaul: { type: "wired", speed: { value: 2500, unit: "Mbit/s" } }, firmware: "1.3.2" },
    ]);
    // Nodes are the mesh, not devices or clients.
    expect(v.devices).toEqual([]);
    expect(v.alerts).toEqual([]);
  });

  it("a node offline, without internet or at its limits is an alert", () => {
    const v = infraView(
      world({
        ...nodes,
        states: {
          "device_tracker.mesh_main": node(true, "home", { internet_online: false }),
          "sensor.mesh_main_cpu": { state: "96", attributes: { unit_of_measurement: "%" } },
          "device_tracker.mesh_satellite": { ...node(false, "not_home"), minAgo: 2 },
        },
      }),
    );
    expect(v.alerts.map((a) => a.text)).toEqual(["Upstairs node offline", "Main node: no internet", "Main node: CPU 96 %"]);
  });
});

describe("infra: the devices", () => {
  const camera = { id: "cam", name: "Garden camera", manufacturer: "Acme", model: "Cam 5", macs: ["aa:bb:cc:00:02:01"] };
  const cameraEntities = [
    { id: "camera.garden", deviceId: "cam", platform: "reolink" },
    { id: "binary_sensor.garden_motion", deviceId: "cam", platform: "reolink" },
    // The router's own record of the same client: never a device of its own.
    { id: "device_tracker.camera_tracker", deviceId: "cam-router", platform: "tplink_deco" },
  ];
  const routerRecord = { id: "cam-router", name: "Device_2EAD", macs: ["aa:bb:cc:00:02:01"] };
  const tracker = (state: string, attrs: Record<string, unknown> = {}, minAgo = 60) => ({
    state,
    attributes: { source_type: "router", mac: "AA-BB-CC-00-02-01", ip: "192.168.1.51", deco_device: "Level 2", connection_type: "wired", ...attrs },
    minAgo,
  });

  it("a device Home Assistant knows by its MAC: its own name and integration, how the router sees it", () => {
    const v = infraView(
      world({
        devices: [camera, routerRecord],
        entities: cameraEntities,
        states: { "camera.garden": "idle", "binary_sensor.garden_motion": "off", "device_tracker.camera_tracker": tracker("home", {}, 30) },
      }),
    );
    expect(v.devices).toEqual([
      { key: "device:cam", kind: "known", name: "Garden camera", online: true, since: NOW - 30 * 60_000, integration: "reolink", model: "Acme Cam 5", via: "Level 2 · wired", ip: "192.168.1.51" },
    ]);
  });

  it("offline when every entity of its own is unavailable, an alert after 10 minutes; the router's view does not override", () => {
    const at = (min: number) =>
      infraView(
        world({
          devices: [camera, routerRecord],
          entities: cameraEntities,
          states: {
            "camera.garden": { state: "unavailable", minAgo: min },
            "binary_sensor.garden_motion": { state: "unavailable", minAgo: min },
            "device_tracker.camera_tracker": tracker("home"),
          },
        }),
      );
    expect(at(5).devices[0]).toMatchObject({ online: false, since: NOW - 5 * 60_000 });
    expect(at(5).alerts).toEqual([]);
    expect(at(12).alerts).toEqual([{ tone: "bad", text: "Garden camera offline", since: NOW - 12 * 60_000, from: "devices" }]);
  });

  it("a connectivity sensor of its own decides; one thing known to two integrations is one row", () => {
    const tv = { id: "tv", name: "Living room TV", macs: ["aa:bb:cc:00:03:01"] };
    const tvRenderer = { id: "tv-dlna", name: "TV renderer", macs: ["aa:bb:cc:00:03:01"] };
    const v = infraView(
      world({
        devices: [tv, tvRenderer],
        entities: [
          { id: "media_player.living_room_tv", deviceId: "tv", platform: "samsungtv" },
          { id: "binary_sensor.living_room_tv_link", deviceId: "tv", platform: "samsungtv" },
          { id: "media_player.tv_renderer", deviceId: "tv-dlna", platform: "dlna_dmr" },
        ],
        states: {
          "media_player.living_room_tv": "on",
          "binary_sensor.living_room_tv_link": { state: "off", attributes: { device_class: "connectivity" }, minAgo: 20 },
          "media_player.tv_renderer": "unavailable",
        },
      }),
    );
    expect(v.devices).toEqual([{ key: "device:tv", kind: "known", name: "Living room TV", online: false, since: NOW - 20 * 60_000, integration: "samsungtv" }]);
    expect(v.ha.links).toEqual([]);
  });

  it("Ping hosts are devices too", () => {
    const v = infraView(
      world({
        devices: [{ id: "p", name: "Network switch" }],
        entities: [{ id: "binary_sensor.switch_ping", deviceId: "p", platform: "ping" }],
        states: { "binary_sensor.switch_ping": { state: "off", attributes: { device_class: "connectivity", ip_address: "192.168.1.254" }, minAgo: 15 } },
      }),
    );
    expect(v.devices).toEqual([{ key: "ping:binary_sensor.switch_ping", kind: "ping", name: "Network switch", online: false, since: NOW - 15 * 60_000, integration: "ping", ip: "192.168.1.254" }]);
    expect(v.alerts).toEqual([{ tone: "bad", text: "Network switch offline", since: NOW - 15 * 60_000, from: "devices" }]);
  });

  it("the router's other clients show while online, by the name they give, after the watched devices", () => {
    const v = infraView(
      world({
        devices: [camera, routerRecord],
        entities: [...cameraEntities, { id: "device_tracker.phone_tracker", platform: "tplink_deco" }, { id: "device_tracker.laptop", platform: "tplink_deco" }],
        states: {
          "camera.garden": "idle",
          "device_tracker.camera_tracker": tracker("home"),
          "device_tracker.phone_tracker": { state: "home", attributes: { source_type: "router", mac: "AA-BB-CC-00-09-01", host_name: "Phone", deco_device: "Level 1", connection_type: "band6" }, minAgo: 3 },
          "device_tracker.laptop": { state: "not_home", attributes: { source_type: "router", mac: "AA-BB-CC-00-09-02", host_name: "Laptop" } },
        },
      }),
    );
    expect(v.devices.map((d) => [d.kind, d.name, d.via])).toEqual([
      ["known", "Garden camera", "Level 2 · wired"],
      ["client", "Phone", "Level 1 · 6 GHz"],
    ]);
    expect(v.alerts).toEqual([]);
  });
});

describe("infra: servers and Home Assistant", () => {
  it("the tailnet's machines; a server off it is an alert, a laptop is not", () => {
    const v = infraView(
      world({
        devices: [
          { id: "s", name: "server", model: "linux" },
          { id: "l", name: "laptop", model: "macOS" },
        ],
        entities: [
          { id: "binary_sensor.server", deviceId: "s", platform: "tailscale" },
          { id: "binary_sensor.laptop", deviceId: "l", platform: "tailscale" },
        ],
        states: {
          "binary_sensor.server": { state: "off", attributes: { device_class: "connectivity" } },
          "binary_sensor.laptop": { state: "off", attributes: { device_class: "connectivity" } },
        },
      }),
    );
    expect(v.servers.map((s) => [s.name, s.online])).toEqual([
      ["laptop", false],
      ["server", false],
    ]);
    expect(v.alerts).toEqual([{ tone: "warn", text: "server off the tailnet", since: NOW - 3_600_000, from: "servers" }]);
  });

  it("updates waiting, devices it cannot reach (by integration, an alert after 30 minutes), links down", () => {
    const v = infraView(
      world({
        devices: [
          { id: "plug", name: "Kitchen plug" },
          { id: "sensor-dev", name: "Hall sensor" },
          { id: "bridge", name: "Zigbee bridge" },
        ],
        entities: [
          { id: "switch.kitchen", deviceId: "plug", platform: "matter" },
          { id: "update.kitchen_firmware", deviceId: "plug", platform: "matter" },
          { id: "sensor.hall_lux", deviceId: "sensor-dev", platform: "matter" },
          { id: "binary_sensor.zigbee_bridge", deviceId: "bridge", platform: "mqtt" },
        ],
        states: {
          "switch.kitchen": { state: "unavailable", minAgo: 45 },
          "update.kitchen_firmware": { state: "on", attributes: { title: "Kitchen plug firmware", installed_version: "1.0", latest_version: "1.1" } },
          "sensor.hall_lux": { state: "unavailable", minAgo: 10 },
          "binary_sensor.zigbee_bridge": { state: "off", attributes: { device_class: "connectivity", friendly_name: "Zigbee bridge" }, minAgo: 2 },
          "binary_sensor.example": { state: "unavailable", attributes: { device_class: "connectivity", friendly_name: "Remote UI" } },
        },
      }),
    );
    expect(v.ha.updates).toEqual([{ entity: "update.kitchen_firmware", name: "Kitchen plug firmware", installed: "1.0", latest: "1.1" }]);
    expect(v.ha.unreachable).toEqual([
      {
        integration: "matter",
        devices: [
          { name: "Hall sensor", since: NOW - 10 * 60_000 },
          { name: "Kitchen plug", since: NOW - 45 * 60_000 },
        ],
      },
    ]);
    expect(v.ha.links).toEqual([
      { entity: "binary_sensor.example", name: "Remote UI", online: null, since: NOW - 3_600_000 },
      { entity: "binary_sensor.zigbee_bridge", name: "Zigbee bridge", online: false, since: NOW - 2 * 60_000 },
    ]);
    expect(v.alerts.map((a) => [a.tone, a.text])).toEqual([
      ["bad", "Zigbee bridge disconnected"],
      ["warn", "matter: Kitchen plug unreachable"],
      ["warn", "1 update waiting: Kitchen plug firmware"],
    ]);
  });
});

describe("infra: the cards on the tab", () => {
  const card: InstanceCard = {
    key: "health-watch/nas",
    heuristic: "health-watch",
    id: "nas",
    mode: "active",
    card: {
      title: "NAS",
      fields: [
        { label: "Volume 1", value: "attention", tone: "bad", since: NOW - 60_000 },
        { label: "Drive 1 temperature", value: 51, unit: "°C", tone: "warn" },
        { label: "Drive 2", value: "normal", tone: "ok" },
      ],
    },
  };

  it("their bad and warn fields are alerts", () => {
    const v = infraView(world({ states: {}, cards: [card] }));
    expect(v.alerts).toEqual([
      { tone: "bad", text: "NAS: Volume 1 attention", since: NOW - 60_000, from: "cards" },
      { tone: "warn", text: "NAS: Drive 1 temperature 51 °C", from: "cards" },
    ]);
    expect(v.available).toBe(true);
  });

  it("tiles.json picks them by key, heuristic id or glob", () => {
    expect(onInfraTab(["health-watch/*"], "health-watch/nas")).toBe(true);
    expect(onInfraTab(["health-watch"], "health-watch/modem")).toBe(true);
    expect(onInfraTab(["lan-devices/network"], "lan-devices/network")).toBe(true);
    expect(onInfraTab(["health-watch/*"], "cat-tunnel/garage-tunnel")).toBe(false);
    expect(onInfraTab(["*-watch/n*"], "health-watch/nas")).toBe(true);
    expect(onInfraTab([], "health-watch/nas")).toBe(false);
  });

  it("tiles.json \"infra\" is checked", () => {
    expect(parseInfraConfig(undefined)).toEqual({ cards: [] });
    expect(parseInfraConfig({ cards: ["health-watch/*"] })).toEqual({ cards: ["health-watch/*"] });
    expect(() => parseInfraConfig({ tabs: [] })).toThrow('unknown key "tabs"');
    expect(() => parseInfraConfig({ cards: "health-watch" })).toThrow("must be a list");
    expect(() => parseInfraConfig([])).toThrow("must be an object");
  });
});

describe("infra: nothing to show", () => {
  it("is not available, so the tab stays hidden", () => {
    const v = infraView(world({ states: { "light.hall": "on" } }));
    expect(v).toMatchObject({ available: false, alerts: [], internet: null, mesh: [], devices: [], servers: [] });
  });
});
