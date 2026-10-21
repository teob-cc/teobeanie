#!/usr/bin/env node
// teobeanie-mcp-bridge.mjs — use the add-on's MCP tools from a local MCP client (Claude
// Code, Claude Desktop, ...) over stdio. The tools are served only through Home
// Assistant ingress, so this bridge authenticates to Home Assistant with a long-lived
// token (an admin's), opens an ingress session and forwards each JSON-RPC message to
// the add-on's /mcp. Point HA_URL at Home Assistant's address on your LAN or your
// tailnet: the add-on accepts MCP only from the networks in its `mcp_networks` option
// (the private LAN ranges and Tailscale by default).
//
//   HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=~/.ha-token node scripts/teobeanie-mcp-bridge.mjs
//
//   claude mcp add teobeanie -e HA_URL=... -e HA_TOKEN_FILE=... -- node /path/to/teobeanie-mcp-bridge.mjs
//
// Environment: HA_URL (required), HA_TOKEN or HA_TOKEN_FILE (required), ADDON (optional:
// the add-on's Supervisor slug; by default the bridge asks the Supervisor for the
// installed Teobeanie add-on). Needs Node 22 or later.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const fail = (msg) => {
  process.stderr.write(`teobeanie-mcp-bridge: ${msg}\n`);
  process.exit(1);
};
const haUrl = (process.env.HA_URL ?? "").replace(/\/$/, "");
if (!haUrl) fail("set HA_URL to Home Assistant's address, e.g. http://homeassistant.local:8123");
const tokenFile = process.env.HA_TOKEN_FILE?.replace(/^~(?=\/)/, homedir());
const token = (process.env.HA_TOKEN ?? (tokenFile ? readFileSync(tokenFile, "utf8") : "")).trim();
if (!token) fail("set HA_TOKEN or HA_TOKEN_FILE to a long-lived Home Assistant token");
let addon = process.env.ADDON || undefined;
const log = (msg) => process.stderr.write(`teobeanie-mcp-bridge: ${msg}\n`);

// ---- Home Assistant websocket: supervisor API calls for the ingress session ----

let ws;
let nextId = 0;
const pending = new Map();
let ready;

function connect() {
  ready = new Promise((resolve, reject) => {
    ws = new WebSocket(`${haUrl.replace(/^http/, "ws")}/api/websocket`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (m.type === "auth_ok") resolve();
      else if (m.type === "auth_invalid") reject(new Error(`Home Assistant rejected the token: ${m.message}`));
      else if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.success ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? "supervisor call failed"));
      }
    };
    ws.onerror = () => reject(new Error(`cannot reach ${haUrl}`));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error("websocket closed"));
      pending.clear();
      ready = undefined;
    };
  });
  return ready;
}

async function supervisor(method, endpoint, data) {
  await (ready ?? connect());
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type: "supervisor/api", method, endpoint, ...(data ? { data } : {}) }));
  });
}

// The installed Teobeanie add-on: `teobeanie` or `<repository>_teobeanie` (a store or a
// local install), or `local_teob_home` (a local install under an earlier slug).
// More than one: the started one; still ambiguous, ask for ADDON.
const isTeobeanie = (slug) => slug === "teobeanie" || slug.endsWith("_teobeanie") || slug === "local_teob_home";
async function findAddon() {
  const { addons = [] } = await supervisor("get", "/addons");
  const found = addons.filter((a) => typeof a.slug === "string" && isTeobeanie(a.slug) && a.installed !== false);
  const started = found.filter((a) => a.state === "started");
  const pick = found.length === 1 ? found : started.length === 1 ? started : [];
  if (pick.length === 1) {
    log(`using add-on ${pick[0].slug}`);
    return pick[0].slug;
  }
  if (found.length === 0) throw new Error("no Teobeanie add-on is installed (set ADDON to its slug)");
  throw new Error(`several Teobeanie add-ons (${found.map((a) => a.slug).join(", ")}): set ADDON to one`);
}

let session;
let base;
async function openSession() {
  addon ??= await findAddon();
  base ??= `${haUrl}${(await supervisor("get", `/addons/${addon}/info`)).ingress_url}`;
  session = (await supervisor("post", "/ingress/session")).session;
}
// Ingress sessions expire unless validated; keep ours alive.
setInterval(() => {
  if (session) supervisor("post", "/ingress/validate_session", { session }).catch(() => (session = undefined));
}, 5 * 60_000).unref();

// ---- stdio ↔ POST /mcp ----

const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";

async function forward(message, retry = true) {
  if (!session) await openSession();
  const headers = { "content-type": "application/json", accept: "application/json", cookie: `ingress_session=${session}` };
  // Modern-era requests carry their routing in headers too; the server checks they agree.
  const version = message?.params?._meta?.[PROTOCOL_META];
  if (typeof version === "string" && message.id !== undefined) {
    headers["mcp-protocol-version"] = version;
    headers["mcp-method"] = message.method;
    if (message.method === "tools/call") headers["mcp-name"] = message.params?.name;
  }
  const res = await fetch(`${base}mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  if ((res.status === 401 || res.status === 404) && retry) {
    session = undefined; // expired session: open a new one once
    return forward(message, false);
  }
  if (res.status === 202) return undefined;
  const text = await res.text();
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  // A refusal before the body was read (403) carries no id: answer the request it refused.
  if (reply && reply.id === null && message.id !== undefined) reply.id = message.id;
  return reply;
}

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  forward(message).then(
    (reply) => reply !== undefined && message.id !== undefined && out(reply),
    (err) => {
      log(String(err.message ?? err));
      if (message.id !== undefined) out({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `bridge: ${err.message ?? err}` } });
    },
  );
}).on("close", () => {
  ws?.close();
  process.exit(0);
});
