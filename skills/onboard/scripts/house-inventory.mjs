#!/usr/bin/env node
// house-inventory.mjs — what a Home Assistant house has, read-only, and which behaviour
// packages fit it.
//
//   HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=~/.config/teobeanie/ha-token \
//     node house-inventory.mjs [<packages folder>] [--json]
//
// Reads GET /api/config, GET /api/states and POST /api/template (areas and devices, a
// template is only rendered). Nothing else: it never calls a service. Prints the house
// per area, then for each heuristic of each package (its teobeanie.json roles) the
// entities that could fill each role, and the areas where every required role has one.
// <packages folder> defaults to the starter packages next to this plugin. --json prints
// the whole inventory instead, for a closer look.
//
// The output is the house's own data: keep it on this machine, never in a public place.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const packagesDir = args.find((a) => !a.startsWith("--")) ?? join(here, "..", "..", "..", "packages");
const fail = (msg) => {
  process.stderr.write(`house-inventory: ${msg}\n`);
  process.exit(1);
};

const haUrl = (process.env.HA_URL ?? "http://homeassistant.local:8123").replace(/\/$/, "");
const tokenFile = (process.env.HA_TOKEN_FILE ?? "~/.config/teobeanie/ha-token").replace(/^~(?=\/)/, homedir());
const token = (process.env.HA_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : "")).trim();
if (!token) fail(`no token: set HA_TOKEN, or put a long-lived token in ${tokenFile}`);

async function ha(path, body) {
  let res;
  try {
    res = await fetch(`${haUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    fail(`cannot reach ${haUrl} (${e.cause?.code ?? e.message}): set HA_URL to Home Assistant's address`);
  }
  if (res.status === 401) fail("Home Assistant refused the token (401): make a new long-lived token");
  if (!res.ok) fail(`${path}: ${res.status} ${res.statusText}`);
  return path === "/api/template" ? res.text() : res.json();
}

// Areas and devices come from templates: the REST API has no registry endpoints.
const TEMPLATE = `{%- set ns = namespace(rows=[]) -%}
{%- for s in states -%}
{%- set ns.rows = ns.rows + [[s.entity_id, area_name(s.entity_id), device_attr(s.entity_id, 'name_by_user') or device_attr(s.entity_id, 'name'), device_attr(s.entity_id, 'manufacturer'), device_attr(s.entity_id, 'model')]] -%}
{%- endfor -%}
{{ {"areas": areas() | map('area_name') | list, "entities": ns.rows} | tojson }}`;

const config = await ha("/api/config");
const states = await ha("/api/states");
const registry = JSON.parse(await ha("/api/template", { template: TEMPLATE }));
const where = new Map(registry.entities.map(([id, area, device, manufacturer, model]) => [id, { area, device, manufacturer, model }]));

const entities = states.map((s) => {
  const w = where.get(s.entity_id) ?? {};
  return {
    id: s.entity_id,
    domain: s.entity_id.split(".")[0],
    name: s.attributes?.friendly_name ?? s.entity_id,
    device_class: s.attributes?.device_class ?? null,
    state: s.state,
    area: w.area ?? null,
    device: w.device ?? null,
    manufacturer: w.manufacturer ?? null,
    model: w.model ?? null,
  };
});

// ---- the packages' roles ----
const list = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
const fits = (role, e) =>
  (list(role.domain) ?? []).includes(e.domain) &&
  (role.device_class === undefined || list(role.device_class).includes(e.device_class ?? ""));
const packages = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(packagesDir, d.name, "teobeanie.json")))
      .map((d) => JSON.parse(readFileSync(join(packagesDir, d.name, "teobeanie.json"), "utf8")))
  : [];
if (packages.length === 0) process.stderr.write(`house-inventory: no packages in ${packagesDir}: only the house is listed\n`);

