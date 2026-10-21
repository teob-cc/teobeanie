// layout.ts — the House view's grouping. Every entity in the house scope lands in one
// section (energy, doors & windows, lights, climate, outdoor, presence, safety, other)
// with a role the panel's summaries read (grid_import, door, room_temperature, ...).
// Generic by construction: domain, device_class, unit, Home Assistant's areas and
// devices, and a few generic English words in the name ("outdoor", "solar",
// "setpoint"). Words of a house's own language, meter or brands go into tiles.json
// "groups.keywords"; whatever else a house wants differently is an override there.
// Pure (no Node, no I/O): the server and the panel both import it.

export const SECTIONS = [
  { id: "energy", title: "Energy" },
  { id: "security", title: "Doors & windows" },
  { id: "lights", title: "Lights & switches" },
  { id: "climate", title: "Climate" },
  { id: "outdoor", title: "Outdoor" },
  { id: "presence", title: "Presence" },
  { id: "safety", title: "Safety & water" },
  { id: "other", title: "Other" },
] as const;

export type BuiltinSection = (typeof SECTIONS)[number]["id"];

/** Each role's home section, and the label of its group when nothing better names one. */
export const ROLES = {
  grid_import: { section: "energy", group: "Grid" },
  grid_export: { section: "energy", group: "Grid" },
  solar: { section: "energy", group: "Solar" },
  power: { section: "energy", group: "Power" },
  energy: { section: "energy", group: "Meters" },
  gas: { section: "energy", group: "Gas" },
  carbon_intensity: { section: "energy", group: "Grid" },
  electrical: { section: "energy", group: "Electrical" },
  price: { section: "energy", group: "Prices" },
  door: { section: "security", group: "Doors" },
  window: { section: "security", group: "Windows" },
  garage_door: { section: "security", group: "Garage" },
  lock: { section: "security", group: "Locks" },
  cover: { section: "security", group: "Covers" },
  alarm: { section: "security", group: "Alarm" },
  light: { section: "lights", group: "Lights" },
  switch: { section: "lights", group: "Switches & plugs" },
  illuminance: { section: "lights", group: "Light level" },
  thermostat: { section: "climate", group: "Thermostats" },
  ventilation: { section: "climate", group: "Ventilation" },
  heating: { section: "climate", group: "Heating" },
  room_temperature: { section: "climate", group: "Rooms" },
  room_humidity: { section: "climate", group: "Rooms" },
  co2: { section: "climate", group: "Air quality" },
  air_quality: { section: "climate", group: "Air quality" },
  temperature: { section: "climate", group: "Temperatures" },
  humidity: { section: "climate", group: "Humidity" },
  weather: { section: "outdoor", group: "Weather" },
  outdoor_temperature: { section: "outdoor", group: "Outdoor sensors" },
  outdoor_humidity: { section: "outdoor", group: "Outdoor sensors" },
  outdoor_illuminance: { section: "outdoor", group: "Outdoor sensors" },
  wind: { section: "outdoor", group: "Outdoor sensors" },
  sun: { section: "outdoor", group: "Sun" },
  person: { section: "presence", group: "People" },
  tracker: { section: "presence", group: "Trackers" },
  occupancy: { section: "presence", group: "Occupancy" },
  leak: { section: "safety", group: "Leaks" },
  smoke: { section: "safety", group: "Smoke & gas" },
  gas_alarm: { section: "safety", group: "Smoke & gas" },
  co_alarm: { section: "safety", group: "Smoke & gas" },
  problem: { section: "safety", group: "Problems" },
  valve: { section: "safety", group: "Valves" },
  water: { section: "safety", group: "Water" },
  battery: { section: "other", group: "Batteries" },
} as const satisfies Record<string, { section: BuiltinSection; group: string }>;

export type Role = keyof typeof ROLES;

export const isRole = (r: unknown): r is Role => typeof r === "string" && Object.hasOwn(ROLES, r);

/** One entity as the classifier sees it: its state plus registry facts. */
export interface EntityFacts {
  id: string;
  state: string;
  attributes: Record<string, unknown>;
  /** Area name (the entity's own, else its device's). */
  area?: string;
  /** Where `area` comes from: the entity's own area or its device's. Default "entity". */
  areaFrom?: "entity" | "device";
  /** Device name and id from the device registry. */
  device?: string;
  deviceId?: string;
}

