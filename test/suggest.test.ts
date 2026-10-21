// suggest: which packages' roles a made-up house's entities can fill, pre-bound.

import { describe, expect, it } from "vitest";
import { MAX_MANY, bindParams, fits, slug, suggest, type SuggestEntity, type SuggestPackage } from "../src/packages/suggest.js";
import { starterPackages } from "../src/packages/library.js";

const pkg = (name: string, heuristics: SuggestPackage["manifest"]["heuristics"], installed = false): SuggestPackage => ({
  name,
  installed,
  manifest: { name, title: name, heuristics },
});

const lightPkg = pkg("sensor-light", {
  "sensor-light": {
    title: "Sensor → lights",
    pattern: "trigger",
    roles: {
      sensors: { domain: "binary_sensor", device_class: ["motion", "occupancy"], many: true },
      lights: { domain: ["light", "switch"], many: true, operate: true },
      "dark.illuminance": { domain: "sensor", device_class: "illuminance", optional: true },
    },
  },
});
const doorPkg = pkg("door-watch", {
  "door-nag": { pattern: "notice", roles: { door: { domain: "binary_sensor", device_class: ["door", "window"] } } },
});
const leakPkg = pkg("leak-guard", {
  "leak-shutoff": {
    pattern: "guard",
    roles: { sensors: { domain: "binary_sensor", device_class: "moisture", many: true }, valve: { domain: ["valve", "switch"], operate: true } },
  },
});
const relayPkg = pkg("relay-pulse", { "relay-pulse": { roles: { relays: { domain: "switch", many: true, operate: true } } } });

const house: SuggestEntity[] = [
  { id: "binary_sensor.hall_motion", area: "Hall", device_class: "motion" },
  { id: "light.hall", area: "Hall" },
  { id: "light.hallway_ceiling", area: "Hall" },
  { id: "sensor.hall_lux", area: "Hall", device_class: "illuminance" },
  { id: "binary_sensor.kitchen_motion", area: "Kitchen", device_class: "motion" },
  { id: "binary_sensor.front_door", area: "Hall", device_class: "door" },
  { id: "binary_sensor.back_door", area: "Hall", device_class: "door" },
  { id: "binary_sensor.bath_leak", area: "Bathroom", device_class: "moisture" },
  { id: "binary_sensor.kitchen_leak", area: "Kitchen", device_class: "moisture" },
  { id: "valve.main_water", area: "Utility" },
];

