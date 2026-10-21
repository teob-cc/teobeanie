// summary.ts — the numbers on top of each House section, from the section's entities
// and their live states: grid and solar flow, what is open, which lights are on, room
// temperatures against setpoints, the outdoor conditions, who is home, what alarms.
// Pure; the panel recomputes them on every state frame.

import { NO_AREA, type Role } from "./layout.js";
import type { HouseEntity } from "./view.js";

export { NO_AREA };

export const UNAVAILABLE = new Set(["unavailable", "unknown", ""]);

export const isAvailable = (e: { state: string }): boolean => !UNAVAILABLE.has(e.state);

/** The state as a number, or null. */
export function num(e: { state: string } | undefined): number | null {
  if (e === undefined || UNAVAILABLE.has(e.state)) return null;
  const n = Number(e.state);
  return Number.isFinite(n) ? n : null;
}

const numAttr = (e: HouseEntity, key: string): number | null => {
  const v = e.attributes[key];
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
};

const unitOf = (e: HouseEntity): string | undefined => {
  const u = e.attributes["unit_of_measurement"];
  return typeof u === "string" ? u : undefined;
};

/** Power in W, whatever the sensor's unit. */
export function watts(e: HouseEntity | undefined): number | null {
  const v = num(e);
  if (v === null || e === undefined) return null;
  const u = unitOf(e);
  return u === "kW" ? v * 1000 : u === "MW" ? v * 1e6 : v;
}

/** "on" in the sense of the entity's domain: open, unlocked, home, detected, playing... */
export function isActive(e: HouseEntity): boolean {
  switch (e.domain) {
    case "person":
    case "device_tracker":
      return e.state === "home";
    case "lock":
      return e.state === "unlocked" || e.state === "open" || e.state === "opening" || e.state === "jammed";
    case "cover":
    case "valve":
      return e.state === "open" || e.state === "opening" || e.state === "closing";
    case "climate":
      return e.state !== "off" && isAvailable(e);
    case "alarm_control_panel":
      return e.state.startsWith("armed") || e.state === "triggered" || e.state === "pending";
    case "media_player":
      return e.state === "playing" || e.state === "on" || e.state === "paused";
    default:
      return e.state === "on" || e.state === "open" || e.state === "home" || e.state === "detected";
  }
}

const has = (e: HouseEntity, ...roles: Role[]): boolean => e.role !== undefined && roles.includes(e.role);

// ---- energy --------------------------------------------------------------------

export interface EnergySummary {
  /** W; null when the house has no such sensor or it is unavailable. Sums when several. */
  gridImport: number | null;
  gridExport: number | null;
  solar: number | null;
  /** Import − export, W: positive draws from the grid. */
  net: number | null;
  /** What the house uses: import + solar − export; null while exporting with no solar reading. */
  home: number | null;
  consumers: Array<{ id: string; name: string; watts: number }>;
  carbon: { value: number; unit: string } | null;
}

