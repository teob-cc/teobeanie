import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HaEntityState, HaStateChangedEvent } from "@lambda-house/teob-ts/ha";
import { baseRole, buildLayout, DEFAULT_KEYWORDS, matchers, overrideFor, parseGroups, type EntityFacts } from "../src/house/layout.js";
import { attention, climateSummary, energySummary, lightsSummary, openingsSummary, outdoorSummary, safetySummary } from "../src/house/summary.js";
import { createHouseService } from "../src/house/service.js";
import type { HouseEntity, HouseFrame } from "../src/house/view.js";
import { loadHouseConfig } from "../src/tiles.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const noLog = (): void => {};

/** A made-up entity: id, state, attributes (device_class, unit_of_measurement, friendly_name, ...). */
function fact(id: string, state: string, attributes: Record<string, unknown> = {}, extra: Partial<EntityFacts> = {}): EntityFacts {
  return { id, state, attributes, ...extra };
}

/** A HouseEntity as the panel holds it, for the summaries. */
function ent(f: EntityFacts, changedAt = 0): HouseEntity {
  const layout = buildLayout([f]);
  const e = layout.entities[f.id] ?? { id: f.id, name: f.id, domain: f.id.split(".")[0]!, section: "other", group: "" };
  return { ...e, state: f.state, attributes: f.attributes, changedAt, updatedAt: changedAt };
}

describe("baseRole", () => {
  it("reads roles from domain and device_class", () => {
    expect(baseRole(fact("binary_sensor.den_door", "off", { device_class: "door" }))).toBe("door");
    expect(baseRole(fact("binary_sensor.carport_garage_door", "off", { device_class: "door" }))).toBe("door");
    expect(baseRole(fact("binary_sensor.carport_garage_door", "off", { device_class: "door" }), {}, matchers({ garage: ["garage"] }))).toBe("garage_door");
    expect(baseRole(fact("binary_sensor.attic_window", "off", { device_class: "window" }))).toBe("window");
    expect(baseRole(fact("binary_sensor.bath_leak", "off", { device_class: "moisture" }))).toBe("leak");
    expect(baseRole(fact("binary_sensor.hall_motion", "off", { device_class: "motion" }))).toBe("occupancy");
    expect(baseRole(fact("binary_sensor.pump_fault", "off", { device_class: "problem" }))).toBe("problem");
    expect(baseRole(fact("cover.garage", "closed", { device_class: "garage" }))).toBe("garage_door");
    expect(baseRole(fact("cover.den_blinds", "open", { device_class: "blind" }))).toBe("cover");
    expect(baseRole(fact("light.den_ceiling", "on"))).toBe("light");
    expect(baseRole(fact("person.alex", "home"))).toBe("person");
    expect(baseRole(fact("climate.den", "heat"))).toBe("thermostat");
    expect(baseRole(fact("fan.ventilation", "on"))).toBe("ventilation");
    expect(baseRole(fact("media_player.den_tv", "off"))).toBeUndefined();
  });

  it("names a switch by what it switches", () => {
    expect(baseRole(fact("switch.main_water_valve", "on"))).toBe("valve");
    expect(baseRole(fact("switch.underfloor_heating_pump", "off"))).toBe("heating");
    expect(baseRole(fact("switch.porch_light", "off"))).toBe("light");
    expect(baseRole(fact("switch.coffee_machine", "off"))).toBe("switch");
  });

  it("splits power into grid import, export, solar and consumers", () => {
    const kw = { device_class: "power", unit_of_measurement: "kW" };
    expect(baseRole(fact("sensor.grid_power_import", "0.4", kw))).toBe("grid_import");
    expect(baseRole(fact("sensor.meter_power_returned", "0.4", kw))).toBe("grid_export");
    expect(baseRole(fact("sensor.solar_power", "800", { device_class: "power", unit_of_measurement: "W" }))).toBe("solar");
    expect(baseRole(fact("sensor.dishwasher_power", "12", { device_class: "power", unit_of_measurement: "W" }))).toBe("power");
  });

  it("uses the energy dashboard's devices before names", () => {
    const hints = { gridDevices: new Set(["meter1"]), solarDevices: new Set(["inv1"]) };
    const w = { device_class: "power", unit_of_measurement: "W" };
    expect(baseRole(fact("sensor.currently_delivered", "300", w, { deviceId: "meter1" }), hints)).toBe("grid_import");
    expect(baseRole(fact("sensor.currently_returned", "0", w, { deviceId: "meter1" }), hints)).toBe("grid_export");
    expect(baseRole(fact("sensor.ac_output", "900", w, { deviceId: "inv1" }), hints)).toBe("solar");
  });

  it("tells outdoor, room and equipment temperatures apart", () => {
    const t = { device_class: "temperature", unit_of_measurement: "°C" };
    expect(baseRole(fact("sensor.outdoor_temperature", "12", t))).toBe("outdoor_temperature");
    expect(baseRole(fact("sensor.living_room_temperature", "21", t))).toBe("room_temperature");
    expect(baseRole(fact("sensor.boiler_flow_temperature", "45", t))).toBe("temperature");
    expect(baseRole(fact("sensor.guest_room_humidity", "50", { device_class: "humidity", unit_of_measurement: "%" }))).toBe("room_humidity");
  });

  it("keeps particulates, prices and grid carbon apart", () => {
    expect(baseRole(fact("sensor.den_pm25", "3", { device_class: "pm25", unit_of_measurement: "μg/m³" }))).toBe("air_quality");
    expect(baseRole(fact("sensor.den_pm10", "3", { unit_of_measurement: "μg/m³", friendly_name: "Den PM10" }))).toBeUndefined();
    expect(baseRole(fact("sensor.energy_price", "0.25", { unit_of_measurement: "€/kWh" }))).toBe("price");
    expect(baseRole(fact("sensor.grid_carbon", "250", { unit_of_measurement: "gCO2eq/kWh" }))).toBe("carbon_intensity");
    expect(baseRole(fact("sensor.indoor_co2", "650", { device_class: "carbon_dioxide", unit_of_measurement: "ppm" }))).toBe("co2");
  });
});

