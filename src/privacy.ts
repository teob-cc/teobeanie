// privacy.ts — the scan that keeps one real house out of the public tree and out of an
// exported package: a private deny list, chat ids, tokens, private/tailnet addresses and
// entity ids that are not generic placeholders. Used by scripts/privacy-scan.mjs (CI, before a
// push) and meant for the package_export tool. Only node builtins here: the script loads it directly.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export type PrivacyRule = "deny-list" | "chat-id" | "bot-token" | "ha-token" | "private-ip" | "entity-id";

export interface PrivacyHit {
  file: string;
  line: number;
  rule: PrivacyRule;
  reason: string;
}

export interface PrivacyOptions {
  /** Words/phrases that must not appear (case-insensitive, whole token). */
  deny?: string[];
  /** Extra object ids allowed in entity ids, besides the built-in placeholders. */
  allowObjectIds?: Iterable<string>;
  /** Files (relative, forward slashes) exempt from every rule but the deny list (synthetic fixtures); each has a reason in the allow file. */
  allowFiles?: Iterable<string>;
}

const HA_DOMAINS = [
  "light", "switch", "sensor", "binary_sensor", "climate", "cover", "input_boolean", "input_number",
  "input_select", "input_text", "input_datetime", "fan", "lock", "media_player", "person",
  "device_tracker", "automation", "script", "scene", "vacuum", "camera", "alarm_control_panel",
  "water_heater", "number", "select", "button", "weather", "sun", "zone", "update", "event", "notify",
  "humidifier", "siren", "valve", "remote", "text", "todo", "calendar", "image", "tts",
];

/** Service and attribute names that follow a domain in code and docs: `light.turn_on`, `sun.elevation`. */
const SERVICE_WORDS = new Set([
  "turn_on", "turn_off", "toggle", "set_hvac_mode", "set_temperature", "set_fan_mode", "set_preset_mode",
  "select_option", "set_value", "open_cover", "close_cover", "set_cover_position", "stop_cover", "press",
  "open_valve", "close_valve", "reload", "trigger", "send_message", "volume_set", "media_play", "media_pause", "lock", "unlock",
  "elevation", "azimuth", "next", "next_rising", "next_setting", "state", "states", "attributes",
]);

/**
 * Generic placeholder object ids used by examples, docs and tests, each reviewed as a generic role,
 * room or fixture name (plus a few code words that follow a domain-like identifier, e.g. `event.at`).
 * Never add a real house's name here: an id specific to one house gets renamed, not listed.
 */
