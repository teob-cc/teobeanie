#!/usr/bin/env node
// Node-RED (the Home Assistant add-on) through HA ingress: dump the flows, list what
// still acts on the house, trace a node's wires, disable or enable nodes.
//
//   HA_URL=http://homeassistant.local:8123 HA_TOKEN=... node nodered.mjs <command>
//
//   dump [file]               write the flows (default flows.json)
//   effects                   every node that acts (service calls, notifications, MQTT
//                             out, HTTP), LIVE when an enabled trigger reaches it
//   trace <id>                where a node's input comes from, and everything it feeds
//   disable <id>... | enable <id>...
//                             back the flows up, set or clear `d` on those nodes, deploy
//                             only them, read them back
//
// NODERED_SLUG overrides the add-on slug (default a0d7b954_nodered). The token needs an
// admin user: ingress sessions come from the Supervisor API.

import fs from "node:fs";

const HA_URL = (process.env.HA_URL ?? "http://homeassistant.local:8123").replace(/\/$/, "");
const TOKEN = process.env.HA_TOKEN?.trim();
const SLUG = process.env.NODERED_SLUG ?? "a0d7b954_nodered";
if (!TOKEN) {
  console.error("HA_TOKEN is not set");
  process.exit(2);
}

/** Node types that start a flow on their own. */
const SOURCE = /server-state-changed|trigger-state|poll-state|events-state|server-events|events-all|inject|ha-time|time-inject|cronplus|telegram command|telegram receiver|mqtt in|http in|zigbee2mqtt-in|tcp in|udp in|websocket in|link in|catch|status|complete/;
/** Node types that act on the outside world. */
const EFFECT = /api-call-service|call-service|^action$|telegram sender|telegram reply|mqtt out|http request|ha-api|ha-entity|^entity$|exec|e-mail/;

async function ingress() {
  const ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
      else if (m.type === "auth_ok") resolve();
      else if (m.type === "auth_invalid") reject(new Error("HA auth failed"));
      else if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
    };
    ws.onerror = () => reject(new Error(`cannot reach ${HA_URL}`));
  });
  const call = (msg) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, ...msg })); });
  await ready;
  const sess = await call({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" });
  const info = await call({ type: "supervisor/api", endpoint: `/addons/${SLUG}/info`, method: "get" });
  ws.close();
  if (!sess.success || !info.success) throw new Error(`supervisor: ${JSON.stringify(sess.error ?? info.error)}`);
  return { base: HA_URL + info.result.ingress_url, headers: { Cookie: `ingress_session=${sess.result.session}`, "Node-RED-API-Version": "v2" } };
}

async function getFlows(nr) {
  const r = await fetch(nr.base + "flows", { headers: nr.headers });
  if (!r.ok) throw new Error(`GET flows ${r.status}`);
  return r.json(); // { rev, flows }
}

function index(flows) {
  const by = new Map(flows.map((n) => [n.id, n]));
  const up = new Map();
  for (const n of flows) for (const w of (n.wires ?? []).flat()) up.set(w, [...(up.get(w) ?? []), n.id]);
  // link out → link in: a link-in node's inputs are the link-out nodes naming it.
  for (const n of flows) if (n.type === "link out") for (const l of n.links ?? []) up.set(l, [...(up.get(l) ?? []), n.id]);
  const tabs = new Map(flows.filter((n) => n.type === "tab" || n.type === "subflow").map((t) => [t.id, t]));
  const off = (n) => n.d === true || tabs.get(n.z)?.disabled === true;
  const label = (n) => `${tabs.get(n.z)?.label ?? tabs.get(n.z)?.name ?? "-"} · ${n.id} ${n.type}${n.name ? ` "${n.name}"` : ""}${off(n) ? " (disabled)" : ""}`;
  /** Enabled source nodes that reach this node through enabled nodes. */
  const sources = (id, seen = new Set()) => {
    const n = by.get(id);
    if (n === undefined || off(n) || seen.has(id)) return [];
    seen.add(id);
    const ins = up.get(id) ?? [];
    const own = SOURCE.test(n.type) ? [id] : [];
    return [...own, ...ins.flatMap((u) => sources(u, seen))];
  };
  return { by, up, label, off, sources };
}

const what = (n) => {
  const svc = n.action ?? (n.domain || n.service ? `${n.domain ?? ""}.${n.service ?? ""}` : "");
  const devices = [n.deviceId, n.target?.deviceId, n.target?.device_id].flat().filter(Boolean);
  const target = n.entityId?.length ? n.entityId : n.target?.entityId ?? n.target?.entity_id ?? n.entity_id ?? (devices.length > 0 ? devices.map((d) => `device:${d}`) : n.topic ?? n.url ?? "");
  return [svc, Array.isArray(target) ? target.join(",") : target].filter(Boolean).join(" ");
};

const [cmd, ...args] = process.argv.slice(2);
const nr = await ingress();
const cur = await getFlows(nr);
const flows = cur.flows;
const ix = index(flows);

if (cmd === "dump") {
  const file = args[0] ?? "flows.json";
  fs.writeFileSync(file, JSON.stringify(cur, null, 1));
  console.log(`${flows.length} nodes → ${file}`);
} else if (cmd === "effects") {
  for (const n of flows.filter((f) => EFFECT.test(f.type))) {
    const src = ix.off(n) ? [] : ix.sources(n.id);
    console.log(`${ix.off(n) ? "off " : src.length > 0 ? "LIVE" : "dead"}  ${ix.label(n)}  ${what(n)}`);
    for (const s of src) console.log(`        ← ${ix.label(ix.by.get(s))} ${what(ix.by.get(s))}`);
  }
} else if (cmd === "trace") {
  const root = ix.by.get(args[0]);
  if (root === undefined) throw new Error(`no node ${args[0]}`);
  console.log(ix.label(root));
  console.log("fed by:");
  for (const s of ix.sources(root.id)) console.log(`  ← ${ix.label(ix.by.get(s))} ${what(ix.by.get(s))}`);
  console.log("feeds:");
  const seen = new Set();
  const down = (id, depth) => {
    for (const w of (ix.by.get(id)?.wires ?? []).flat()) {
      if (seen.has(w)) continue;
      seen.add(w);
      const n = ix.by.get(w);
      if (n === undefined) continue;
      console.log(`${"  ".repeat(depth)}→ ${ix.label(n)} ${what(n)}`);
      down(w, depth + 1);
    }
  };
  down(root.id, 1);
} else if (cmd === "disable" || cmd === "enable") {
  if (args.length === 0) throw new Error("which node ids?");
  const missing = args.filter((a) => !ix.by.has(a));
  if (missing.length > 0) throw new Error(`no such nodes: ${missing.join(", ")} (nothing changed)`);
  const backup = `flows.backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(backup, JSON.stringify(cur, null, 1));
  console.log(`backup → ${backup}`);
  for (const a of args) {
    const n = ix.by.get(a);
    if (cmd === "disable") n.d = true;
    else delete n.d;
  }
  const r = await fetch(nr.base + "flows", {
    method: "POST",
    headers: { ...nr.headers, "Content-Type": "application/json", "Node-RED-Deployment-Type": "nodes" },
    body: JSON.stringify(cur),
  });
  console.log(`deploy ${r.status} ${await r.text()}`);
  const after = index((await getFlows(nr)).flows);
  for (const a of args) console.log(`now  ${after.label(after.by.get(a))}`);
} else {
  console.error("usage: nodered.mjs dump [file] | effects | trace <id> | disable <id>... | enable <id>...");
  process.exit(2);
}