describe("buildLayout", () => {
  const facts: EntityFacts[] = [
    fact("light.den_ceiling", "on", { friendly_name: "Den ceiling" }, { area: "Den" }),
    fact("light.hall", "off", { friendly_name: "Hall" }),
    fact("binary_sensor.front_door", "off", { device_class: "door", friendly_name: "Front door" }),
    fact("fan.ventilation", "on", { friendly_name: "Ventilation" }, { device: "Heat recovery unit", deviceId: "hru" }),
    fact("sensor.ventilation_supply_airflow", "130", { unit_of_measurement: "m³/h", friendly_name: "Ventilation Supply airflow" }, { device: "Heat recovery unit", deviceId: "hru" }),
    fact("sensor.ventilation_exhaust_temperature", "15", { device_class: "temperature", unit_of_measurement: "°C", friendly_name: "Ventilation Exhaust temperature" }, { device: "Heat recovery unit", deviceId: "hru" }),
    fact("sensor.den_climate_temperature", "20.5", { device_class: "temperature", unit_of_measurement: "°C", friendly_name: "Den sensor Temperature" }, { device: "Den sensor", deviceId: "dsens" }),
    fact("media_player.den_tv", "off", { friendly_name: "Den TV" }),
    fact("sensor.noisy_debug_counter", "3", { friendly_name: "Noisy debug" }),
  ];

  it("puts every entity in one section, sections in the default order", () => {
    const l = buildLayout(facts);
    expect(l.sections.map((s) => s.id)).toEqual(["security", "lights", "climate", "other"]);
    const all = l.sections.flatMap((s) => s.groups.flatMap((g) => g.entities));
    expect(all.sort()).toEqual(facts.map((f) => f.id).sort());
  });

  it("groups by area first, then by device, then the rest in one No area group", () => {
    const l = buildLayout(facts);
    const lights = l.sections.find((s) => s.id === "lights")!;
    expect(lights.groups).toEqual([
      { title: "Den", by: "area", entities: ["light.den_ceiling"] },
      { title: "No area", by: "none", entities: ["light.hall"] },
    ]);
    const climate = l.sections.find((s) => s.id === "climate")!;
    expect(climate.groups.map((g) => [g.title, g.by])).toEqual([
      ["Heat recovery unit", "device"],
      ["No area", "none"],
    ]);
  });

  it("lets a device's loose readings follow its anchor (the fan) into climate", () => {
    const l = buildLayout(facts);
    expect(l.entities["sensor.ventilation_supply_airflow"]?.section).toBe("climate");
    expect(l.entities["sensor.ventilation_exhaust_temperature"]?.role).toBe("temperature");
    // a single temperature on its own device is the room's
    expect(l.entities["sensor.den_climate_temperature"]?.role).toBe("room_temperature");
  });

  it("treats an anchor's name as the device of entities without one", () => {
    const l = buildLayout([
      fact("fan.heat_pump", "on", { friendly_name: "Heat pump" }),
      fact("sensor.heat_pump_flow_rate", "12", { unit_of_measurement: "l/min", friendly_name: "Heat pump Flow rate" }),
      fact("sensor.heat_pump_flow_temperature", "35", { device_class: "temperature", unit_of_measurement: "°C", friendly_name: "Heat pump Flow temperature" }),
    ]);
    expect(l.sections).toHaveLength(1);
    expect(l.sections[0]!.groups).toEqual([{ title: "Heat pump", by: "device", entities: ["fan.heat_pump", "sensor.heat_pump_flow_rate", "sensor.heat_pump_flow_temperature"] }]);
  });

  it("applies overrides: rename, move, hide by pattern, reorder, hide sections, pin", () => {
    const groups = parseGroups({
      order: ["climate", "garden"],
      sections: { garden: { title: "Garden" }, security: { title: "Doors" }, other: { hidden: true }, lights: { collapsed: true } },
      entities: {
        "light.hall": { section: "garden", group: "Paths", name: "Path lights" },
        "sensor.noisy_*": { hidden: true },
        "binary_sensor.front_door": { role: "window" },
      },
      pin: ["light.den_ceiling", "media_player.den_tv"],
    });
    const l = buildLayout(facts, { groups });
    expect(l.sections.map((s) => [s.id, s.title])).toEqual([
      ["climate", "Climate"],
      ["garden", "Garden"],
      ["security", "Doors"],
      ["lights", "Lights & switches"],
    ]);
    expect(l.sections.find((s) => s.id === "lights")?.collapsed).toBe(true);
    expect(l.sections.find((s) => s.id === "garden")?.groups).toEqual([{ title: "Paths", by: "group", entities: ["light.hall"] }]);
    expect(l.entities["light.hall"]?.name).toBe("Path lights");
    expect(l.entities["binary_sensor.front_door"]?.role).toBe("window");
    expect(l.entities["sensor.noisy_debug_counter"]).toBeUndefined();
    // the hidden "other" section takes its entities out of the view (and the pins)
    expect(l.entities["media_player.den_tv"]).toBeUndefined();
    expect(l.pinned).toEqual(["light.den_ceiling"]);
  });

  it("takes the area from the entity, else its device, else its configured group; the rest is No area", () => {
    const groups = parseGroups({ entities: { "light.shed_*": { group: "Shed" }, "light.den_reading": { group: "Reading corner" } } });
    const l = buildLayout(
      [
        fact("light.den_lamp", "on", { friendly_name: "Den lamp" }, { area: "Den", areaFrom: "entity" }),
        fact("light.den_spot", "off", { friendly_name: "Den spot" }, { area: "Den", areaFrom: "device", device: "Spot", deviceId: "spot" }),
        fact("light.den_reading", "off", { friendly_name: "Reading lamp" }, { area: "Den" }),
        fact("light.shed_string", "on", { friendly_name: "Shed string" }),
        fact("light.zeta_loose", "on", { friendly_name: "Zeta loose" }),
        fact("switch.alpha_plug", "off", { friendly_name: "Alpha plug" }),
      ],
      { groups },
    );
    expect(l.sections.find((s) => s.id === "lights")!.groups).toEqual([
      { title: "Reading corner", by: "group", entities: ["light.den_reading"] },
      { title: "Shed", by: "group", entities: ["light.shed_string"] },
      { title: "Den", by: "area", entities: ["light.den_lamp", "light.den_spot"] },
      // by kind first ("Lights" before "Switches & plugs"), then by name
      { title: "No area", by: "none", entities: ["light.zeta_loose", "switch.alpha_plug"] },
    ]);
    const src = (id: string) => [l.entities[id]?.area, l.entities[id]?.areaSource];
    expect(src("light.den_lamp")).toEqual(["Den", "entity"]);
    expect(src("light.den_spot")).toEqual(["Den", "device"]);
    // a configured group does not replace an area Home Assistant knows
    expect(src("light.den_reading")).toEqual(["Den", "entity"]);
    expect(src("light.shed_string")).toEqual(["Shed", "group"]);
    expect(src("light.zeta_loose")).toEqual([undefined, undefined]);
    // the lights summary counts per area the same way
    const es = Object.values(l.entities).map((e) => ({ ...e, state: e.id === "switch.alpha_plug" ? "off" : "on", attributes: {}, changedAt: 0, updatedAt: 0 }));
    expect(lightsSummary(es).byArea).toEqual([
      { area: "Den", on: 3, total: 3 },
      { area: "Shed", on: 1, total: 1 },
      { area: "No area", on: 1, total: 2 },
    ]);
  });

  it("keeps what no area holds (people, weather, the grid, helpers) in kind groups", () => {
    const w = { device_class: "power", unit_of_measurement: "W" };
    const l = buildLayout([
      fact("person.alex", "home", { friendly_name: "Alex" }),
      fact("weather.home", "sunny", { friendly_name: "Home" }),
      fact("sensor.grid_power", "300", { ...w, friendly_name: "Grid power" }),
      fact("sensor.fridge_power", "80", { ...w, friendly_name: "Fridge power" }),
      fact("automation.night_mode", "on", { friendly_name: "Night mode" }),
      fact("media_player.den_speaker", "idle", { friendly_name: "Den speaker" }),
    ]);
    const groupsOf = (id: string) => l.sections.find((s) => s.id === id)!.groups.map((g) => [g.title, g.by]);
    expect(groupsOf("presence")).toEqual([["People", "kind"]]);
    expect(groupsOf("outdoor")).toEqual([["Weather", "kind"]]);
    expect(groupsOf("energy")).toEqual([
      ["Grid", "kind"],
      ["No area", "none"],
    ]);
    expect(groupsOf("other")).toEqual([
      ["Automations", "kind"],
      ["No area", "none"],
    ]);
  });

  it("matches names with generic English words only, plus a house's own keywords", () => {
    const t = { device_class: "temperature", unit_of_measurement: "°C" };
    const w = { device_class: "power", unit_of_measurement: "W" };
    const outside = fact("sensor.aussen_temperature", "8", { ...t, friendly_name: "Außen temperature" });
    const meter = fact("sensor.xm1_power", "300", { ...w, friendly_name: "XM1 power" });
    // no word of one language or one meter brand among the defaults
    expect(baseRole(outside)).toBe("temperature");
    expect(baseRole(meter)).toBe("power");
    const m = matchers({ outdoor: ["außen"], grid: ["xm1"] });
    expect(baseRole(outside, {}, m)).toBe("outdoor_temperature");
    expect(baseRole(meter, {}, m)).toBe("grid_import");
    // a keyword matches at a word start only: "den" is not in "golden"
    const den = matchers({ room: ["den"] });
    expect(baseRole(fact("sensor.den_temperature", "20", t), {}, den)).toBe("room_temperature");
    expect(baseRole(fact("sensor.golden_temperature", "20", t), {}, den)).toBe("temperature");
    // buildLayout takes them from groups.keywords
    const l = buildLayout([outside, meter], { groups: parseGroups({ keywords: { outdoor: ["außen"], grid: ["xm1"] } }) });
    expect([l.entities["sensor.aussen_temperature"]?.role, l.entities["sensor.xm1_power"]?.role]).toEqual(["outdoor_temperature", "grid_import"]);
    expect(Object.values(DEFAULT_KEYWORDS).flat().every((k) => /^[a-z ]+$/.test(k))).toBe(true);
  });

  it("takes grid and solar roles from the legacy tiles' labels", () => {
    const w = { device_class: "power", unit_of_measurement: "W" };
    const l = buildLayout([fact("sensor.p1_a", "100", w), fact("sensor.p1_b", "0", w), fact("sensor.inv", "0", w)], {
      tiles: [
        { entityId: "sensor.p1_a", label: "Grid import", kind: "power" },
        { entityId: "sensor.p1_b", label: "Grid export", kind: "power" },
        { entityId: "sensor.inv", label: "Solar", kind: "power" },
      ],
    });
    expect(["sensor.p1_a", "sensor.p1_b", "sensor.inv"].map((id) => l.entities[id]?.role)).toEqual(["grid_import", "grid_export", "solar"]);
  });
});

