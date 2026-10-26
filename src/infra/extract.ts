// extract.ts — the Infra view from Home Assistant's states and registries, as they are now.
// Pure: the service hands it the live cache, the registries and the cards; the same input
// gives the same view.
//
// Where each part comes from:
//  - internet: a device with a UPnP WAN status (by translation key, else the entity id's end);
//  - mesh: TP-Link Deco nodes (tplink_deco trackers of device_type "deco"), with their
//    sensors found by the end of their unique id;
//  - devices: every device Home Assistant integrates that has a MAC, online from its own
//    integration's entities, with how the router sees it; Ping hosts; and the router's
//    clients that are online and match no such device;
//  - servers: Tailscale machines;
//  - Home Assistant: pending updates, devices whose every entity is unavailable, and the
//    connectivity sensors no other part shows.
// An alert is what is wrong now: something down, a watched device offline for a while,
// updates waiting, and the bad or warn fields of the cards on the tab.

import { normalMac, type HaRegistry, type RegEntity } from "../ha-registry.js";
import type { InstanceCard } from "../kernel/card.js";
import type { InfraAlert, InfraDevice, InfraHa, InfraInternet, InfraMeshNode, InfraReading, InfraServer, InfraView } from "./view.js";

export interface InfraState {
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export interface InfraInput {
  now: number;
  states: ReadonlyMap<string, InfraState>;
  registry: Pick<HaRegistry, "ok" | "devices" | "entities">;
  /** The cards on the tab (already chosen by tiles.json "infra.cards"). */
  cards: InstanceCard[];
  /** A known device or Ping host offline this long is an alert. Default 10 minutes. */
  offlineAlertMs?: number;
  /** A device unreachable in Home Assistant this long is an alert. Default 30 minutes. */
  unreachableAlertMs?: number;
}

const OFFLINE_ALERT_MS = 10 * 60_000;
const UNREACHABLE_ALERT_MS = 30 * 60_000;

const domainOf = (id: string): string => id.slice(0, id.indexOf("."));
const ms = (iso: string | undefined): number | undefined => {
  const t = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (s: InfraState | undefined): number | undefined => {
  if (s === undefined || s.state.trim() === "") return undefined;
  const v = Number(s.state);
  return Number.isFinite(v) ? v : undefined;
};
const reading = (s: InfraState | undefined): InfraReading | undefined => {
  const v = num(s);
  return v === undefined ? undefined : { value: v, unit: str(s!.attributes["unit_of_measurement"]) ?? "" };
};
/** on → true, off → false, anything else (unavailable, unknown) → null. */
const onOff = (s: InfraState | undefined): boolean | null => (s?.state === "on" ? true : s?.state === "off" ? false : null);
const isConnectivity = (s: InfraState | undefined): boolean => s?.attributes["device_class"] === "connectivity";

/** How a router names the way a client connects. */
const BANDS: Record<string, string> = { band2_4: "2.4 GHz", band5: "5 GHz", band5_2: "5 GHz", band6: "6 GHz", wired: "wired" };

/** Instance cards on the Infra tab: a pattern is a key ("health-watch/nas"), a heuristic id ("health-watch") or a glob ("health-watch/*"). */
export function onInfraTab(patterns: readonly string[], key: string): boolean {
  const heuristic = key.slice(0, key.indexOf("/"));
  return patterns.some((p) => {
    if (p === key || p === heuristic) return true;
    if (!p.includes("*")) return false;
    const re = new RegExp(`^${p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(key);
  });
}

export function infraView(input: InfraInput): InfraView {
  const { now, states, registry } = input;
  const offlineAlertMs = input.offlineAlertMs ?? OFFLINE_ALERT_MS;
  const unreachableAlertMs = input.unreachableAlertMs ?? UNREACHABLE_ALERT_MS;
  const alerts: InfraAlert[] = [];
  /** Entities a part has shown, so the leftovers list shows each once. */
  const used = new Set<string>();

  const enabled = [...registry.entities.values()].filter((e) => !e.disabled);
  const byDevice = new Map<string, RegEntity[]>();
  for (const e of enabled) if (e.deviceId !== undefined) byDevice.set(e.deviceId, [...(byDevice.get(e.deviceId) ?? []), e]);
  const deviceName = (deviceId: string | undefined, fallback: string): string => (deviceId === undefined ? undefined : registry.devices.get(deviceId)?.name) ?? fallback;
  const friendly = (id: string): string => str(states.get(id)?.attributes["friendly_name"]) ?? id;
  const nameOf = (e: RegEntity): string => deviceName(e.deviceId, friendly(e.id));
  const since = (id: string): number | undefined => ms(states.get(id)?.last_changed);

  // ---- routers: the platforms whose trackers are a router's clients ----
  const trackers = [...states.entries()].filter(([id, s]) => domainOf(id) === "device_tracker" && s.attributes["source_type"] === "router");
  const routerPlatforms = new Set(trackers.map(([id]) => registry.entities.get(id)?.platform).filter((p): p is string => p !== undefined));
  /** A MAC's tracker, the one that sees it home when there are several. */
  const trackerByMac = new Map<string, [string, InfraState]>();
  for (const t of trackers) {
    const mac = str(t[1].attributes["mac"]);
    if (mac === undefined) continue;
    const m = normalMac(mac);
    const had = trackerByMac.get(m);
    if (had === undefined || (had[1].state !== "home" && t[1].state === "home")) trackerByMac.set(m, t);
  }
  const viaOf = (s: InfraState): string | undefined => {
    const node = str(s.attributes["deco_device"]);
    const link = str(s.attributes["connection_type"]);
    const band = link === undefined ? undefined : (BANDS[link] ?? link);
    return [node, band].filter((x): x is string => x !== undefined).join(" · ") || undefined;
  };

  // ---- internet: a UPnP gateway ----
  const keyed = (e: RegEntity, key: string): boolean => e.translationKey === key || (e.translationKey === undefined && e.id.endsWith(`_${key}`));
  let internet: InfraInternet | null = null;
  const wan = enabled.find((e) => e.platform === "upnp" && domainOf(e.id) === "binary_sensor" && keyed(e, "wan_status"));
  if (wan !== undefined) {
    const ents = wan.deviceId === undefined ? [wan] : (byDevice.get(wan.deviceId) ?? [wan]);
    const pick = (key: string, domain = "sensor"): RegEntity | undefined => ents.find((e) => domainOf(e.id) === domain && keyed(e, key));
    const s = states.get(wan.id);
    const ip = pick("external_ip");
    const down = pick("download_speed");
    const up = pick("upload_speed");
    const uptime = pick("uptime");
    for (const e of [wan, ip, down, up, uptime]) if (e !== undefined) used.add(e.id);
    internet = { name: nameOf(wan), online: onOff(s) };
    const at = since(wan.id);
    if (at !== undefined) internet.since = at;
    const ipText = ip === undefined ? undefined : states.get(ip.id)?.state;
    if (ipText !== undefined && ipText !== "unavailable" && ipText !== "unknown") internet.externalIp = ipText;
    const d = reading(down === undefined ? undefined : states.get(down.id));
    if (d !== undefined) internet.down = d;
    const u = reading(up === undefined ? undefined : states.get(up.id));
    if (u !== undefined) internet.up = u;
    const upSince = uptime === undefined ? undefined : startedAt(states.get(uptime.id), now);
    if (upSince !== undefined) internet.upSince = upSince;
    if (internet.online === false) alerts.push({ tone: "bad", text: "Internet down", ...(at !== undefined ? { since: at } : {}), from: "internet" });
  }

  // ---- mesh: TP-Link Deco nodes ----
  const mesh: InfraMeshNode[] = [];
  for (const [id, s] of trackers) {
    const reg = registry.entities.get(id);
    if (reg?.platform !== "tplink_deco" || s.attributes["device_type"] !== "deco") continue;
    used.add(id);
    const ents = reg.deviceId === undefined ? [] : (byDevice.get(reg.deviceId) ?? []);
    const bySuffix = (suffix: string): InfraState | undefined => {
      const e = ents.find((x) => x.uniqueId?.endsWith(suffix) === true);
      if (e === undefined) return undefined;
      used.add(e.id);
      return states.get(e.id);
    };
    const name = nameOf(reg);
    const node: InfraMeshNode = { name, online: s.state === "home", main: s.attributes["master"] === true };
    const at = ms(s.last_changed);
    if (at !== undefined) node.since = at;
    const internetSensor = onOff(bySuffix("_internet_online"));
    const internetAttr = s.attributes["internet_online"];
    const internetOk = internetSensor ?? (typeof internetAttr === "boolean" ? internetAttr : null);
    if (internetOk !== null) node.internet = internetOk;
    const cpu = reading(bySuffix("_cpu_usage"));
    if (cpu !== undefined) node.cpu = cpu;
    const memory = reading(bySuffix("_mem_usage"));
    if (memory !== undefined) node.memory = memory;
    const clients = num(bySuffix("_client_count"));
    if (clients !== undefined) node.clients = clients;
    const backhaulType = bySuffix("_connection_type")?.state;
    if (backhaulType !== undefined && backhaulType !== "unavailable" && backhaulType !== "unknown") {
      const speed = reading(bySuffix("_backhaul_speed"));
      node.backhaul = { type: backhaulType, ...(speed !== undefined ? { speed } : {}) };
    }
    bySuffix("_online");
    const firmware = str(s.attributes["sw_version"]);
    if (firmware !== undefined) node.firmware = firmware;
    mesh.push(node);
    if (!node.online) alerts.push({ tone: "bad", text: `${name} offline`, ...(at !== undefined ? { since: at } : {}), from: "mesh" });
    else if (node.internet === false) alerts.push({ tone: "bad", text: `${name}: no internet`, from: "mesh" });
    if (node.cpu !== undefined && node.cpu.value >= 90) alerts.push({ tone: "warn", text: `${name}: CPU ${node.cpu.value} %`, from: "mesh" });
    if (node.memory !== undefined && node.memory.value >= 90) alerts.push({ tone: "warn", text: `${name}: memory ${node.memory.value} %`, from: "mesh" });
  }
  mesh.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));

  // ---- devices: known (a MAC), Ping hosts, the router's other clients ----
  const devices: InfraDevice[] = [];
  const knownMacs = new Set<string>();
  const knownDevices = new Set<string>();
  /** Devices that share a MAC (one thing, several integrations) are one row. */
  const groups = new Map<string, string[]>();
  // The gateway is the internet part already.
  const gateway = wan?.deviceId;
  for (const d of registry.devices.values()) {
    if (d.service || d.macs.length === 0 || d.id === gateway) continue;
    const own = (byDevice.get(d.id) ?? []).filter((e) => e.platform === undefined || !routerPlatforms.has(e.platform));
    if (own.length === 0) continue; // the router's own record of a client or a node
    const key = d.macs.find((m) => groups.has(m)) ?? d.macs[0]!;
    groups.set(key, [...(groups.get(key) ?? []), d.id]);
    for (const m of d.macs) if (m !== key && !groups.has(m)) groups.set(m, groups.get(key)!);
  }
  const seen = new Set<string[]>();
  for (const ids of groups.values()) {
    if (seen.has(ids)) continue;
    seen.add(ids);
    const devs = ids.map((id) => registry.devices.get(id)!);
    const own = devs.flatMap((d) => (byDevice.get(d.id) ?? []).filter((e) => e.platform === undefined || !routerPlatforms.has(e.platform)));
    // The device with the most entities names the row: the integration that knows it best.
    const lead = [...devs].sort((a, b) => (byDevice.get(b.id)?.length ?? 0) - (byDevice.get(a.id)?.length ?? 0))[0]!;
    const macs = devs.flatMap((d) => d.macs);
    for (const m of macs) knownMacs.add(m);
    for (const d of devs) knownDevices.add(d.id);
    const tracker = macs.map((m) => trackerByMac.get(m)).find((t) => t !== undefined);
    if (tracker !== undefined) used.add(tracker[0]);
    const status = deviceStatus(own, states);
    for (const e of own) if (isConnectivity(states.get(e.id))) used.add(e.id);
    const home = tracker !== undefined && tracker[1].state === "home";
    let online = status.online;
    let at = status.since;
    // Nothing of its own says: the router's tracker does.
    if (online === null && tracker !== undefined) {
      online = home;
      at = ms(tracker[1].last_changed);
    }
    if (online === true && home) at = ms(tracker![1].last_changed) ?? at;
    const platforms = own.map((e) => e.platform).filter((p): p is string => p !== undefined);
    const integration = mostCommon(platforms);
    // "AirGradient ONE", not "AirGradient AirGradient ONE"; nothing when it only repeats the name.
    const made = lead.model !== undefined && lead.manufacturer !== undefined && !lead.model.startsWith(lead.manufacturer) ? `${lead.manufacturer} ${lead.model}` : (lead.model ?? lead.manufacturer);
    const model = made !== undefined && made !== lead.name ? made : undefined;
    const row: InfraDevice = { key: `device:${lead.id}`, kind: "known", name: lead.name, online };
    if (at !== undefined) row.since = at;
    if (integration !== undefined) row.integration = integration;
    if (model !== undefined) row.model = model;
    if (home) {
      const via = viaOf(tracker![1]);
      if (via !== undefined) row.via = via;
      const ip = str(tracker![1].attributes["ip"]);
      if (ip !== undefined) row.ip = ip;
    }
    devices.push(row);
  }
  for (const e of enabled) {
    if (e.platform !== "ping" || domainOf(e.id) !== "binary_sensor") continue;
    used.add(e.id);
    if (e.deviceId !== undefined) knownDevices.add(e.deviceId);
    const s = states.get(e.id);
    const row: InfraDevice = { key: `ping:${e.id}`, kind: "ping", name: nameOf(e), online: onOff(s), integration: "ping" };
    const at = since(e.id);
    if (at !== undefined) row.since = at;
    const ip = str(s?.attributes["ip_address"]) ?? str(s?.attributes["host"]);
    if (ip !== undefined) row.ip = ip;
    devices.push(row);
  }
  for (const row of devices) {
    if (row.online !== false) continue;
    if (row.since !== undefined && now - row.since < offlineAlertMs) continue;
    alerts.push({ tone: "bad", text: `${row.name} offline`, ...(row.since !== undefined ? { since: row.since } : {}), from: "devices" });
  }
  for (const [id, s] of trackers) {
    if (used.has(id) || s.state !== "home" || s.attributes["device_type"] === "deco") continue;
    const mac = str(s.attributes["mac"]);
    if (mac !== undefined && knownMacs.has(normalMac(mac))) continue;
    used.add(id);
    const row: InfraDevice = {
      key: `client:${id}`,
      kind: "client",
      name: str(s.attributes["host_name"]) ?? str(s.attributes["ui_device_name"]) ?? friendly(id),
      online: true,
    };
    const integration = registry.entities.get(id)?.platform;
    if (integration !== undefined) row.integration = integration;
    const at = ms(s.last_changed);
    if (at !== undefined) row.since = at;
    const via = viaOf(s);
    if (via !== undefined) row.via = via;
    const ip = str(s.attributes["ip"]);
    if (ip !== undefined) row.ip = ip;
    devices.push(row);
  }
  const rank = (d: InfraDevice): number => (d.online === false ? 0 : d.kind === "client" ? 2 : 1);
  devices.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  // ---- servers: the tailnet ----
  const servers: InfraServer[] = [];
  for (const e of enabled) {
    if (e.platform !== "tailscale" || domainOf(e.id) !== "binary_sensor" || !isConnectivity(states.get(e.id))) continue;
    used.add(e.id);
    const name = nameOf(e);
    const row: InfraServer = { name, online: onOff(states.get(e.id)) };
    const at = since(e.id);
    if (at !== undefined) row.since = at;
    servers.push(row);
    // A laptop or a phone off the tailnet is normal; a server is not.
    const model = e.deviceId === undefined ? undefined : registry.devices.get(e.deviceId)?.model;
    if (row.online === false && model === "linux") alerts.push({ tone: "warn", text: `${name} off the tailnet`, ...(at !== undefined ? { since: at } : {}), from: "servers" });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));

  // ---- Home Assistant ----
  const ha: InfraHa = { updates: [], unreachable: [], links: [] };
  for (const [id, s] of states) {
    if (domainOf(id) !== "update" || s.state !== "on") continue;
    const installed = str(s.attributes["installed_version"]);
    const latest = str(s.attributes["latest_version"]);
    ha.updates.push({ entity: id, name: str(s.attributes["title"]) ?? friendly(id), ...(installed !== undefined ? { installed } : {}), ...(latest !== undefined ? { latest } : {}) });
  }
  ha.updates.sort((a, b) => a.name.localeCompare(b.name));
  if (ha.updates.length > 0) alerts.push({ tone: "warn", text: ha.updates.length === 1 ? `1 update waiting: ${ha.updates[0]!.name}` : `${ha.updates.length} updates waiting`, from: "ha" });

  const unreachable = new Map<string, Array<{ name: string; since?: number }>>();
  for (const d of registry.devices.values()) {
    if (d.service || knownDevices.has(d.id) || d.id === gateway) continue;
    const ents = (byDevice.get(d.id) ?? []).filter((e) => states.has(e.id) && domainOf(e.id) !== "update");
    if (ents.length === 0 || ents.some((e) => e.platform !== undefined && routerPlatforms.has(e.platform))) continue;
    if (!ents.every((e) => states.get(e.id)!.state === "unavailable")) continue;
    const integration = mostCommon(ents.map((e) => e.platform).filter((p): p is string => p !== undefined)) ?? "other";
    const at = Math.max(...ents.map((e) => since(e.id) ?? 0));
    unreachable.set(integration, [...(unreachable.get(integration) ?? []), { name: d.name, ...(at > 0 ? { since: at } : {}) }]);
  }
  for (const [integration, list] of [...unreachable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    ha.unreachable.push({ integration, devices: list });
    const long = list.filter((d) => d.since === undefined || now - d.since >= unreachableAlertMs);
    if (long.length > 0) {
      const first = Math.min(...long.map((d) => d.since ?? now));
      alerts.push({ tone: "warn", text: long.length === 1 ? `${integration}: ${long[0]!.name} unreachable` : `${integration}: ${long.length} devices unreachable`, ...(first < now ? { since: first } : {}), from: "ha" });
    }
  }

  for (const [id, s] of states) {
    if (domainOf(id) !== "binary_sensor" || used.has(id) || !isConnectivity(s)) continue;
    const online = onOff(s);
    const at = ms(s.last_changed);
    ha.links.push({ entity: id, name: friendly(id), online, ...(at !== undefined ? { since: at } : {}) });
    if (online === false) alerts.push({ tone: "bad", text: `${friendly(id)} disconnected`, ...(at !== undefined ? { since: at } : {}), from: "ha" });
  }
  ha.links.sort((a, b) => a.name.localeCompare(b.name));

  // ---- the cards on the tab ----
  for (const c of input.cards) {
    for (const f of c.card?.fields ?? []) {
      if (f.tone !== "bad" && f.tone !== "warn") continue;
      const value = f.value === null ? "" : ` ${typeof f.value === "boolean" ? (f.value ? "yes" : "no") : String(f.value)}${f.unit !== undefined ? ` ${f.unit}` : ""}`;
      alerts.push({ tone: f.tone, text: `${c.card!.title}: ${f.label}${value}`, ...(f.since !== undefined ? { since: f.since } : {}), from: "cards" });
    }
  }

  alerts.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1) || (a.since ?? now) - (b.since ?? now));
  const available = internet !== null || mesh.length > 0 || devices.length > 0 || servers.length > 0 || input.cards.length > 0;
  return { at: now, available, registry: registry.ok, alerts, internet, mesh, devices, servers, ha, cards: input.cards };
}

/** Online from a device's own entities: a connectivity sensor if it has one, else unavailable everywhere = offline. */
function deviceStatus(own: RegEntity[], states: ReadonlyMap<string, InfraState>): { online: boolean | null; since?: number } {
  const link = own.map((e) => states.get(e.id)).find((s) => isConnectivity(s) && (s!.state === "on" || s!.state === "off"));
  if (link !== undefined) {
    const at = ms(link.last_changed);
    return { online: link.state === "on", ...(at !== undefined ? { since: at } : {}) };
  }
  const present = own.filter((e) => domainOf(e.id) !== "update").map((e) => states.get(e.id)).filter((s): s is InfraState => s !== undefined);
  if (present.length === 0) return { online: null };
  if (present.every((s) => s.state === "unavailable")) {
    const at = Math.max(...present.map((s) => ms(s.last_changed) ?? 0));
    return { online: false, ...(at > 0 ? { since: at } : {}) };
  }
  return { online: true };
}

/** When a gateway started, from its uptime: seconds (or another unit of time) up, or a timestamp. */
function startedAt(s: InfraState | undefined, now: number): number | undefined {
  if (s === undefined) return undefined;
  const v = num(s);
  if (v === undefined) return ms(s.state);
  const unit = str(s.attributes["unit_of_measurement"]) ?? "s";
  const factor: Record<string, number> = { s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  const f = factor[unit];
  return f === undefined ? undefined : now - v * f;
}

function mostCommon(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}
