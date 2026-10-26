// view.ts — what GET api/infra returns: the house's infrastructure as Home Assistant sees
// it now (the internet link, the Wi-Fi mesh, the devices on the network, the tailnet,
// Home Assistant's own health) and the alerts that follow from it. Everything in it is
// read live; nothing is typed in. Pure types: the panel imports them.

import type { InstanceCard } from "../kernel/card.js";

export type InfraTone = "bad" | "warn";

/** Something that needs a look now. */
export interface InfraAlert {
  tone: InfraTone;
  /** "Internet down", "Camera offline". */
  text: string;
  /** Since when (ms epoch), when known. */
  since?: number;
  /** Which part of the tab it comes from. */
  from: "internet" | "mesh" | "devices" | "servers" | "ha" | "cards";
}

/** A reading with its unit, as Home Assistant reports it. */
export interface InfraReading {
  value: number;
  unit: string;
}

/** The internet link, from a router or modem that speaks UPnP. */
export interface InfraInternet {
  /** The gateway's name. */
  name: string;
  /** null: it reports neither up nor down. */
  online: boolean | null;
  since?: number;
  externalIp?: string;
  down?: InfraReading;
  up?: InfraReading;
  /** When the gateway last started (ms epoch), from its uptime. */
  upSince?: number;
}

/** A node of a Wi-Fi mesh (TP-Link Deco). */
export interface InfraMeshNode {
  name: string;
  online: boolean;
  since?: number;
  /** The node the others hang off. */
  main: boolean;
  /** It reaches the internet (the node's own report). */
  internet?: boolean;
  cpu?: InfraReading;
  memory?: InfraReading;
  clients?: number;
  /** How it reaches the main node: "wired", "wireless", with its speed. */
  backhaul?: { type: string; speed?: InfraReading };
  firmware?: string;
}

/**
 * A device on the network.
 *  - known: a device Home Assistant integrates that has a network address; online
 *    from its own integration's entities;
 *  - ping: a host the Ping integration watches;
 *  - client: a router's client that matches no device Home Assistant knows, while online.
 */
export interface InfraDevice {
  key: string;
  kind: "known" | "ping" | "client";
  name: string;
  /** null: nothing says (its entities have not reported). */
  online: boolean | null;
  /** Since when it is online or offline (ms epoch). */
  since?: number;
  /** The integration that knows it ("reolink", "ping", the router's). */
  integration?: string;
  model?: string;
  /** How the router sees it: "Level 1 · 5 GHz", "Level 0 · wired". */
  via?: string;
  ip?: string;
}

/** A machine on the tailnet (Tailscale). */
export interface InfraServer {
  name: string;
  online: boolean | null;
  since?: number;
}

export interface InfraUpdate {
  entity: string;
  name: string;
  installed?: string;
  latest?: string;
}

/** Home Assistant's own health: what waits to be updated, what it cannot reach. */
export interface InfraHa {
  updates: InfraUpdate[];
  /** Devices whose every entity is unavailable, by integration. */
  unreachable: Array<{ integration: string; devices: Array<{ name: string; since?: number }> }>;
  /** Connectivity sensors no other part shows (a Zigbee bridge, a meter's link). */
  links: Array<{ entity: string; name: string; online: boolean | null; since?: number }>;
}

export interface InfraView {
  at: number;
  /** There is anything to show (the tab is hidden otherwise). */
  available: boolean;
  /** Home Assistant's registries were read (without them: no devices, mesh or names). */
  registry: boolean;
  alerts: InfraAlert[];
  internet: InfraInternet | null;
  mesh: InfraMeshNode[];
  devices: InfraDevice[];
  servers: InfraServer[];
  ha: InfraHa;
  /** The instances' cards that belong on this tab (tiles.json "infra.cards"). */
  cards: InstanceCard[];
}