const matches = packages.flatMap((pkg) =>
  Object.entries(pkg.heuristics ?? {}).map(([heuristic, h]) => {
    const roles = Object.entries(h.roles ?? {}).map(([path, role]) => ({
      path,
      required: role.optional !== true,
      operate: role.operate === true,
      many: role.many === true,
      wants: `${list(role.domain)?.join("|")}${role.device_class !== undefined ? ` (${list(role.device_class).join("|")})` : ""}`,
      candidates: entities.filter((e) => fits(role, e)),
    }));
    const required = roles.filter((r) => r.required);
    const areaNames = [...new Set(entities.map((e) => e.area).filter((a) => a !== null))];
    const areas = areaNames.filter((a) => required.length > 0 && required.every((r) => r.candidates.some((e) => e.area === a)));
    return { package: pkg.name, heuristic, title: h.title ?? heuristic, pattern: h.pattern ?? pkg.pattern, uses: h.uses ?? [], fits: required.every((r) => r.candidates.length > 0), areas, roles };
  }),
);

if (asJson) {
  const slim = (e) => ({ id: e.id, name: e.name, area: e.area, state: e.state });
  console.log(JSON.stringify({
    house: { time_zone: config.time_zone, version: config.version, unit_system: config.unit_system, areas: registry.areas, entities: entities.length },
    entities,
    packages: matches.map((m) => ({ ...m, roles: m.roles.map((r) => ({ ...r, candidates: r.candidates.map(slim) })) })),
  }, null, 2));
  process.exit(0);
}

// ---- the house, per area ----
const KINDS = [
  ["lights", (e) => e.domain === "light"],
  ["switches", (e) => e.domain === "switch"],
  ["presence", (e) => e.domain === "binary_sensor" && ["motion", "occupancy", "presence"].includes(e.device_class)],
  ["doors/windows", (e) => e.domain === "binary_sensor" && ["door", "garage_door", "window", "opening"].includes(e.device_class)],
  ["leak", (e) => e.domain === "binary_sensor" && e.device_class === "moisture"],
  ["climate", (e) => e.domain === "climate"],
  ["covers", (e) => e.domain === "cover"],
  ["valves", (e) => e.domain === "valve"],
  ["buttons", (e) => e.domain === "event" && e.device_class === "button"],
  ["temperature", (e) => e.domain === "sensor" && e.device_class === "temperature"],
  ["illuminance", (e) => e.domain === "sensor" && e.device_class === "illuminance"],
  ["meters", (e) => e.domain === "sensor" && ["water", "gas", "energy"].includes(e.device_class)],
];
const byArea = new Map();
for (const e of entities) {
  const a = e.area ?? "(no area)";
  if (!byArea.has(a)) byArea.set(a, []);
  byArea.get(a).push(e);
}
console.log(`# ${haUrl}: Home Assistant ${config.version}, time zone ${config.time_zone}, ${entities.length} entities, ${registry.areas.length} areas\n`);
console.log(`| Area | ${KINDS.map(([k]) => k).join(" | ")} | all |`);
console.log(`|---|${KINDS.map(() => "---:").join("|")}|---:|`);
const order = [...byArea.keys()].sort((a, b) => (a === "(no area)") - (b === "(no area)") || a.localeCompare(b));
for (const a of order) {
  const es = byArea.get(a);
  console.log(`| ${a} | ${KINDS.map(([, test]) => es.filter(test).length || "").join(" | ")} | ${es.length} |`);
}
const domains = Object.entries(entities.reduce((m, e) => ({ ...m, [e.domain]: (m[e.domain] ?? 0) + 1 }), {})).sort((x, y) => y[1] - x[1]);
console.log(`\nBy domain: ${domains.map(([d, n]) => `${d} ${n}`).join(", ")}`);

// ---- which packages fit ----
console.log("\n# Packages\n");
const show = (es) => es.slice(0, 4).map((e) => `${e.id}${e.area ? ` [${e.area}]` : ""}`).join(", ") + (es.length > 4 ? `, … ${es.length - 4} more` : "");
for (const m of [...matches].sort((x, y) => Number(y.fits) - Number(x.fits))) {
  console.log(`## ${m.package} / ${m.heuristic} (${m.pattern}): ${m.fits ? "fits" : "missing a required role"}${m.uses.length > 0 ? ` · uses ${m.uses.join(", ")}` : ""}`);
  if (m.areas.length > 0) console.log(`areas with every required role: ${m.areas.join(", ")}`);
  for (const r of m.roles) {
    console.log(`- ${r.path}${r.required ? "" : " (optional)"}${r.operate ? " · switched" : ""}${r.many ? " · several" : ""}: ${r.wants}: ${r.candidates.length === 0 ? "none" : `${r.candidates.length}: ${show(r.candidates)}`}`);
  }
  console.log("");
}
