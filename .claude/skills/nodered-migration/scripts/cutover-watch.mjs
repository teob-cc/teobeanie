#!/usr/bin/env node
// Watch one Teobeanie instance after a cut-over: its decisions and calls from Teobeanie's journal,
// HA state changes of its entities (with who changed them), and every service call on
// the entities it owns, labelled Teobeanie, a person, or a system user. A system user's call
// on an owned entity (Node-RED, another add-on) is the thing to look for: ALERT.
//
//   HA_URL=... HA_TOKEN=... node cutover-watch.mjs <heuristic>/<id> <entity>...
//
// The owned entities are the light./switch./cover./climate./valve./fan. ones given. One
// line per event, flushed as it goes; append to a log and tail it. FROM=<globalSeq>
// replays the journal from there. TEOB_SLUG overrides the add-on slug; by default the
// installed Teobeanie add-on is found through the Supervisor (as the MCP bridge does).

const HA_URL = (process.env.HA_URL ?? "http://homeassistant.local:8123").replace(/\/$/, "");
const TOKEN = process.env.HA_TOKEN?.trim();
let SLUG = process.env.TEOB_SLUG || undefined;
const TZ = process.env.TZ_DISPLAY ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const [key, ...entities] = process.argv.slice(2);
if (!TOKEN || !key?.includes("/")) {
  console.error("usage: HA_TOKEN=... node cutover-watch.mjs <heuristic>/<id> <entity>...");
  process.exit(2);
}
const owned = entities.filter((e) => /^(light|switch|cover|climate|valve|fan|lock|media_player)\./.test(e));
const tag = key.split("/").pop();
const fmt = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false });
const out = (kind, at, text) => process.stdout.write(`[${kind} ${tag} ${at}] ${text}\n`);

let ws;
let id = 0;
const pending = new Map();
const call = (msg) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, ...msg })); });
/** HA user id → { name, system }. */
const users = new Map();
const who = (userId) => {
  if (userId === null || userId === undefined) return { label: "device", system: false };
  const u = users.get(userId);
  return u === undefined ? { label: `user ${userId.slice(0, 8)}`, system: true } : { label: u.system ? `system:${u.name}` : `user:${u.name}`, system: u.system };
};
/** HA context ids of Teobeanie's own calls (every instance), from ActionCompleted. */
const ours = new Set();
const requested = [];

const isTeobeanie = (slug) => slug === "teobeanie" || slug.endsWith("_teobeanie") || slug === "local_teob_home";
async function findSlug() {
  const found = ((await call({ type: "supervisor/api", endpoint: "/addons", method: "get" })).result?.addons ?? [])
    .filter((a) => typeof a.slug === "string" && isTeobeanie(a.slug) && a.installed !== false);
  const started = found.filter((a) => a.state === "started");
  const pick = found.length === 1 ? found[0] : started.length === 1 ? started[0] : undefined;
  if (!pick) throw new Error(`cannot tell the Teobeanie add-on (${found.map((a) => a.slug).join(", ") || "none installed"}): set TEOB_SLUG`);
  return pick.slug;
}

async function ingress() {
  SLUG ??= await findSlug();
  const sess = (await call({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" })).result.session;
  const info = (await call({ type: "supervisor/api", endpoint: `/addons/${SLUG}/info`, method: "get" })).result;
  return { base: HA_URL + info.ingress_url, headers: { Cookie: `ingress_session=${sess}` } };
}

let last = Number(process.env.FROM ?? -1);
async function poll() {
  try {
    const { base, headers } = await ingress();
    const { rows } = await (await fetch(base + "api/journal?limit=300", { headers })).json();
    if (last < 0) {
      last = rows.reduce((m, r) => Math.max(m, r.globalSeq), 0);
      out("watch", fmt(Date.now()), `journal at ${last}`);
      return;
    }
    const fresh = rows.filter((r) => r.globalSeq > last).sort((a, b) => a.globalSeq - b.globalSeq);
    for (const r of fresh) if (r.payload?.tag === "ActionCompleted" && r.payload.haContextId) ours.add(r.payload.haContextId);
    for (const r of fresh) {
      last = Math.max(last, r.globalSeq);
      const p = r.payload ?? {};
      const at = fmt(r.ts * 1000);
      if (`${r.category}/${r.entityId}` === key || r.envelope?.correlationId === key) {
        if (p.tag === "Decided") out("Teobeanie", at, `decided: ${p.why ?? ""}`);
        else if (p.tag === "ActionRequested") {
          for (const e of p.action?.entities ?? []) requested.push({ entity: e, service: p.action.service, at: r.ts * 1000 });
          out("Teobeanie", at, `CALL ${p.action?.service ?? p.action?.kind} ${(p.action?.entities ?? []).join(",")}${p.action?.text ? ` "${p.action.text}"` : ""}`);
        } else if (p.tag === "ActionCompleted") out(p.ok ? "Teobeanie" : "ALERT", at, `completed ok=${p.ok}${p.error ? ` ${p.error}` : ""}`);
        else if (p.tag === "ActionRefused") out("ALERT", at, `REFUSED ${p.action?.service ?? ""}: ${p.reason}`);
        else if (p.tag === "ActionSuppressed") out("shadow", at, `would ${p.action?.service ?? p.action?.kind} ${(p.action?.entities ?? []).join(",")}${p.action?.text ? ` "${p.action.text}"` : ""}`);
      } else if (p.tag === "HaCallServiceObserved" && p.entityIds?.some((e) => owned.includes(e))) {
        const svc = `${p.domain}.${p.service}`;
        const teob = ours.has(p.haContextId) || p.entityIds.every((e) => requested.some((q) => q.entity === e && q.service === svc && Math.abs(p.at - q.at) < 5000));
        const w = who(p.haUserId);
        out(teob ? "call" : w.system ? "ALERT" : "call", at, `${teob ? "Teobeanie" : w.label} ${svc} ${p.entityIds.join(",")}`);
      }
    }
    while (requested.length > 0 && Date.now() - requested[0].at > 60_000) requested.shift();
  } catch (e) {
    out("watch", fmt(Date.now()), `poll failed: ${e.message}`);
  }
}

function connect() {
  ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "auth_required") return ws.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
    if (m.type === "auth_ok") {
      const list = await call({ type: "config/auth/list" });
      for (const u of list.result ?? []) users.set(u.id, { name: u.name, system: u.system_generated === true });
      await call({ type: "subscribe_events", event_type: "state_changed" });
      out("watch", fmt(Date.now()), `connected, watching ${key}: ${entities.join(", ")}`);
      return poll();
    }
    if (m.type === "event" && m.event?.event_type === "state_changed") {
      const d = m.event.data;
      if (!entities.includes(d.entity_id) || d.old_state?.state === d.new_state?.state) return;
      const c = d.new_state?.context ?? {};
      out("state", fmt(Date.parse(d.new_state?.last_changed ?? m.event.time_fired)), `${d.entity_id} ${d.old_state?.state} → ${d.new_state?.state} (${who(c.user_id).label})`);
      return;
    }
    if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
  };
  ws.onclose = () => {
    out("watch", fmt(Date.now()), "HA connection closed, reconnecting in 10 s");
    setTimeout(connect, 10_000);
  };
}

connect();
setInterval(() => ws?.readyState === WebSocket.OPEN && poll(), 15_000);
