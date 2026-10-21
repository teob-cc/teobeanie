// access.ts — who may use the MCP tools. In the add-on the only door is Home
// Assistant ingress: the request is authenticated by HA (an admin's session) and
// arrives from the Supervisor's ingress gateway, and HA tells us the user and the
// client's address. That address must be in one of the configured networks (the
// add-on's `mcp_networks` option, or MCP_NETWORKS), by default the private LAN ranges
// and Tailscale's, so the tools are reachable from the house's own network and the
// tailnet, never from a public address. Standalone, only loopback may connect.

import { BlockList, isIP } from "node:net";

/** The private and link-local ranges of a home LAN (RFC 1918, IPv6 ULA and link-local). */
export const LAN_NETWORKS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10"];
/** Tailscale's IPv4 CGNAT range and its IPv6 ULA prefix. */
export const TAILSCALE_NETWORKS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];
/** The default of `mcp_networks`: the LAN and the tailnet. */
export const DEFAULT_MCP_NETWORKS: readonly string[] = [...LAN_NETWORKS, ...TAILSCALE_NETWORKS];

/**
 * The networks MCP clients may come from: MCP_NETWORKS (comma-separated CIDRs) when
 * set, else the add-on option, else the default. An empty list closes MCP.
 */
export function mcpNetworks(env: string | undefined, option: readonly string[] | undefined): string[] {
  if (env !== undefined && env.trim() !== "") return env.split(",").map((s) => s.trim()).filter(Boolean);
  if (option !== undefined) return option.map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_MCP_NETWORKS];
}

const INGRESS_PEER = "172.30.32.2";
/** The Supervisor's internal network: hops inside it are not the client. */
const INTERNAL = (() => {
  const b = new BlockList();
  b.addSubnet("172.30.32.0", 23, "ipv4");
  return b;
})();

export interface Caller {
  via: "ingress" | "local";
  /** HA user, from the ingress session. */
  user?: string;
  userId?: string;
  /** The client's address as HA saw it. */
  address?: string;
}

export type Access = { ok: true; caller: Caller } | { ok: false; reason: string };

const plain = (ip: string) => ip.trim().replace(/^::ffff:/, "");
const family = (ip: string): "ipv4" | "ipv6" | undefined => (isIP(ip) === 4 ? "ipv4" : isIP(ip) === 6 ? "ipv6" : undefined);

export function networks(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits] = cidr.split("/");
    const f = net === undefined ? undefined : family(net);
    if (net === undefined || f === undefined || bits === undefined || !/^\d+$/.test(bits)) throw new Error(`not a network: ${cidr}`);
    list.addSubnet(net, Number(bits), f);
  }
  return list;
}

/**
 * The client of an ingress request: the last X-Forwarded-For hop outside the
 * Supervisor's network. Hops a client adds itself come before the ones HA appends,
 * so they cannot stand in for the real address.
 */
export function clientAddress(forwardedFor: string | undefined): string | undefined {
  const hops = (forwardedFor ?? "").split(",").map(plain).filter((h) => family(h) !== undefined);
  for (let i = hops.length - 1; i >= 0; i--) {
    const h = hops[i]!;
    if (!(family(h) === "ipv4" && INTERNAL.check(h, "ipv4"))) return h;
  }
  return undefined;
}

export function checkAccess(
  mode: "addon" | "standalone",
  peer: string | undefined,
  header: (name: string) => string | undefined,
  allowed: BlockList,
): Access {
  const ip = plain(peer ?? "");
  if (mode === "standalone") {
    return ip === "127.0.0.1" || ip === "::1" ? { ok: true, caller: { via: "local", address: ip } } : { ok: false, reason: `standalone: loopback only, not ${ip}` };
  }
  if (ip !== INGRESS_PEER) return { ok: false, reason: `only through Home Assistant ingress, not from ${ip || "unknown"}` };
  const address = clientAddress(header("x-forwarded-for"));
  const f = address === undefined ? undefined : family(address);
  if (address === undefined || f === undefined || !allowed.check(address, f)) {
    return { ok: false, reason: `client ${address ?? "unknown"} is not in the allowed networks` };
  }
  const user = header("x-remote-user-display-name") ?? header("x-remote-user-name");
  const userId = header("x-remote-user-id");
  return { ok: true, caller: { via: "ingress", address, ...(user ? { user } : {}), ...(userId ? { userId } : {}) } };
}