/** Which devices HA's energy dashboard knows as the grid meter and the solar inverter. */
export interface EnergyHints {
  gridDevices?: ReadonlySet<string>;
  solarDevices?: ReadonlySet<string>;
}

// ---- tiles.json "groups" -------------------------------------------------------

export interface SectionOverride {
  title?: string;
  /** Leave the section out of the view. */
  hidden?: boolean;
  /** Start collapsed (a viewer's own toggle wins). */
  collapsed?: boolean;
}

export interface EntityOverride {
  section?: string;
  group?: string;
  name?: string;
  role?: Role;
  hidden?: boolean;
}

export interface GroupsConfig {
  /** Section order; sections not listed follow in their default order. */
  order?: string[];
  /** Rename, hide or collapse a built-in section, or declare a new one. */
  sections?: Record<string, SectionOverride>;
  /** Per entity id; "*" matches any run of characters ("sensor.*_daily_*"). Exact ids win over patterns. */
  entities?: Record<string, EntityOverride>;
  /** Entities shown in the pinned row on top, after the tiles. */
  pin?: string[];
  /** Extra words per name test, added to the generic English defaults. */
  keywords?: Keywords;
}

/** The name tests the classifier runs on an entity's id and friendly name. */
export const KEYWORD_KINDS = ["outdoor", "room", "equipment", "solar", "grid", "export", "garage"] as const;
export type KeywordKind = (typeof KEYWORD_KINDS)[number];
export type Keywords = Partial<Record<KeywordKind, string[]>>;

/**
 * The generic defaults: English words, each matching at the start of a word
 * ("outdoor" also matches "outdoors"). Words of one language, meter or brand belong
 * in tiles.json "groups.keywords".
 */
export const DEFAULT_KEYWORDS: Record<KeywordKind, readonly string[]> = {
  /** A temperature, humidity or light level outside the house. */
  outdoor: ["outdoor", "outside", "exterior"],
  /** A room's reading (a single temperature on its device is a room's anyway). */
  room: ["room", "indoor", "inside"],
  /** Equipment, never a room: setpoints, flow and return, appliances. */
  equipment: ["setpoint", "setback", "target", "water", "flow", "return", "supply", "exhaust", "extract", "boiler", "dhw", "cpu", "chip", "device", "internal", "battery", "fridge", "freezer", "oven", "pipe", "tank", "coolant", "refrigerant"],
  /** Power from solar panels. */
  solar: ["solar", "pv", "photovolt", "inverter"],
  /** Power measured at the grid connection. */
  grid: ["grid", "meter", "mains"],
  /** Power going to the grid rather than coming from it. */
  export: ["return", "returned", "export", "exported", "production", "produced", "injection", "feed in", "to grid"],
  /** A door contact that is an overhead or garage door (Home Assistant's own device classes need no word). */
  garage: [],
};

export type Matchers = Record<KeywordKind, RegExp>;

/** Lower case, separators as spaces: "Den_CO2" → "den co2". */
const words1 = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[_.\-:/()[\]]+/g, " ")
    .trim();