const PLACEHOLDER_OBJECT_IDS = new Set<string>([
  "dark", "garage", "not_declared", "opener", "packages", "via",
  "a", "a_motion", "ac_output", "action", "alex", "alpha_plug", "at", "attic", "attic_unit",
  "attic_window", "aussen_temperature", "awning", "b", "b_motion", "back", "back_door", "bath",
  "bath_door", "bath_leak", "bath_motion", "bathroom_extract_rh", "bathroom_leak", "bedroom", "blinds",
  "blinds_1", "blinds_remote_", "blinds_remote_down", "blinds_remote_up", "boiler", "boiler_flame",
  "boiler_flow_temperature", "boiler_heating", "boiler_hot_water", "boiler_room_leak", "btn_1",
  "btn_2", "by", "c", "c_motion", "carport_door", "carport_garage_door", "cat", "ch", "ch_active",
  "circulation_pmp", "circulation_pump", "clear", "climate", "cloud_thing", "coffee_machine",
  "condition", "currently_delivered", "currently_returned", "d", "data", "den", "den_", "den_blinds",
  "den_ceiling", "den_climate_temperature", "den_co2", "den_door", "den_lamp", "den_motion",
  "den_pm10", "den_pm25", "den_reading", "den_room_temperature", "den_speaker", "den_spot",
  "den_temperature", "den_tv", "den_unit", "diag", "dishwasher_power", "domain", "door",
  "doorstep_motion", "dupe", "e_motion", "eid", "electricity_price", "energy_price", "entity",
  "example", "extra", "fridge_door", "fridge_power", "front", "front_door",
  "front_door_contact", "front_outside", "garage", "garage_door", "garage_door_contact", "garage_l1",
  "garage_l2", "garage_occupancy", "garage_opener_relay", "garden", "garden_lights", "garden_lux",
  "garden_temperature", "gas_meter", "gas_price", "gas_total", "gate", "gate_relay",
  "golden_temperature", "grid_carbon", "grid_export", "grid_export_energy", "grid_import",
  "grid_import_energy", "grid_power", "grid_power_export", "grid_power_import", "groups",
  "guest_room_humidity", "hall", "hall_bright", "hall_lower", "hall_lower_motion", "hall_lux",
  "hall_motion", "hall_smoke", "hall_upper", "hall_upper_motion", "hallway", "hallway_ceiling",
  "hallway_motion", "hallway_night", "heat_pump", "heat_pump_", "heat_pump_flow_rate",
  "heat_pump_flow_temperature", "home", "hot", "in", "indoor_co2", "indoor_humidity",
  "indoor_temperature", "inner_door", "input", "inside", "inv", "js", "json", "key", "kitchen",
  "kitchen_ceiling", "kitchen_leak", "kitchen_motion", "kitchen_temperature", "l", "l1", "l2", "lamp_",
  "lamp_204", "lamp_5", "leak_a", "leak_kitchen", "leak_meters", "length", "litres", "living",
  "living_room", "living_room_blinds", "living_room_temperature", "lux", "main_water",
  "main_water_valve", "md", "meter_power_returned", "mjs", "mode", "n", "night_mode", "noisy_",
  "noisy_debug_counter", "not_listed", "of", "outdoor_humidity", "outdoor_temperature", "outside",
  "outside_temp", "p1", "p1_a", "p1_b", "p1_power", "pet", "plants", "porch", "porch_illuminance",
  "porch_lamp", "porch_light", "porch_lux", "porch_motion", "power", "power_consumption",
  "power_production", "price", "printer", "pump", "pump_fault", "r", "remote_battery", "rest", "seen",
  "sensor", "service", "shed", "shed_", "shed_door", "shed_occupancy", "shed_string", "side", "since",
  "solar_power", "stairs", "stairs_1", "stairs_2", "stairs_a", "stairs_b", "stairs_bottom",
  "stairs_bottom_motion", "stairs_top", "stairs_top_illuminance_above_threshold", "stairs_top_motion",
  "study", "study_room_humidity", "study_room_temperature", "sun", "tag", "temp", "test", "timer",
  "to", "triggers", "ts", "tunnel", "tunnel_mouth", "turn_onn", "underfloor_heating_pump", "unowned",
  "until", "user", "valve", "ventilation", "ventilation_exhaust_temperature",
  "ventilation_supply_airflow", "wall", "want", "washer", "washing_machine_power", "water_total",
  "water_valve", "x", "xm1_power", "y", "yaml", "yml", "zeta_loose",
]);

// Documented placeholders: RFC-style example ranges, the Home Assistant Supervisor's own docker
// network (172.30.32.0/23, a product constant) and the 100.101.102.103 tailnet example.
const PLACEHOLDER_IP =
  /^(?:192\.168\.(?:0|1)\.\d+|10\.0\.0\.\d+|172\.16\.0\.\d+|100\.64\.0\.\d+|172\.30\.3[23]\.\d+|100\.101\.102\.\d+)$/;