describe("parseGroups", () => {
  it("accepts nothing at all", () => expect(parseGroups(undefined)).toEqual({}));
  it("accepts keywords per name test, rejects unknown tests and non-lists", () => {
    expect(parseGroups({ keywords: { outdoor: ["yard"], export: ["to the grid"] } })).toEqual({ keywords: { outdoor: ["yard"], export: ["to the grid"] } });
    expect(() => parseGroups({ keywords: { attic: ["x"] } })).toThrow(/keywords: unknown key "attic"/);
    expect(() => parseGroups({ keywords: { outdoor: "yard" } })).toThrow(/keywords\.outdoor must be an array/);
  });
  it("rejects unknown keys, roles and sections", () => {
    expect(() => parseGroups({ colors: {} })).toThrow(/unknown key "colors"/);
    expect(() => parseGroups({ entities: { "light.a": { role: "disco" } } })).toThrow(/not a role/);
    expect(() => parseGroups({ entities: { "light.a": { section: "garden" } } })).toThrow(/section "garden" is unknown/);
    expect(() => parseGroups({ order: ["garden"] })).toThrow(/unknown section "garden"/);
    expect(() => parseGroups({ sections: { lights: { hidden: "yes" } } })).toThrow(/hidden must be a boolean/);
  });
  it("matches exact ids before patterns, patterns in file order", () => {
    const g = parseGroups({ entities: { "sensor.*": { group: "A" }, "sensor.den_*": { group: "B" }, "sensor.den_co2": { group: "C" } } });
    expect(overrideFor(g, "sensor.den_co2")?.group).toBe("C");
    expect(overrideFor(g, "sensor.guest_room_humidity")?.group).toBe("A");
    expect(overrideFor(g, "light.den")).toBeUndefined();
  });
});