function sumWatts(es: HouseEntity[]): number | null {
  const vals = es.map(watts).filter((v): v is number => v !== null);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

export function energySummary(es: HouseEntity[]): EnergySummary {
  const of = (r: Role): HouseEntity[] => es.filter((e) => e.role === r);
  const imp = of("grid_import");
  const exp = of("grid_export");
  const gridImport = sumWatts(imp);
  const gridExport = sumWatts(exp);
  const solar = sumWatts(of("solar"));
  // A single signed grid sensor (no export sensor) reads negative when exporting.
  const net = gridImport === null && gridExport === null ? null : (gridImport ?? 0) - (gridExport ?? 0);
  // Exporting without a solar reading: the house's own use is unknown, not zero.
  const home = net === null ? null : solar === null ? (net >= 0 ? net : null) : Math.max(0, net + solar);
  const consumers = of("power")
    .map((e) => ({ id: e.id, name: e.name, watts: watts(e) }))
    .filter((c): c is { id: string; name: string; watts: number } => c.watts !== null && c.watts > 0)
    .sort((a, b) => b.watts - a.watts);
  const ci = of("carbon_intensity").find((e) => num(e) !== null);
  return { gridImport, gridExport, solar, net, home, consumers, carbon: ci ? { value: num(ci)!, unit: unitOf(ci) ?? "" } : null };
}

// ---- doors, windows, locks, covers ---------------------------------------------

export interface OpeningsSummary {
  open: HouseEntity[];
  closed: number;
  unavailable: number;
  locks: { locked: number; unlocked: HouseEntity[] };
  covers: HouseEntity[];
  alarms: HouseEntity[];
}

export function openingsSummary(es: HouseEntity[]): OpeningsSummary {
  const openings = es.filter((e) => has(e, "door", "window", "garage_door"));
  const locks = es.filter((e) => has(e, "lock") && isAvailable(e));
  return {
    open: openings.filter((e) => isAvailable(e) && isActive(e)).sort((a, b) => a.changedAt - b.changedAt),
    closed: openings.filter((e) => isAvailable(e) && !isActive(e)).length,
    unavailable: openings.filter((e) => !isAvailable(e)).length,
    locks: { locked: locks.filter((e) => !isActive(e)).length, unlocked: locks.filter(isActive) },
    covers: es.filter((e) => has(e, "cover")),
    alarms: es.filter((e) => has(e, "alarm")),
  };
}

// ---- lights --------------------------------------------------------------------

export interface LightsSummary {
  lights: { on: number; total: number };
  switches: { on: number; total: number };
  /** Per area (the entity's, its device's or its configured group's; else "No area"), lights and switches together. */
  byArea: Array<{ area: string; on: number; total: number }>;
  on: HouseEntity[];
  /** Light level sensors: lx. */
  lux: Array<{ id: string; name: string; lux: number }>;
}

export function lightsSummary(es: HouseEntity[]): LightsSummary {
  const lights = es.filter((e) => has(e, "light"));
  const switches = es.filter((e) => has(e, "switch"));
  const both = [...lights, ...switches];
  const areas = new Map<string, { on: number; total: number }>();
  for (const e of both) {
    const a = areas.get(e.area ?? NO_AREA) ?? { on: 0, total: 0 };
    a.total++;
    if (isActive(e)) a.on++;
    areas.set(e.area ?? NO_AREA, a);
  }
  return {
    lights: { on: lights.filter(isActive).length, total: lights.length },
    switches: { on: switches.filter(isActive).length, total: switches.length },
    byArea: [...areas].map(([area, c]) => ({ area, ...c })).sort((a, b) => (a.area === NO_AREA ? 1 : b.area === NO_AREA ? -1 : a.area.localeCompare(b.area))),
    on: both.filter(isActive).sort((a, b) => b.changedAt - a.changedAt),
    lux: es
      .filter((e) => has(e, "illuminance"))
      .map((e) => ({ id: e.id, name: e.name, lux: num(e) }))
      .filter((l): l is { id: string; name: string; lux: number } => l.lux !== null),
  };
}

/** Brightness 0–100 % of a light that is on, if it reports one. */
export function brightnessPct(e: HouseEntity): number | null {
  const b = numAttr(e, "brightness");
  return b === null ? null : Math.round((b / 255) * 100);
}

// ---- climate -------------------------------------------------------------------

export interface ThermostatRow {
  id: string;
  name: string;
  mode: string;
  /** hvac_action: heating, cooling, idle, off... */
  action: string | null;
  current: number | null;
  target: number | null;
  /** Target range (heat_cool). */
  targetLow: number | null;
  targetHigh: number | null;
  unit: string;
  area?: string;
}

export interface RoomRow {
  id: string;
  name: string;
  temperature: number;
  humidity: number | null;
  unit: string;
}

export interface ClimateSummary {
  thermostats: ThermostatRow[];
  rooms: RoomRow[];
  co2: Array<{ id: string; name: string; ppm: number }>;
  ventilation: Array<{ id: string; name: string; on: boolean; percentage: number | null; preset: string | null }>;
  heating: Array<{ id: string; name: string; on: boolean; changedAt: number }>;
  /** Over rooms and thermostats' current temperature. */
  range: { min: number; max: number; mean: number } | null;
}

export function climateSummary(es: HouseEntity[]): ClimateSummary {
  const thermostats: ThermostatRow[] = es
    .filter((e) => has(e, "thermostat") && isAvailable(e))
    .map((e) => ({
      id: e.id,
      name: e.name,
      mode: e.state,
      action: typeof e.attributes["hvac_action"] === "string" ? e.attributes["hvac_action"] : null,
      current: numAttr(e, "current_temperature"),
      target: numAttr(e, "temperature"),
      targetLow: numAttr(e, "target_temp_low"),
      targetHigh: numAttr(e, "target_temp_high"),
      unit: typeof e.attributes["temperature_unit"] === "string" ? e.attributes["temperature_unit"] : "°C",
      ...(e.area !== undefined ? { area: e.area } : {}),
    }));
  // A room sensor on a thermostat's device repeats the thermostat's reading.
  const thermostatDevices = new Set(es.filter((e) => has(e, "thermostat") && e.deviceId !== undefined).map((e) => e.deviceId));
  const humidities = es.filter((e) => has(e, "room_humidity") && num(e) !== null);
  const rooms: RoomRow[] = es
    .filter((e) => has(e, "room_temperature") && num(e) !== null && !(e.deviceId !== undefined && thermostatDevices.has(e.deviceId)))
    .map((e) => {
      // Humidity of the same device, else of the same area when the area has one humidity sensor.
      const sameDevice = humidities.find((h) => h.deviceId !== undefined && h.deviceId === e.deviceId);
      const inArea = e.area === undefined ? [] : humidities.filter((h) => h.area === e.area);
      const h = sameDevice ?? (inArea.length === 1 ? inArea[0] : undefined);
      return { id: e.id, name: e.name, temperature: num(e)!, humidity: h === undefined ? null : num(h), unit: unitOf(e) ?? "°C" };
    });
  const temps = [...rooms.map((r) => r.temperature), ...thermostats.map((t) => t.current).filter((t): t is number => t !== null)];
  return {
    thermostats,
    rooms,
    co2: es
      .filter((e) => has(e, "co2"))
      .map((e) => ({ id: e.id, name: e.name, ppm: num(e) }))
      .filter((c): c is { id: string; name: string; ppm: number } => c.ppm !== null),
    ventilation: es
      .filter((e) => has(e, "ventilation") && isAvailable(e))
      .map((e) => ({ id: e.id, name: e.name, on: isActive(e), percentage: numAttr(e, "percentage"), preset: typeof e.attributes["preset_mode"] === "string" ? e.attributes["preset_mode"] : null })),
    heating: es.filter((e) => has(e, "heating") && isAvailable(e)).map((e) => ({ id: e.id, name: e.name, on: isActive(e), changedAt: e.changedAt })),
    range: temps.length === 0 ? null : { min: Math.min(...temps), max: Math.max(...temps), mean: temps.reduce((a, b) => a + b, 0) / temps.length },
  };
}

/** CO₂ band: ≤ 800 ppm good, ≤ 1200 fair, above poor. */
export const co2Band = (ppm: number): "good" | "fair" | "poor" => (ppm <= 800 ? "good" : ppm <= 1200 ? "fair" : "poor");

// ---- outdoor -------------------------------------------------------------------

export interface OutdoorSummary {
  condition: string | null;
  temperature: { value: number; unit: string; source: string } | null;
  humidity: { value: number; source: string } | null;
  wind: { speed: number; unit: string; bearing: number | null; gust: number | null } | null;
  pressure: { value: number; unit: string } | null;
  sun: { above: boolean; elevation: number | null; azimuth: number | null; nextRising: number | null; nextSetting: number | null } | null;
}

export interface OutdoorSources {
  weather?: string;
  temperature?: string;
  humidity?: string;
  wind?: string;
}

const time = (v: unknown): number | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

/** Configured sources first (allowlist.json "outdoor"), then any outdoor sensor, then the weather entity. */
export function outdoorSummary(es: HouseEntity[], sources: OutdoorSources = {}): OutdoorSummary {
  const byId = (id: string | undefined): HouseEntity | undefined => (id === undefined ? undefined : es.find((e) => e.id === id));
  const weather = byId(sources.weather) ?? es.find((e) => has(e, "weather") && isAvailable(e));
  const pick = (configured: string | undefined, role: Role): HouseEntity | undefined => {
    const c = byId(configured);
    return c !== undefined && num(c) !== null ? c : es.find((e) => has(e, role) && num(e) !== null);
  };
  const t = pick(sources.temperature, "outdoor_temperature");
  const h = pick(sources.humidity, "outdoor_humidity");
  const w = pick(sources.wind, "wind");
  const wa = (k: string): number | null => (weather === undefined ? null : numAttr(weather, k));
  const wUnit = (k: string, fallback: string): string => {
    const u = weather?.attributes[k];
    return typeof u === "string" ? u : fallback;
  };
  const sun = es.find((e) => has(e, "sun"));
  const temperature =
    t !== undefined ? { value: num(t)!, unit: unitOf(t) ?? "°C", source: t.name } : wa("temperature") !== null ? { value: wa("temperature")!, unit: wUnit("temperature_unit", "°C"), source: weather!.name } : null;
  const humidity = h !== undefined ? { value: num(h)!, source: h.name } : wa("humidity") !== null ? { value: wa("humidity")!, source: weather!.name } : null;
  const speed = w !== undefined ? num(w) : wa("wind_speed");
  return {
    condition: weather !== undefined && isAvailable(weather) ? weather.state : null,
    temperature,
    humidity,
    wind: speed === null ? null : { speed, unit: w !== undefined ? (unitOf(w) ?? "km/h") : wUnit("wind_speed_unit", "km/h"), bearing: wa("wind_bearing"), gust: wa("wind_gust_speed") },
    pressure: wa("pressure") === null ? null : { value: wa("pressure")!, unit: wUnit("pressure_unit", "hPa") },
    sun:
      sun === undefined
        ? null
        : {
            above: sun.state === "above_horizon",
            elevation: numAttr(sun, "elevation"),
            azimuth: numAttr(sun, "azimuth"),
            nextRising: time(sun.attributes["next_rising"]),
            nextSetting: time(sun.attributes["next_setting"]),
          },
  };
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Where the wind comes from, as a compass point. */
export const compassPoint = (bearing: number): string => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;

// ---- presence ------------------------------------------------------------------

export interface PresenceSummary {
  people: Array<{ id: string; name: string; home: boolean; state: string; changedAt: number }>;
  occupied: HouseEntity[];
  sensors: number;
}

export function presenceSummary(es: HouseEntity[]): PresenceSummary {
  const sensors = es.filter((e) => has(e, "occupancy"));
  return {
    people: es.filter((e) => has(e, "person", "tracker")).map((e) => ({ id: e.id, name: e.name, home: isActive(e), state: e.state, changedAt: e.changedAt })),
    occupied: sensors.filter((e) => isActive(e)).sort((a, b) => b.changedAt - a.changedAt),
    sensors: sensors.length,
  };
}

// ---- safety & water ------------------------------------------------------------

export interface SafetySummary {
  /** Leak, smoke, gas, CO and problem sensors that are on. */
  alerts: HouseEntity[];
  /** Sensors watching, per kind; "unavailable" counts the ones not reporting. */
  watching: Array<{ kind: "leak" | "smoke" | "problem"; ok: number; total: number }>;
  unavailable: HouseEntity[];
  valves: HouseEntity[];
  water: Array<{ id: string; name: string; value: number; unit: string }>;
}

const ALARM_ROLES: Role[] = ["leak", "smoke", "gas_alarm", "co_alarm", "problem"];

export function safetySummary(es: HouseEntity[]): SafetySummary {
  const sensors = es.filter((e) => has(e, ...ALARM_ROLES));
  const kind = (e: HouseEntity): "leak" | "smoke" | "problem" => (e.role === "leak" ? "leak" : e.role === "problem" ? "problem" : "smoke");
  const watching = (["leak", "smoke", "problem"] as const)
    .map((k) => {
      const of = sensors.filter((e) => kind(e) === k);
      return { kind: k, ok: of.filter((e) => isAvailable(e) && !isActive(e)).length, total: of.length };
    })
    .filter((w) => w.total > 0);
  return {
    alerts: sensors.filter((e) => isAvailable(e) && isActive(e)),
    watching,
    unavailable: sensors.filter((e) => !isAvailable(e)),
    valves: es.filter((e) => has(e, "valve")),
    water: es
      .filter((e) => has(e, "water"))
      .map((e) => ({ id: e.id, name: e.name, value: num(e), unit: unitOf(e) ?? "" }))
      .filter((w): w is { id: string; name: string; value: number; unit: string } => w.value !== null),
  };
}

// ---- the whole house -----------------------------------------------------------

export interface Attention {
  alerts: HouseEntity[];
  open: HouseEntity[];
  unavailable: HouseEntity[];
  lowBatteries: HouseEntity[];
}

/** What needs a look, across every section: alarms on, things open, sensors not reporting, batteries below 20 %. */
export function attention(es: HouseEntity[]): Attention {
  return {
    alerts: es.filter((e) => has(e, ...ALARM_ROLES) && isAvailable(e) && isActive(e)),
    open: es.filter((e) => has(e, "door", "window", "garage_door") && isAvailable(e) && isActive(e)),
    unavailable: es.filter((e) => !isAvailable(e)),
    lowBatteries: es.filter((e) => has(e, "battery") && ((e.domain === "binary_sensor" && e.state === "on") || ((num(e) ?? 100) < 20 && e.domain === "sensor"))),
  };
}