const TEXT_EXT = /\.(?:ts|tsx|mts|mjs|cjs|js|json|md|yaml|yml|txt|sh|html|css|svelte|toml|env|conf)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "panel-dist"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseDeny(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** PRIVACY_DENY (newline separated) wins over the file PRIVACY_DENY_FILE (default ~/.config/teobeanie/privacy-deny.txt). */
export function loadDenyList(env: NodeJS.ProcessEnv = process.env): { words: string[]; source: string | null } {
  if (env.PRIVACY_DENY?.trim()) return { words: parseDeny(env.PRIVACY_DENY), source: "PRIVACY_DENY" };
  const file = env.PRIVACY_DENY_FILE || join(homedir(), ".config", "teobeanie", "privacy-deny.txt");
  if (existsSync(file)) return { words: parseDeny(readFileSync(file, "utf8")), source: file };
  return { words: [], source: null };
}

/** Lines: `path  # reason` (file exempt from every rule but the deny list) or `object:<id>  # reason` (extra placeholder object id). */
export function parseAllow(text: string): { files: string[]; objectIds: string[] } {
  const files: string[] = [];
  const objectIds: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const m = l.match(/^object:([a-z0-9_]+)\b/);
    if (m) objectIds.push(m[1]!);
    else files.push(l.split(/\s+#/)[0]!.trim());
  }
  return { files, objectIds };
}

function ipv4Private(a: number, b: number): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Scan one file's text. `file` is only a label (and the allow-file key). */
export function scanText(file: string, text: string, opts: PrivacyOptions = {}): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  const allowObj = new Set([...PLACEHOLDER_OBJECT_IDS, ...(opts.allowObjectIds ?? [])]);
  const exempt = new Set(opts.allowFiles ?? []).has(file);
  const denyRes = (opts.deny ?? []).map((w) => ({
    w,
    re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "iu"),
  }));
  const entityRe = new RegExp(`(?<![\\w.])(${HA_DOMAINS.join("|")})\\.([a-z0-9_]+)(?![\\w(])`, "g");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    const add = (rule: PrivacyRule, reason: string) => hits.push({ file, line: n, rule, reason });
    for (const d of denyRes) if (d.re.test(line)) add("deny-list", "contains a word from the private deny list");
    if (exempt) return;
    for (const m of line.matchAll(/(?<![\d.])-\d{10,}(?!\d)/g)) {
      add("chat-id", `Telegram chat id shape (${m[0].startsWith("-100") ? "-100…" : "negative 10+ digits"})`);
    }
    if (/(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/.test(line)) add("bot-token", "Telegram bot token shape");
    if (/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(line)) add("ha-token", "JWT-shaped token (HA long-lived access token)");
    for (const m of line.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d])/g)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (m.slice(1).some((o) => Number(o) > 255)) continue;
      if (ipv4Private(a, b) && !PLACEHOLDER_IP.test(m[0])) add("private-ip", `private or tailnet address ${a}.${b}.x.x outside the documented placeholders`);
    }
    {
      for (const m of line.matchAll(entityRe)) {
        const [, domain, obj] = m;
        if (SERVICE_WORDS.has(obj!) || allowObj.has(obj!)) continue;
        add("entity-id", `entity id ${domain}.<object_id> whose object id is not a listed placeholder`);
      }
    }
  });
  return hits;
}

function isText(path: string): boolean {
  return TEXT_EXT.test(path) || /(^|\/)(LICENSE|Dockerfile)$/.test(path);
}

/** Tracked files of the git repo at `dir`, or null when it is not one. */
export function trackedFiles(dir: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(root: string, dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile()) out.push(relative(root, p).split(sep).join("/"));
  }
}

/** Scan a folder: its tracked files when `useGit` and it is a git repo, else every text file below it. */
export function scanFolder(dir: string, opts: PrivacyOptions & { useGit?: boolean } = {}): PrivacyHit[] {
  let files = opts.useGit ? trackedFiles(dir) : null;
  if (!files) {
    files = [];
    walk(dir, dir, files);
  }
  const hits: PrivacyHit[] = [];
  for (const f of files) {
    const p = join(dir, f);
    if (!isText(f)) continue;
    try {
      if (!statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    hits.push(...scanText(f, readFileSync(p, "utf8"), opts));
  }
  return hits;
}

export function formatHit(h: PrivacyHit): string {
  return `${h.file}:${h.line}: [${h.rule}] ${h.reason}`;
}