describe("loadHouseConfig", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const dir = (content?: unknown): string => {
    const d = mkdtempSync(join(tmpdir(), "teobeanie-tiles-"));
    dirs.push(d);
    if (content !== undefined) writeFileSync(join(d, "tiles.json"), JSON.stringify(content));
    return d;
  };

  it("no file: no tiles and the generic layout", () => expect(loadHouseConfig(dir(), noLog)).toEqual({ tiles: [], groups: {}, infra: { cards: [] } }));
  it("reads a file with groups only", () => {
    expect(loadHouseConfig(dir({ groups: { pin: ["sensor.indoor_co2"] } }), noLog)).toEqual({ tiles: [], groups: { pin: ["sensor.indoor_co2"] }, infra: { cards: [] } });
  });
  it("keeps the plain tiles file working", () => {
    const tiles = [{ entityId: "sensor.indoor_co2", label: "CO₂", kind: "co2" }];
    expect(loadHouseConfig(dir({ tiles }), noLog)).toEqual({ tiles, groups: {}, infra: { cards: [] } });
  });
  it("names the file in a groups error", () => expect(() => loadHouseConfig(dir({ tiles: [], groups: { nope: 1 } }), noLog)).toThrow(/tiles\.json: groups: unknown key/));
  it("reads the cards for the Infra tab, with or without tiles, and names the file in an error", () => {
    expect(loadHouseConfig(dir({ infra: { cards: ["health-watch/*"] } }), noLog)).toEqual({ tiles: [], groups: {}, infra: { cards: ["health-watch/*"] } });
    expect(loadHouseConfig(dir({ tiles: [], infra: { cards: ["health-watch"] } }), noLog).infra).toEqual({ cards: ["health-watch"] });
    expect(() => loadHouseConfig(dir({ tiles: [], infra: { cards: [1] } }), noLog)).toThrow(/tiles\.json: infra\.cards must be a list/);
  });
  it("without a file the layout is generic: areas and domains, no room words", () => {
    const { tiles, groups } = loadHouseConfig(dir(), noLog);
    const t = { device_class: "temperature", unit_of_measurement: "°C" };
    const l = buildLayout([fact("sensor.kitchen_temperature", "21", t), fact("binary_sensor.carport_door", "off", { device_class: "door" })], { tiles, groups });
    expect(baseRole(fact("sensor.kitchen_temperature", "21", t))).toBe("temperature");
    expect(l.entities["binary_sensor.carport_door"]?.role).toBe("door");
  });
  it("keywords in tiles.json name the house's rooms and doors", () => {
    const { groups } = loadHouseConfig(dir({ tiles: [], groups: { keywords: { room: ["kitchen"], garage: ["carport"] } } }), noLog);
    const t = { device_class: "temperature", unit_of_measurement: "°C" };
    const l = buildLayout([fact("sensor.kitchen_temperature", "21", t), fact("binary_sensor.carport_door", "off", { device_class: "door" })], { groups });
    expect(baseRole(fact("sensor.kitchen_temperature", "21", t), {}, matchers(groups.keywords))).toBe("room_temperature");
    expect(l.entities["binary_sensor.carport_door"]?.role).toBe("garage_door");
  });
  it("an old-format file (tiles only, label-based roles) loads and renders as before", () => {
    const tiles = [{ entityId: "sensor.p1", label: "Grid import", kind: "power" }];
    const cfg = loadHouseConfig(dir({ tiles }), noLog);
    expect(cfg).toEqual({ tiles, groups: {}, infra: { cards: [] } });
    const l = buildLayout([fact("sensor.p1", "100", { device_class: "power", unit_of_measurement: "W" })], cfg);
    expect(l.entities["sensor.p1"]?.role).toBe("grid_import");
  });
  it("parses the starter example", () => {
    const { groups } = loadHouseConfig(join(root, "examples", "starter"), noLog);
    expect(groups.entities?.["switch.garage_opener_relay"]?.section).toBe("security");
  });
});

