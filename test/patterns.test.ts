// The meta control patterns: hold, button, command (garage-door) composed with
// momentary through sharing, and rules reading the outdoor conditions.


import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minutes, readOutdoor, type HouseFacts, type Observed } from "../src/kernel/heuristic.js";
import { simulate } from "../src/kernel/simulate.js";
import { keep, rule } from "../src/kernel/rule.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { houseScope, loadAllowlist } from "../src/allowlist.js";
import { garageDoor, type GarageDoorParams } from "../packages/garage-door/garage-door.ts";
import { relayPulse } from "../packages/relay-pulse/relay-pulse.ts";
import { buildTiles, compass } from "../src/tiles.js";

describe("garage-door composed with relay-pulse on the host", () => {
  const p: GarageDoorParams = { button: "switch.l1", contact: "binary_sensor.door", commands: { open: "garage_open", close: "garage_close" } };
  const instances = (withMomentary: boolean) => [
    ...(withMomentary ? [{ heuristic: "relay-pulse", id: "garage", params: { relays: ["switch.l1"], pressMs: 1000, recheckMs: 5000 } }] : []),
    { heuristic: "garage-door", id: "main", params: p },
  ];
  const host = (withMomentary: boolean, logs: string[] = []) => {
    const actuator = createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) }, scope: houseScope(["binary_sensor.door"], ["switch.l1"]) });
    const h = createHeuristicHost({
      library: [relayPulse, garageDoor],
      instances: instances(withMomentary),
      actuator,
      liveState: () => undefined,
      scope: houseScope(["binary_sensor.door"], ["switch.l1"]),
      forceShadow: false,
      log: (_l, m) => logs.push(m),
    });
    return { h, actuator };
  };

  it("the host lets garage-door press the relay relay-pulse owns and shares, and routes its commands", () => {
    const { h, actuator } = host(true);
    expect(h.instances().map((i) => [i.key, i.actuates, i.uses])).toEqual([
      ["relay-pulse/garage", ["switch.l1"], []],
      ["garage-door/main", [], ["switch.l1"]],
    ]);
    expect(h.commandNames()).toEqual(["garage_close", "garage_open"]);
    const press = { kind: "call" as const, service: "switch.turn_on", entities: ["switch.l1"] };
    expect(actuator.vet("garage-door/main", press, 0, 10)).toEqual({ ok: true });
    expect(actuator.vet("someone/else", press, 0, 10)).toMatchObject({ ok: false });
  });

  it("without a momentary instance sharing the relay, garage-door does not start", () => {
    const logs: string[] = [];
    const { h } = host(false, logs);
    expect(h.instances()).toEqual([]);
    expect(logs.join("\n")).toMatch(/garage-door\/main uses switch\.l1, which no running instance shares/);
  });
});

describe("outdoor conditions", () => {
  const house: HouseFacts = { outdoor: { weather: "weather.home", temperature: "sensor.outside_temp" } };
  const o = (state: string, attributes: Record<string, unknown> = {}): Observed => ({ value: Number(state), state, since: 0, attributes });

  it("sensors win over the weather entity; wind comes from the weather entity", () => {
    const world: Record<string, Observed> = {
      "weather.home": o("rainy", { temperature: 9, humidity: 88, wind_speed: 31, wind_bearing: 220 }),
      "sensor.outside_temp": o("11.5"),
    };
    world["weather.home"]!.value = "rainy";
    expect(readOutdoor((e) => world[e], house.outdoor)).toEqual({ temperature: 11.5, humidity: 88, windSpeed: 31, windBearing: 220, condition: "rainy" });
  });

  it("a rule reading the wind is woken by the weather entity's attribute changes", () => {
    const awning = rule("awning", ({ ha, outdoor, held }) =>
      ha.cover.awning.to(held(() => (outdoor.windSpeed ?? 0) > 40, minutes(2)) ? "closed" : keep),
    );
    expect(awning.usesOutdoor).toBe(true);
    const sim = simulate(awning, undefined, { "cover.awning": "open", "sensor.outside_temp": "12", "weather.home": { state: "cloudy", attributes: { wind_speed: 20 } } }, { house }).start();
    sim.set("weather.home", "cloudy", { wind_speed: 45 }).advance(minutes(1));
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(1));
    expect(sim.calls()).toEqual(["cover.close_cover cover.awning"]);
  });

  it("tiles show a weather attribute, the wind with its compass point", () => {
    const weather = { entity_id: "weather.home", state: "rainy", last_changed: "", last_updated: "2026-01-05T12:00:00Z", attributes: { humidity: 88, wind_speed: 31, wind_speed_unit: "km/h", wind_bearing: 138.7 } };
    const { tiles } = buildTiles(
      [
        { entityId: "weather.home", label: "Wind", kind: "wind", attribute: "wind_speed" },
        { entityId: "weather.home", label: "Humidity", kind: "humidity", attribute: "humidity" },
      ],
      { liveState: () => weather },
    );
    expect(tiles.map((t) => [t.value, t.unit])).toEqual([[31, "km/h SE"], [88, "%"]]);
    expect([0, 44, 46, 180, 359, -90].map(compass)).toEqual(["N", "NE", "NE", "S", "N", "W"]);
  });

  it("allowlist.json names the sources, which must be in the scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-outdoor-"));
    const write = (outdoor: unknown) =>
      writeFileSync(join(dir, "allowlist.json"), JSON.stringify({ entities: [{ id: "weather.home" }, { id: "sensor.outside_temp" }], outdoor }));
    write({ weather: "weather.home", temperature: "sensor.outside_temp" });
    expect(loadAllowlist(dir, () => {}).house.outdoor).toEqual({ weather: "weather.home", temperature: "sensor.outside_temp" });
    write({ weather: "weather.home", humidity: "sensor.not_listed" });
    expect(() => loadAllowlist(dir, () => {})).toThrow(/outdoor.humidity must be an entity listed/);
  });
});