describe("suggest: matching", () => {
  it("a role fits by domain, and by device class when it names some", () => {
    const role = { domain: "binary_sensor", device_class: ["motion", "occupancy"] };
    expect(fits(role, { id: "binary_sensor.a", device_class: "motion" })).toBe(true);
    expect(fits(role, { id: "binary_sensor.a", device_class: "door" })).toBe(false);
    expect(fits(role, { id: "binary_sensor.a" })).toBe(false);
    expect(fits(role, { id: "sensor.a", device_class: "motion" })).toBe(false);
    expect(fits({ domain: ["light", "switch"] }, { id: "switch.a" })).toBe(true);
  });

  it("binds a complete area: many roles take all of the area's candidates, optional roles are offered, not bound", () => {
    const [s] = suggest({ packages: [lightPkg], entities: house, instances: [] });
    expect(s).toMatchObject({
      package: "sensor-light",
      heuristic: "sensor-light",
      area: "Hall",
      complete: true,
      bindings: { sensors: ["binary_sensor.hall_motion"], lights: ["light.hall", "light.hallway_ceiling"] },
      operates: ["light.hall", "light.hallway_ceiling"],
      optional: { "dark.illuminance": ["sensor.hall_lux"] },
      instance: { heuristic: "sensor-light", id: "hall", mode: "shadow", params: { sensors: ["binary_sensor.hall_motion"], lights: ["light.hall", "light.hallway_ceiling"] } },
    });
    expect(s!.reason).toMatch(/^Hall: sensors \(1\), lights \(2\) for Sensor → lights; it would switch 2 entities$/);
    // The kitchen has a sensor but no light: not suggested while the hall is complete.
    expect(suggest({ packages: [lightPkg], entities: house, instances: [] })).toHaveLength(1);
  });

  it("a role that takes one entity binds the first and lists the others as alternatives", () => {
    const [s] = suggest({ packages: [doorPkg], entities: house, instances: [] });
    expect(s).toMatchObject({ area: "Hall", bindings: { door: ["binary_sensor.back_door"] }, alternatives: { door: ["binary_sensor.front_door"] }, operates: [] });
    expect(s!.instance.params).toEqual({ door: "binary_sensor.back_door" });
    expect(s!.reason).toMatch(/it only reads$/);
  });

  it("prefers the same area; a heuristic no area completes is bound across the house", () => {
    const [s] = suggest({ packages: [leakPkg], entities: house, instances: [] });
    expect(s).toMatchObject({
      area: null,
      complete: true,
      bindings: { sensors: ["binary_sensor.bath_leak", "binary_sensor.kitchen_leak"], valve: ["valve.main_water"] },
      instance: { id: "leak-shutoff" },
    });
    expect(s!.reason).toMatch(/^Across the house: /);
  });

  it("with an area asked for, a role it cannot fill there is missing, with candidates elsewhere", () => {
    const [s] = suggest({ packages: [leakPkg], entities: house, instances: [], area: "bathroom" });
    expect(s).toMatchObject({
      area: "Bathroom",
      complete: false,
      bindings: { sensors: ["binary_sensor.bath_leak"] },
      missing: [{ role: "valve", wants: "valve|switch", elsewhere: ["valve.main_water"] }],
    });
    expect(s!.reason).toMatch(/missing valve/);
    expect(suggest({ packages: [lightPkg], entities: house, instances: [], area: "Hall" })[0]!.area).toBe("Hall");
  });

  it("nothing fits: no suggestion; a partial one when no area and not the house can complete it", () => {
    expect(suggest({ packages: [leakPkg], entities: house.filter((e) => !e.id.startsWith("binary_sensor.")), instances: [] })).toEqual([
      expect.objectContaining({ area: "Utility", complete: false, missing: [{ role: "sensors", wants: "binary_sensor (moisture)", elsewhere: [] }] }),
    ]);
    expect(suggest({ packages: [doorPkg], entities: [{ id: "light.a" }], instances: [] })).toEqual([]);
  });

  it("skips entities an instance of the same heuristic uses, and for switched roles those any instance owns", () => {
    const instances = [
      { heuristic: "sensor-light", entities: ["binary_sensor.hall_motion", "light.hall"], owns: ["light.hall"] },
      { heuristic: "relay-pulse", entities: ["light.hallway_ceiling"], owns: ["light.hallway_ceiling"] },
    ];
    // The hall's sensor is used and both lights are owned: nothing left to bind there.
    const s = suggest({ packages: [lightPkg], entities: house, instances });
    expect(s.flatMap((x) => Object.values(x.bindings).flat())).not.toContain("light.hall");
    expect(s.flatMap((x) => Object.values(x.bindings).flat())).not.toContain("binary_sensor.hall_motion");
    expect(s.flatMap((x) => Object.values(x.bindings).flat())).not.toContain("light.hallway_ceiling");
    // Another heuristic may still read a sensor the first one watches.
    const doors = suggest({ packages: [doorPkg], entities: house, instances: [{ heuristic: "sensor-light", entities: ["binary_sensor.back_door"], owns: [] }] });
    expect(doors[0]!.bindings).toEqual({ door: ["binary_sensor.back_door"] });
    expect(suggest({ packages: [doorPkg], entities: house, instances: [{ heuristic: "door-nag", entities: ["binary_sensor.back_door"], owns: [] }] })[0]!.bindings).toEqual({
      door: ["binary_sensor.front_door"],
    });
  });

  it("disabled, hidden and config entities never fit; one entity fills one role", () => {
    const entities: SuggestEntity[] = [
      { id: "binary_sensor.leak_a", area: "Utility", device_class: "moisture" },
      { id: "valve.a", area: "Utility", disabled: true },
      { id: "valve.b", area: "Utility", hidden: true },
      { id: "valve.c", area: "Utility", category: true },
      { id: "switch.pump", area: "Utility" },
    ];
    expect(suggest({ packages: [leakPkg], entities, instances: [] })[0]!.bindings).toEqual({ sensors: ["binary_sensor.leak_a"], valve: ["switch.pump"] });
    const both = pkg("two", { two: { roles: { a: { domain: "switch" }, b: { domain: "switch" } } } });
    expect(suggest({ packages: [both], entities: [{ id: "switch.x", area: "A" }], instances: [] })[0]).toMatchObject({ complete: false, bindings: { a: ["switch.x"] } });
  });

  it("caps a many role, flags domain-only roles to check, ranks specific and complete first, one per heuristic first", () => {
    const many: SuggestEntity[] = Array.from({ length: MAX_MANY + 3 }, (_, i) => ({ id: `switch.r${String(i).padStart(2, "0")}`, area: "Shed" }));
    const out = suggest({ packages: [relayPkg, doorPkg, lightPkg], entities: [...house, ...many, { id: "binary_sensor.shed_door", area: "Shed", device_class: "door" }], instances: [] });
    const relay = out.find((s) => s.heuristic === "relay-pulse")!;
    expect(relay.bindings["relays"]).toHaveLength(MAX_MANY);
    expect(relay.check).toEqual(["relays"]);
    expect(relay.reason).toMatch(/relays matched by domain only/);
    // Every role with a device class (door-nag) first; door-nag's second area after every heuristic's first.
    expect(out.map((s) => `${s.heuristic}@${s.area}`)).toEqual(["door-nag@Hall", "sensor-light@Hall", "relay-pulse@Shed", "door-nag@Shed"]);
    expect(out.find((s) => s.heuristic === "sensor-light")!.check).toBeUndefined();
    expect(suggest({ packages: [relayPkg, doorPkg, lightPkg], entities: house, instances: [], limit: 2 })).toHaveLength(2);
  });

  it("an installed package wins over the starter package of that name", () => {
    const installed = pkg("door-watch", { "door-nag": { roles: { door: { domain: "binary_sensor", device_class: "window" } } } }, true);
    expect(suggest({ packages: [doorPkg, installed], entities: [...house, { id: "binary_sensor.attic_window", area: "Attic", device_class: "window" }], instances: [] })).toEqual([
      expect.objectContaining({ installed: true, bindings: { door: ["binary_sensor.attic_window"] } }),
    ]);
  });

  it("the starter packages' roles bind against a made-up house", () => {
    const packages = starterPackages().map((p) => ({ name: p.name, installed: false, manifest: p.manifest }));
    const out = suggest({ packages, entities: house, instances: [], limit: 50 });
    const byHeuristic = new Map(out.map((s) => [s.heuristic, s]));
    expect(byHeuristic.get("sensor-light")).toMatchObject({ area: "Hall", complete: true });
    expect(byHeuristic.get("leak-shutoff")).toMatchObject({ complete: true, bindings: { valve: ["valve.main_water"] } });
    expect(byHeuristic.get("door-nag")).toMatchObject({ complete: true });
  });
});

describe("suggest: params", () => {
  it("nests dotted paths and spreads list paths over items", () => {
    expect(
      bindParams([
        { path: "lights", ids: ["light.a", "light.b"], many: true },
        { path: "dark.illuminance", ids: ["sensor.l"], many: false },
        { path: "buttons[].entity", ids: ["event.x", "event.y"], many: true },
        { path: "presses[].set[].entity", ids: ["light.a"], many: true },
        { path: "empty", ids: [], many: true },
      ]),
    ).toEqual({
      lights: ["light.a", "light.b"],
      dark: { illuminance: "sensor.l" },
      buttons: [{ entity: "event.x" }, { entity: "event.y" }],
      presses: [{ set: [{ entity: "light.a" }] }],
    });
  });

  it("an area name becomes an instance id", () => {
    expect(slug("Living room")).toBe("living-room");
    expect(slug("Küche 2")).toBe("kuche-2");
    expect(slug("—")).toBe("main");
  });
});