describe("summaries", () => {
  it("energy: kW and W summed, net, the house's own use, consumers", () => {
    const s = energySummary([
      ent(fact("sensor.grid_power_import", "0.5", { device_class: "power", unit_of_measurement: "kW" })),
      ent(fact("sensor.grid_power_export", "0", { device_class: "power", unit_of_measurement: "kW", friendly_name: "Grid export" })),
      ent(fact("sensor.solar_power", "1200", { device_class: "power", unit_of_measurement: "W" })),
      ent(fact("sensor.dishwasher_power", "800", { device_class: "power", unit_of_measurement: "W", friendly_name: "Dishwasher" })),
      ent(fact("sensor.fridge_power", "0", { device_class: "power", unit_of_measurement: "W" })),
    ]);
    expect(s).toMatchObject({ gridImport: 500, gridExport: 0, solar: 1200, net: 500, home: 1700 });
    expect(s.consumers).toEqual([{ id: "sensor.dishwasher_power", name: "Dishwasher", watts: 800 }]);
  });

  it("energy: exporting with the solar sensor down leaves the house's use unknown", () => {
    const s = energySummary([
      ent(fact("sensor.grid_power_export", "0.7", { device_class: "power", unit_of_measurement: "kW" })),
      ent(fact("sensor.solar_power", "unavailable", { device_class: "power", unit_of_measurement: "W" })),
    ]);
    expect(s).toMatchObject({ net: -700, solar: null, home: null });
  });

  it("openings: open ones oldest first, locks, unavailable", () => {
    const door = { device_class: "door" };
    const s = openingsSummary([
      ent(fact("binary_sensor.back_door", "on", door), 2000),
      ent(fact("binary_sensor.front_door", "on", door), 1000),
      ent(fact("binary_sensor.shed_door", "off", door)),
      ent(fact("binary_sensor.attic_window", "unavailable", { device_class: "window" })),
      ent(fact("lock.front", "unlocked")),
      ent(fact("lock.back", "locked")),
    ]);
    expect(s.open.map((e) => e.id)).toEqual(["binary_sensor.front_door", "binary_sensor.back_door"]);
    expect([s.closed, s.unavailable, s.locks.locked, s.locks.unlocked.length]).toEqual([1, 1, 1, 1]);
  });

  it("lights: on per area, switches apart", () => {
    const s = lightsSummary([
      { ...ent(fact("light.den_ceiling", "on")), area: "Den" },
      { ...ent(fact("light.den_lamp", "off")), area: "Den" },
      ent(fact("light.hall", "on")),
      ent(fact("switch.coffee_machine", "off")),
    ]);
    expect(s.lights).toEqual({ on: 2, total: 3 });
    expect(s.switches).toEqual({ on: 0, total: 1 });
    expect(s.byArea).toEqual([
      { area: "Den", on: 1, total: 2 },
      { area: "No area", on: 1, total: 2 },
    ]);
  });

  it("climate: thermostats, rooms with their humidity, no room repeating a thermostat", () => {
    const t = { device_class: "temperature", unit_of_measurement: "°C" };
    const s = climateSummary([
      { ...ent(fact("climate.den", "heat", { current_temperature: 20, temperature: 21, hvac_action: "heating" })), deviceId: "den-ac" },
      { ...ent(fact("sensor.den_room_temperature", "20", t)), deviceId: "den-ac" },
      { ...ent(fact("sensor.study_room_temperature", "19.5", t)), deviceId: "study" },
      { ...ent(fact("sensor.study_room_humidity", "55", { device_class: "humidity", unit_of_measurement: "%" })), deviceId: "study" },
      ent(fact("sensor.indoor_co2", "900", { device_class: "carbon_dioxide", unit_of_measurement: "ppm" })),
      ent(fact("binary_sensor.boiler_flame", "on", { device_class: "heat" })),
    ]);
    expect(s.thermostats).toMatchObject([{ id: "climate.den", mode: "heat", action: "heating", current: 20, target: 21 }]);
    expect(s.rooms).toEqual([{ id: "sensor.study_room_temperature", name: "study_room_temperature".replace(/_/g, " "), temperature: 19.5, humidity: 55, unit: "°C" }]);
    expect(s.co2.map((c) => c.ppm)).toEqual([900]);
    expect(s.heating.map((h) => h.on)).toEqual([true]);
    expect(s.range).toEqual({ min: 19.5, max: 20, mean: 19.75 });
  });

  it("outdoor: the configured sensor before the weather entity, wind from the weather", () => {
    const s = outdoorSummary(
      [
        ent(fact("weather.home", "rainy", { temperature: 9, humidity: 90, wind_speed: 20, wind_speed_unit: "km/h", wind_bearing: 225, pressure: 1003, pressure_unit: "hPa" })),
        ent(fact("sensor.garden_temperature", "8.4", { device_class: "temperature", unit_of_measurement: "°C" })),
        ent(fact("sun.sun", "above_horizon", { elevation: 12.3, azimuth: 200, next_setting: "2026-01-01T16:30:00+00:00" })),
      ],
      { weather: "weather.home", temperature: "sensor.garden_temperature" },
    );
    expect(s.condition).toBe("rainy");
    expect(s.temperature).toEqual({ value: 8.4, unit: "°C", source: "garden temperature" });
    expect(s.humidity?.value).toBe(90);
    expect(s.wind).toEqual({ speed: 20, unit: "km/h", bearing: 225, gust: null });
    expect(s.sun).toMatchObject({ above: true, elevation: 12.3, nextSetting: Date.parse("2026-01-01T16:30:00+00:00") });
  });

  it("safety and attention: alarms on, things open, not reporting", () => {
    const es = [
      ent(fact("binary_sensor.kitchen_leak", "on", { device_class: "moisture" })),
      ent(fact("binary_sensor.bath_leak", "off", { device_class: "moisture" })),
      ent(fact("binary_sensor.hall_smoke", "unavailable", { device_class: "smoke" })),
      ent(fact("valve.main_water", "open")),
      ent(fact("binary_sensor.front_door", "on", { device_class: "door" })),
      ent(fact("sensor.remote_battery", "12", { device_class: "battery", unit_of_measurement: "%" })),
    ];
    const s = safetySummary(es);
    expect(s.alerts.map((e) => e.id)).toEqual(["binary_sensor.kitchen_leak"]);
    expect(s.watching).toEqual([
      { kind: "leak", ok: 1, total: 2 },
      { kind: "smoke", ok: 0, total: 1 },
    ]);
    expect(s.valves.map((e) => e.id)).toEqual(["valve.main_water"]);
    const a = attention(es);
    expect([a.alerts.length, a.open.length, a.unavailable.length, a.lowBatteries.length]).toEqual([1, 1, 1, 1]);
  });
});