/** The defaults plus a house's keywords, compiled; a keyword matches at a word start in any script ("außen"). */
export function matchers(keywords: Keywords = {}): Matchers {
  const out = {} as Matchers;
  for (const k of KEYWORD_KINDS) {
    const all = [...DEFAULT_KEYWORDS[k], ...(keywords[k] ?? [])].map(words1).filter((w) => w !== "");
    if (all.length === 0) {
      out[k] = /(?!)/u;
      continue;
    }
    const alternatives = all.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, " ?"));
    out[k] = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})`, "u");
  }
  return out;
}

const DEFAULT_MATCHERS = matchers();

const SECTION_KEYS = new Set(["title", "hidden", "collapsed"]);
const ENTITY_KEYS = new Set(["section", "group", "name", "role", "hidden"]);
const GROUPS_KEYS = new Set(["order", "sections", "entities", "pin", "keywords"]);
const BUILTIN = new Set<string>(SECTIONS.map((s) => s.id));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validate tiles.json "groups"; throws with the offending path. */
export function parseGroups(raw: unknown, where = "groups"): GroupsConfig {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  for (const k of Object.keys(raw)) if (!GROUPS_KEYS.has(k)) throw new Error(`${where}: unknown key "${k}" (${[...GROUPS_KEYS].join(", ")})`);
  const out: GroupsConfig = {};
  if (raw["order"] !== undefined) {
    if (!isStringArray(raw["order"])) throw new Error(`${where}.order must be an array of section ids`);
    out.order = raw["order"];
  }
  if (raw["pin"] !== undefined) {
    if (!isStringArray(raw["pin"])) throw new Error(`${where}.pin must be an array of entity ids`);
    out.pin = raw["pin"];
  }
  if (raw["keywords"] !== undefined) {
    const kw = raw["keywords"];
    if (!isObject(kw)) throw new Error(`${where}.keywords must be an object`);
    out.keywords = {};
    for (const [k, v] of Object.entries(kw)) {
      if (!(KEYWORD_KINDS as readonly string[]).includes(k)) throw new Error(`${where}.keywords: unknown key "${k}" (${KEYWORD_KINDS.join(", ")})`);
      if (!isStringArray(v)) throw new Error(`${where}.keywords.${k} must be an array of words`);
      out.keywords[k as KeywordKind] = v;
    }
  }
  if (raw["sections"] !== undefined) {
    if (!isObject(raw["sections"])) throw new Error(`${where}.sections must be an object`);
    out.sections = {};
    for (const [id, s] of Object.entries(raw["sections"])) {
      if (!isObject(s)) throw new Error(`${where}.sections.${id} must be an object`);
      for (const k of Object.keys(s)) if (!SECTION_KEYS.has(k)) throw new Error(`${where}.sections.${id}: unknown key "${k}"`);
      if (s["title"] !== undefined && typeof s["title"] !== "string") throw new Error(`${where}.sections.${id}.title must be a string`);
      for (const k of ["hidden", "collapsed"]) if (s[k] !== undefined && typeof s[k] !== "boolean") throw new Error(`${where}.sections.${id}.${k} must be a boolean`);
      out.sections[id] = s as SectionOverride;
    }
  }
  const known = new Set([...BUILTIN, ...Object.keys(out.sections ?? {})]);
  for (const id of out.order ?? []) if (!known.has(id)) throw new Error(`${where}.order: unknown section "${id}" (declare it under sections)`);
  if (raw["entities"] !== undefined) {
    if (!isObject(raw["entities"])) throw new Error(`${where}.entities must be an object`);
    out.entities = {};
    for (const [id, e] of Object.entries(raw["entities"])) {
      if (!isObject(e)) throw new Error(`${where}.entities["${id}"] must be an object`);
      for (const k of Object.keys(e)) if (!ENTITY_KEYS.has(k)) throw new Error(`${where}.entities["${id}"]: unknown key "${k}" (${[...ENTITY_KEYS].join(", ")})`);
      for (const k of ["section", "group", "name"]) if (e[k] !== undefined && typeof e[k] !== "string") throw new Error(`${where}.entities["${id}"].${k} must be a string`);
      if (e["hidden"] !== undefined && typeof e["hidden"] !== "boolean") throw new Error(`${where}.entities["${id}"].hidden must be a boolean`);
      if (e["role"] !== undefined && !isRole(e["role"])) throw new Error(`${where}.entities["${id}"].role "${String(e["role"])}" is not a role (${Object.keys(ROLES).join(", ")})`);
      if (typeof e["section"] === "string" && !known.has(e["section"])) throw new Error(`${where}.entities["${id}"].section "${e["section"]}" is unknown (declare it under sections)`);
      out.entities[id] = e as EntityOverride;
    }
  }
  return out;
}

/** The override for an entity: the exact id, else the first matching pattern in file order. */
export function overrideFor(groups: GroupsConfig, id: string): EntityOverride | undefined {
  const all = groups.entities;
  if (all === undefined) return undefined;
  if (Object.hasOwn(all, id)) return all[id];
  for (const [pattern, o] of Object.entries(all)) {
    if (pattern.includes("*") && globRegex(pattern).test(id)) return o;
  }
  return undefined;
}

const globs = new Map<string, RegExp>();
function globRegex(pattern: string): RegExp {
  let re = globs.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    globs.set(pattern, re);
  }
  return re;
}

// ---- classification ------------------------------------------------------------

/** id + friendly name, lower case, separators as spaces: "sensor.den_co2 Den CO2" → " sensor den co2 den co2 ". */
function words(f: EntityFacts): string {
  const name = typeof f.attributes["friendly_name"] === "string" ? f.attributes["friendly_name"] : "";
  return ` ${words1(f.id)} ${words1(name)} `;
}

const LIGHTISH = /(light|lamp|\bled\b)/;

const POWER_UNITS = new Set(["W", "kW", "MW"]);
const ENERGY_UNITS = new Set(["Wh", "kWh", "MWh"]);
const TEMP_UNITS = new Set(["°C", "°F", "K"]);

function attr(f: EntityFacts, key: string): string | undefined {
  const v = f.attributes[key];
  return typeof v === "string" ? v : undefined;
}

/** The role from the entity alone (device siblings and energy hints are applied after). */
export function baseRole(f: EntityFacts, hints: EnergyHints = {}, m: Matchers = DEFAULT_MATCHERS): Role | undefined {
  const domain = f.id.slice(0, f.id.indexOf("."));
  const dc = attr(f, "device_class");
  const unit = attr(f, "unit_of_measurement");
  const w = words(f);
  switch (domain) {
    case "person":
      return "person";
    case "device_tracker":
      return "tracker";
    case "light":
      return "light";
    case "lock":
      return "lock";
    case "alarm_control_panel":
      return "alarm";
    case "climate":
    case "water_heater":
      return "thermostat";
    case "fan":
    case "humidifier":
      return "ventilation";
    case "weather":
      return "weather";
    case "sun":
      return "sun";
    case "valve":
      return "valve";
    case "cover":
      return dc === "garage" || dc === "gate" ? "garage_door" : dc === "door" ? "door" : "cover";
    case "switch":
    case "input_boolean":
      if (/valve/.test(w)) return "valve";
      if (/\b(pump|heating|boiler|thermostat|radiator)/.test(w)) return "heating";
      if (LIGHTISH.test(w)) return "light";
      return "switch";
    case "binary_sensor":
      switch (dc) {
        case "door":
        case "opening":
          return m.garage.test(w) ? "garage_door" : "door";
        case "garage_door":
          return "garage_door";
        case "window":
          return "window";
        case "lock":
          return "lock";
        case "motion":
        case "occupancy":
        case "presence":
          return "occupancy";
        case "moisture":
          return "leak";
        case "smoke":
          return "smoke";
        case "gas":
          return "gas_alarm";
        case "carbon_monoxide":
          return "co_alarm";
        case "problem":
        case "safety":
        case "tamper":
          return "problem";
        case "heat":
          return "heating";
        case "battery":
          return "battery";
        default:
          if (/\b(leak|flood)/.test(w)) return "leak";
          return undefined;
      }
    case "sensor":
      break;
    default:
      return undefined;
  }
  // sensor.*
  if (dc === "power" || (dc === undefined && unit !== undefined && POWER_UNITS.has(unit))) return powerRole(f, w, hints, m);
  if (dc === "energy" || (dc === undefined && unit !== undefined && ENERGY_UNITS.has(unit))) return "energy";
  if (dc === "gas") return "gas";
  if (dc === "water") return "water";
  if (unit !== undefined && /co2/i.test(unit) && /kwh/i.test(unit)) return "carbon_intensity";
  if (dc === "monetary" || (unit !== undefined && /^(\p{Sc}|[A-Z]{3}|ct|cent)\s*\/\s*(k?wh|m³)$/iu.test(unit))) return "price";
  if (dc === undefined && unit === "m³" && /\bgas/.test(w)) return "gas";
  if (dc === "voltage" || dc === "current" || dc === "power_factor" || dc === "frequency" || dc === "apparent_power" || dc === "reactive_power") return "electrical";
  if (dc === "carbon_dioxide") return "co2";
  if (dc === "volatile_organic_compounds" || dc === "volatile_organic_compounds_parts" || dc === "pm25" || dc === "pm10" || dc === "pm1" || dc === "aqi" || dc === "nitrogen_dioxide" || dc === "ozone" || /\b(voc|nox|aqi)\b/.test(w)) return "air_quality";
  if (dc === "battery") return "battery";
  if (dc === "wind_speed") return "wind";
  if (dc === "illuminance") return m.outdoor.test(w) ? "outdoor_illuminance" : "illuminance";
  if (dc === "temperature" || (dc === undefined && unit !== undefined && TEMP_UNITS.has(unit))) {
    if (m.outdoor.test(w)) return "outdoor_temperature";
    if (m.room.test(w) && !m.equipment.test(w)) return "room_temperature";
    return "temperature";
  }
  if (dc === "humidity" || (dc === undefined && unit === "%" && /\bhumidity/.test(w))) {
    if (m.outdoor.test(w)) return "outdoor_humidity";
    if (m.room.test(w) && !m.equipment.test(w)) return "room_humidity";
    return "humidity";
  }
  if (unit !== undefined && /^(l|L|m³|gal)(\/(h|min))?$/.test(unit) && /\bwater/.test(w)) return "water";
  if (/\b(water|leak)/.test(w) && unit === undefined) return /\bleak/.test(w) ? "leak" : "water";
  if (/\b(tariff|electricity|grid)/.test(w)) return "electrical";
  return undefined;
}

function powerRole(f: EntityFacts, w: string, hints: EnergyHints, m: Matchers): Role {
  if (f.deviceId !== undefined && hints.solarDevices?.has(f.deviceId)) return "solar";
  if (f.deviceId !== undefined && hints.gridDevices?.has(f.deviceId)) return m.export.test(w) ? "grid_export" : "grid_import";
  if (m.solar.test(w)) return "solar";
  if (m.grid.test(w)) return m.export.test(w) ? "grid_export" : "grid_import";
  return "power";
}

/** Roles that place a whole device: its loose readings join the anchor's section. */
const ANCHORS: Partial<Record<Role, BuiltinSection>> = {
  thermostat: "climate",
  ventilation: "climate",
  heating: "climate",
  light: "lights",
  garage_door: "security",
  lock: "security",
  alarm: "security",
  valve: "safety",
  leak: "safety",
  weather: "outdoor",
};

/** Roles that follow their device's anchor instead of their own default section. */
const FOLLOWERS = new Set<Role | undefined>([undefined, "temperature", "humidity", "switch", "electrical", "illuminance"]);

// ---- the layout ----------------------------------------------------------------

export interface LayoutEntity {
  id: string;
  name: string;
  domain: string;
  role?: Role;
  section: string;
  group: string;
  /** The entity's area, else its device's, else its configured group (tiles.json). */
  area?: string;
  /** Where `area` comes from. */
  areaSource?: AreaSource;
  device?: string;
  deviceId?: string;
}

export type AreaSource = "entity" | "device" | "group";

/**
 * What made a group: a configured group (tiles.json), an area, a device with several
 * entities in the section, the entities' kind (for things no area holds: people,
 * weather, the grid, helpers), or nothing: the section's "No area" group.
 */
export type GroupBy = "group" | "area" | "device" | "kind" | "none";

export interface LayoutGroup {
  title: string;
  by: GroupBy;
  entities: string[];
}

export interface LayoutSection {
  id: string;
  title: string;
  collapsed: boolean;
  /** Ordered groups, each with ordered entity ids. */
  groups: LayoutGroup[];
}

/** The title of a section's group of entities without an area. */
export const NO_AREA = "No area";

export interface Layout {
  sections: LayoutSection[];
  entities: Record<string, LayoutEntity>;
  /** Pinned entity ids (groups.pin), in config order, present ones only. */
  pinned: string[];
}

export interface LayoutOptions {
  groups?: GroupsConfig;
  hints?: EnergyHints;
  /** Legacy tiles.json tiles: a power tile labelled "Grid import" / "Grid export" / "Solar" sets that role. */
  tiles?: Array<{ entityId: string; label: string; kind: string }>;
}

const DOMAIN_LABELS: Record<string, string> = {
  sensor: "Sensors",
  binary_sensor: "Binary sensors",
  media_player: "Media",
  event: "Buttons & events",
  button: "Buttons",
  number: "Numbers",
  select: "Selects",
  input_number: "Helpers",
  input_select: "Helpers",
  input_text: "Helpers",
  input_datetime: "Helpers",
  automation: "Automations",
  script: "Scripts",
  scene: "Scenes",
  update: "Updates",
  camera: "Cameras",
  vacuum: "Vacuums",
  remote: "Remotes",
};

/** Roles no area holds: they keep their kind's group when they have no area. */
const HOUSE_WIDE = new Set<Role>(["person", "tracker", "weather", "sun", "outdoor_temperature", "outdoor_humidity", "outdoor_illuminance", "wind", "grid_import", "grid_export", "solar", "carbon_intensity", "price"]);
/** Domains of HA's own helpers and logic: no area holds them either. */
const HOUSE_WIDE_DOMAINS = new Set(["automation", "script", "scene", "input_number", "input_select", "input_text", "input_datetime", "input_button", "timer", "counter", "schedule", "zone"]);

/** What an entity is, as a group title: "Doors", "Lights", "Sensors", ... */
export function kindLabel(e: { role?: Role; domain: string }): string {
  return e.role !== undefined ? ROLES[e.role].group : (DOMAIN_LABELS[e.domain] ?? capitalize(e.domain.replace(/_/g, " ")));
}

function tileRole(t: { label: string; kind: string }): Role | undefined {
  if (t.kind !== "power") return undefined;
  const l = t.label.toLowerCase();
  if (/solar|\bpv\b/.test(l)) return "solar";
  if (/export|return|feed/.test(l)) return "grid_export";
  if (/import|grid|consum/.test(l)) return "grid_import";
  return undefined;
}

const friendly = (f: EntityFacts): string => {
  const n = f.attributes["friendly_name"];
  return typeof n === "string" && n.trim() !== "" ? n : f.id.slice(f.id.indexOf(".") + 1).replace(/_/g, " ");
};

/**
 * Sections, groups and roles for these entities. Order: sections as configured (else
 * SECTIONS order); in each section the configured groups and areas first (by name),
 * then devices with several entities in the section, then kind groups of what no area
 * holds (people, weather, the grid, helpers), then one "No area" group; entities by
 * name ("No area" by kind, then name). An entity's area is its own, else its device's,
 * else its configured group's title. Hidden entities and sections are left out; an
 * empty section is left out.
 */
export function buildLayout(facts: EntityFacts[], opts: LayoutOptions = {}): Layout {
  const groups = opts.groups ?? {};
  const hints = opts.hints ?? {};
  const m = groups.keywords === undefined ? DEFAULT_MATCHERS : matchers(groups.keywords);
  const tileRoles = new Map<string, Role>();
  for (const t of opts.tiles ?? []) {
    const r = tileRole(t);
    if (r !== undefined) tileRoles.set(t.entityId, r);
  }

  // 1. Role per entity; anchors per device.
  const roles = new Map<string, Role | undefined>();
  const anchorOf = new Map<string, BuiltinSection>();
  let visible = facts.filter((f) => overrideFor(groups, f.id)?.hidden !== true);
  for (const f of visible) roles.set(f.id, overrideFor(groups, f.id)?.role ?? tileRoles.get(f.id) ?? baseRole(f, hints, m));
  // Integrations without devices: an anchor whose name prefixes other entities' names
  // ("Heat pump" → "Heat pump Flow temperature") stands in for their device.
  const named = visible
    .filter((f) => f.deviceId === undefined && ANCHORS[roles.get(f.id) as Role] !== undefined && friendly(f).length >= 3)
    .map((f) => friendly(f))
    .sort((a, b) => b.length - a.length);
  if (named.length > 0) {
    visible = visible.map((f) => {
      if (f.deviceId !== undefined) return f;
      const n = friendly(f);
      const owner = named.find((a) => n === a || n.startsWith(`${a} `));
      return owner === undefined ? f : { ...f, device: owner, deviceId: `name:${owner}` };
    });
  }
  for (const f of visible) {
    const role = roles.get(f.id);
    const anchor = role === undefined ? undefined : ANCHORS[role];
    if (anchor !== undefined && f.deviceId !== undefined && !anchorOf.has(f.deviceId)) anchorOf.set(f.deviceId, anchor);
  }
  // A temperature on a device with a single (non-outdoor) temperature reading is the room's.
  const tempsPerDevice = new Map<string, number>();
  for (const f of visible) {
    const r = roles.get(f.id);
    if ((r === "temperature" || r === "room_temperature") && f.deviceId !== undefined) tempsPerDevice.set(f.deviceId, (tempsPerDevice.get(f.deviceId) ?? 0) + 1);
  }

  // 2. Section + group per entity.
  const entities: Record<string, LayoutEntity> = {};
  for (const f of visible) {
    const o = overrideFor(groups, f.id);
    let role = roles.get(f.id);
    if ((role === "temperature" || role === "humidity") && o?.role === undefined && !m.equipment.test(words(f))) {
      const single = f.deviceId === undefined ? true : (tempsPerDevice.get(f.deviceId) ?? 0) <= 1;
      const anchored = f.deviceId !== undefined && anchorOf.get(f.deviceId) !== undefined && anchorOf.get(f.deviceId) !== "climate";
      if (single && !anchored) role = role === "temperature" ? "room_temperature" : "room_humidity";
    }
    const domain = f.id.slice(0, f.id.indexOf("."));
    const anchor = f.deviceId === undefined ? undefined : anchorOf.get(f.deviceId);
    const section = o?.section ?? (FOLLOWERS.has(role) && anchor !== undefined ? anchor : role !== undefined ? ROLES[role].section : "other");
    const area: [string, AreaSource] | undefined =
      f.area !== undefined ? [f.area, f.areaFrom ?? "entity"] : o?.group !== undefined && o.group !== "" ? [o.group, "group"] : undefined;
    entities[f.id] = {
      id: f.id,
      name: o?.name ?? friendly(f),
      domain,
      ...(role !== undefined ? { role } : {}),
      section,
      group: o?.group ?? "",
      ...(area !== undefined ? { area: area[0], areaSource: area[1] } : {}),
      ...(f.device !== undefined ? { device: f.device } : {}),
      ...(f.deviceId !== undefined ? { deviceId: f.deviceId } : {}),
    };
  }

  // 3. Groups: configured > area > device with ≥2 entities in the section > kind (what
  // no area holds) > "No area".
  const perDevice = new Map<string, number>();
  for (const e of Object.values(entities)) {
    if (e.deviceId !== undefined) perDevice.set(`${e.section}|${e.deviceId}`, (perDevice.get(`${e.section}|${e.deviceId}`) ?? 0) + 1);
  }
  const RANK: Record<GroupBy, number> = { group: 0, area: 1, device: 2, kind: 3, none: 4 };
  const byOf = new Map<string, GroupBy>(); // "section|group" → what made it (the strongest reason wins)
  for (const e of Object.values(entities)) {
    let by: GroupBy = "group";
    if (e.group === "") {
      if (e.area !== undefined) [e.group, by] = [e.area, "area"];
      else if (e.device !== undefined && e.deviceId !== undefined && (perDevice.get(`${e.section}|${e.deviceId}`) ?? 0) >= 2) [e.group, by] = [e.device, "device"];
      else if ((e.role !== undefined && HOUSE_WIDE.has(e.role)) || HOUSE_WIDE_DOMAINS.has(e.domain))
        [e.group, by] = [e.role !== undefined && e.section === ROLES[e.role].section ? ROLES[e.role].group : kindLabel({ domain: e.domain }), "kind"];
      else [e.group, by] = [NO_AREA, "none"];
    }
    const key = `${e.section}|${e.group}`;
    const had = byOf.get(key);
    if (had === undefined || RANK[by] < RANK[had]) byOf.set(key, by);
  }
  const rankOf = (section: string, title: string): number => RANK[byOf.get(`${section}|${title}`) ?? "kind"];
  const inKindOrder = (a: LayoutEntity, b: LayoutEntity): number => kindLabel(a).localeCompare(kindLabel(b)) || a.name.localeCompare(b.name);

  // 4. Sections in order.
  const declared = groups.sections ?? {};
  const order = [...(groups.order ?? [])];
  for (const s of [...SECTIONS.map((s) => s.id), ...Object.keys(declared)]) if (!order.includes(s)) order.push(s);
  const sections: LayoutSection[] = [];
  for (const id of order) {
    const conf = declared[id];
    if (conf?.hidden === true) continue;
    const members = Object.values(entities).filter((e) => e.section === id);
    if (members.length === 0) continue;
    const byGroup = new Map<string, LayoutEntity[]>();
    for (const e of members) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);
    const titles = [...byGroup.keys()].sort((a, b) => rankOf(id, a) - rankOf(id, b) || a.localeCompare(b));
    sections.push({
      id,
      title: conf?.title ?? SECTIONS.find((s) => s.id === id)?.title ?? capitalize(id),
      collapsed: conf?.collapsed ?? false,
      groups: titles.map((title) => {
        const by = byOf.get(`${id}|${title}`) ?? "kind";
        return {
          title,
          by,
          entities: byGroup
            .get(title)!
            .sort(by === "none" ? inKindOrder : (a, b) => a.name.localeCompare(b.name))
            .map((e) => e.id),
        };
      }),
    });
  }
  // Entities of a hidden section stay out of the map, so no summary counts them.
  const shown = new Set(sections.flatMap((s) => s.groups.flatMap((g) => g.entities)));
  for (const id of Object.keys(entities)) if (!shown.has(id)) delete entities[id];
  return { sections, entities, pinned: (groups.pin ?? []).filter((id) => id in entities) };
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