describe("createHouseService", () => {
  const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaEntityState => ({
    entity_id,
    state,
    attributes,
    last_changed: "2026-01-01T10:00:00Z",
    last_updated: "2026-01-01T10:00:00Z",
  });

  function fakeHa() {
    let handler: ((e: HaStateChangedEvent) => void) | undefined;
    let connection: ((connected: boolean) => void) | undefined;
    const events = new Map<string, () => void>();
    const sent: string[] = [];
    const ha = {
      send: async <T>(m: Record<string, unknown>): Promise<T> => {
        sent.push(String(m["type"]));
        switch (m["type"]) {
          case "config/entity_registry/list_for_display":
            return { entities: [{ ei: "light.den_ceiling", di: "d1" }, { ei: "sensor.grid_import_energy", di: "meter" }, { ei: "sensor.diag", ec: 1 }] } as T;
          case "config/device_registry/list":
            return [{ id: "d1", name: "Ceiling", name_by_user: null, area_id: "den" }, { id: "meter", name: "Meter", name_by_user: null, area_id: null }] as T;
          case "config/area_registry/list":
            return [{ area_id: "den", name: "Den" }] as T;
          case "energy/get_prefs":
            return { energy_sources: [{ type: "grid", stat_energy_from: "sensor.grid_import_energy", stat_energy_to: "sensor.grid_export_energy" }, { type: "gas", stat_energy_from: "sensor.gas_meter" }] } as T;
          default:
            throw new Error(`unexpected ${String(m["type"])}`);
        }
      },
      onStateChanged: (h: (e: HaStateChangedEvent) => void) => {
        handler = h;
        return () => (handler = undefined);
      },
      onConnectionChange: (h: (connected: boolean) => void) => {
        connection = h;
        return () => (connection = undefined);
      },
      onEvent: (type: string, h: () => void) => {
        events.set(type, h);
        return () => events.delete(type);
      },
      statisticsDuringPeriod: vi.fn(async (req: { statisticIds: string[] }) =>
        Object.fromEntries(req.statisticIds.map((id) => [id, [{ start: 0, end: 1, change: 1.5 }, { start: 1, end: 2, change: 0.5 }]])),
      ),
    };
    return { ha, sent, events, fire: (e: HaStateChangedEvent) => handler?.(e), connect: (c: boolean) => connection?.(c) };
  }

  const live = new Map<string, HaEntityState>([
    ["light.den_ceiling", st("light.den_ceiling", "on", { friendly_name: "Den ceiling", icon: "mdi:x" })],
    ["sensor.grid_import_energy", st("sensor.grid_import_energy", "1234", { device_class: "energy", unit_of_measurement: "kWh" })],
    ["sensor.gas_meter", st("sensor.gas_meter", "99", { device_class: "gas", unit_of_measurement: "m³" })],
    ["sensor.diag", st("sensor.diag", "1")],
    ["camera.outside", st("camera.outside", "idle")],
  ]);

  it("serves the scope only, with areas from the registry and trimmed attributes", async () => {
    const { ha } = fakeHa();
    const scope = new Set(["light.den_ceiling", "sensor.grid_import_energy"]);
    const svc = createHouseService({ ha, live: () => live, observes: (id) => scope.has(id), groups: {}, tiles: [], publish: () => {}, listening: () => true, log: noLog });
    const v = await svc.view();
    expect(Object.keys(v.entities).sort()).toEqual(["light.den_ceiling", "sensor.grid_import_energy"]);
    // the light has no area of its own: its device's area, marked as such
    expect(v.entities["light.den_ceiling"]).toMatchObject({ area: "Den", areaSource: "device", device: "Ceiling", group: "Den", state: "on", changedAt: Date.parse("2026-01-01T10:00:00Z") });
    expect(v.entities["sensor.grid_import_energy"]?.area).toBeUndefined();
    expect(v.entities["light.den_ceiling"]?.attributes).toEqual({});
    expect([v.scoped, v.registry]).toEqual([true, true]);
    svc.stop();
  });

  it("without a scope shows everything but HA's diagnostic entities", async () => {
    const { ha } = fakeHa();
    const svc = createHouseService({ ha, live: () => live, groups: {}, tiles: [], publish: () => {}, listening: () => true, log: noLog });
    const v = await svc.view();
    expect(Object.keys(v.entities).sort()).toEqual(["camera.outside", "light.den_ceiling", "sensor.gas_meter", "sensor.grid_import_energy"]);
    expect(v.scoped).toBe(false);
    svc.stop();
  });

  it("prefers the entity's own area to its device's", async () => {
    const { ha } = fakeHa();
    const send = ha.send;
    ha.send = async <T>(m: Record<string, unknown>): Promise<T> => {
      if (m["type"] === "config/entity_registry/list_for_display") return { entities: [{ ei: "light.den_ceiling", di: "d1", ai: "hall" }] } as T;
      if (m["type"] === "config/area_registry/list") return [{ area_id: "den", name: "Den" }, { area_id: "hall", name: "Hall" }] as T;
      return send<T>(m);
    };
    const svc = createHouseService({ ha, live: () => live, observes: (id) => id === "light.den_ceiling", groups: {}, tiles: [], publish: () => {}, listening: () => true, log: noLog });
    expect((await svc.view()).entities["light.den_ceiling"]).toMatchObject({ area: "Hall", areaSource: "entity", group: "Hall" });
    svc.stop();
  });

  it("caches the registries, reloads them after a reconnect or a registry change", async () => {
    const { ha, sent, events, connect } = fakeHa();
    const svc = createHouseService({ ha, live: () => live, groups: {}, tiles: [], publish: () => {}, listening: () => true, log: noLog });
    const loads = () => sent.filter((t) => t === "config/device_registry/list").length;
    await svc.view();
    await svc.view();
    expect(loads()).toBe(1);
    connect(true); // still the first connection: nothing to reload
    await svc.view();
    expect(loads()).toBe(1);
    connect(false);
    connect(true);
    await svc.view();
    expect(loads()).toBe(2);
    expect([...events.keys()].sort()).toEqual(["area_registry_updated", "device_registry_updated", "entity_registry_updated"]);
    events.get("device_registry_updated")!();
    await svc.view();
    await svc.view();
    expect(loads()).toBe(3);
    svc.stop();
    expect(events.size).toBe(0);
  });

  it("sums today's energy for the dashboard sources in scope", async () => {
    const { ha } = fakeHa();
    const scope = new Set(["sensor.grid_import_energy", "sensor.gas_meter"]);
    const svc = createHouseService({ ha, live: () => live, observes: (id) => scope.has(id), groups: {}, tiles: [], publish: () => {}, listening: () => true, log: noLog });
    const t = await svc.energyToday();
    expect(t.totals).toEqual([
      { kind: "grid_import", value: 2, unit: "kWh" },
      { kind: "gas", value: 2, unit: "m³" },
    ]);
    // the export sensor is outside the scope: never asked for
    expect(ha.statisticsDuringPeriod.mock.calls[0]![0].statisticIds).toEqual(["sensor.grid_import_energy", "sensor.gas_meter"]);
    svc.stop();
  });

  it("today starts at midnight in the house's zone", async () => {
    const { ha } = fakeHa();
    const t = Date.UTC(2026, 0, 6, 3, 0); // 22:00 on the 5th in New York, 12:00 on the 6th in Tokyo
    const since = async (timeZone?: string) => {
      const svc = createHouseService({ ha, live: () => live, groups: {}, tiles: [], publish: () => {}, listening: () => true, log: noLog, now: () => t, timeZone: () => timeZone });
      const s = (await svc.energyToday()).since;
      svc.stop();
      return s;
    };
    expect(await since("America/New_York")).toBe(Date.UTC(2026, 0, 5, 5, 0));
    expect(await since("Asia/Tokyo")).toBe(Date.UTC(2026, 0, 5, 15, 0));
    expect(await since(undefined)).toBe(Date.UTC(2026, 0, 6, 0, 0));
  });

  it("publishes changed states in scope, coalesced, only while someone listens", async () => {
    vi.useFakeTimers();
    try {
      const { ha, fire } = fakeHa();
      const frames: HouseFrame[] = [];
      let listening = true;
      const scope = new Set(["light.den_ceiling"]);
      const svc = createHouseService({ ha, live: () => live, observes: (id) => scope.has(id), groups: {}, tiles: [], publish: (f) => frames.push(f), listening: () => listening, log: noLog, frameMs: 500 });
      const change = (id: string, state: string): HaStateChangedEvent => ({ entityId: id, newState: st(id, state), oldState: null, timeFired: 0, context: null });
      fire(change("light.den_ceiling", "off"));
      fire(change("camera.outside", "recording"));
      fire(change("light.den_ceiling", "on"));
      await vi.advanceTimersByTimeAsync(600);
      expect(frames).toHaveLength(1);
      expect(Object.keys(frames[0]!.states)).toEqual(["light.den_ceiling"]);
      expect(frames[0]!.states["light.den_ceiling"]?.state).toBe("on");
      listening = false;
      fire(change("light.den_ceiling", "off"));
      await vi.advanceTimersByTimeAsync(600);
      expect(frames).toHaveLength(1);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
