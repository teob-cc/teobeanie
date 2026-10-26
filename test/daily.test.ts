// daily: the daily summary's text — yesterday's energy from the closed day (each carrier,
// the gas split, showers, the biggest devices, degree days, the heat pump route, the
// day's data problems) and what needs a look: alarms, open doors, low batteries, sensors
// not reporting, cards with a bad field, Teobeanie's problems and the pause.

import { describe, expect, it } from "vitest";
import { dailySummary, type DailyParts } from "../src/daily.js";
import { dayStart } from "../src/energy/calendar.js";
import type { EnergyOverview, Ledger } from "../src/energy/types.js";
import type { HouseEntity, HouseView, InstanceCard } from "../src/house/view.js";
import type { Role } from "../src/house/layout.js";

const TZ = "Europe/Amsterdam";
const HOUR = 3_600_000;
/** Mon 26 Oct 2026, 08:00 CET. */
const AT = Date.UTC(2026, 9, 26, 7, 0);

function ledger(key: string, over: Partial<Ledger> = {}): Ledger {
  const from = dayStart(key, TZ);
  return {
    key,
    from,
    to: from + 24 * HOUR,
    days: 1,
    complete: true,
    electricity: { importKwh: 0, exportKwh: 0, importCost: 0, exportCredit: 0 },
    solar: { kWh: 0 },
    gas: { m3: 0, cost: 0 },
    water: { m3: 0, cost: 0 },
    devices: [],
    fixed: 0,
    total: 0,
    estimated: false,
    ...over,
  };
}

function overview(days: Ledger[], over: Partial<EnergyOverview> = {}): EnergyOverview {
  return {
    at: AT,
    timeZone: TZ,
    available: true,
    sources: { gridImport: [], gridExport: [], solar: [], gas: [], water: [], devices: [], prices: {} },
    today: ledger("2026-10-26", { complete: false }),
    days,
    prices: { electricity: [], gas: [] },
    flags: [],
    backfill: { closedDays: days.length, pendingDays: 0, running: false },
    ...over,
  };
}

function entity(id: string, name: string, state: string, over: { role?: Role; attributes?: Record<string, unknown>; changedAt?: number } = {}): HouseEntity {
  return {
    id,
    name,
    domain: id.split(".")[0]!,
    ...(over.role !== undefined ? { role: over.role } : {}),
    section: "other",
    group: "Other",
    state,
    attributes: over.attributes ?? {},
    changedAt: over.changedAt ?? AT - HOUR,
    updatedAt: AT,
  };
}

function house(entities: HouseEntity[], cards: InstanceCard[] = []): HouseView {
  return { at: AT, scoped: true, registry: true, sections: [], pinned: [], tiles: [], entities: Object.fromEntries(entities.map((e) => [e.id, e])), cards, facts: [] };
}

const parts = (over: Partial<DailyParts>): DailyParts => ({ at: AT, timeZone: TZ, problems: [], ...over });

describe("dailySummary", () => {
  it("sums up yesterday's energy with what the ledger knows about it", () => {
    const sunday = ledger("2026-10-25", {
      electricity: { importKwh: 22.4, exportKwh: 3.1, importCost: 5.2, exportCredit: 0.6 },
      solar: { kWh: 6.25 },
      gas: { m3: 2.31, cost: 4.4, heatingM3: 1.9, hotWaterM3: 0.41 },
      water: { m3: 0.231, cost: 0.41 },
      fixed: 1.19,
      total: 10.6,
      degreeDays: 4.66,
      showers: { count: 2, litres: 62, gasM3: 0.24, cost: 0.56 },
      devices: [
        { id: "sensor.heat_pump", name: "Heat pump", use: "heating", kWh: 3.2, cost: 0.8 },
        { id: "sensor.washer", name: "Washer", use: "other", kWh: 4.1, cost: 1.02 },
        { id: "sensor.fridge_power", name: "Fridge", use: "other", kWh: 0, cost: 0 },
      ],
      heat: { spaceKwh: 18, hotWaterKwh: 3.9, split: "measured", gasCost: 4.4, gasFixed: 1.05, heatPumpKwh: 5.3, heatPumpCost: 1.3, saving: 4.15 },
    });
    const days = [ledger("2026-10-23", { total: 9 }), ledger("2026-10-24", { total: 11 }), sunday];
    const flags = [
      { kind: "spike" as const, id: "sensor.water_meter", at: dayStart("2026-10-25", TZ) + 5 * HOUR, text: "sensor.water_meter jumped 24 m³ in an hour: that hour counts 0" },
      { kind: "spike" as const, id: "sensor.water_meter", at: dayStart("2026-10-24", TZ), text: "the day before: not named" },
      { kind: "no_price_history" as const, text: "a flag of no day: not named" },
    ];
    expect(dailySummary(parts({ energy: overview(days, { flags }) }))).toBe(
      [
        "Teobeanie, Mon 26 Oct",
        "Energy Sun 25 Oct: €10.60 (€10.00 a day the 2 days before)",
        "- Electricity: 22 kWh in, 3.1 kWh out, solar 6.3 kWh: €4.60",
        "- Gas: 2.31 m³ (heating 1.90 m³, hot water 0.41 m³): €4.40",
        "- Water: 231 L: €0.41",
        "- Fixed charges: €1.19",
        "- Showers: 2, 62 L: €0.56",
        "- Most used: Washer 4.1 kWh (€1.02), Heat pump 3.2 kWh (€0.80)",
        "- Heating: 4.7 degree days, €2.27 per degree day",
        "- A heat pump instead of gas: €1.30 against €5.45, €4.15 less",
        "- Data: sensor.water_meter jumped 24 m³ in an hour: that hour counts 0",
        "",
        "Nothing needs attention.",
      ].join("\n"),
    );
  });

  it("says when yesterday is not closed yet, and leaves energy out of a house without a ledger", () => {
    expect(dailySummary(parts({ energy: overview([ledger("2026-10-24")], { backfill: { closedDays: 1, pendingDays: 2, running: true } }) })).split("\n")[1]).toBe(
      "Energy Sun 25 Oct: not closed yet (the ledger is closing days)",
    );
    expect(dailySummary(parts({ energy: overview([], { available: false }) }))).toBe("Teobeanie, Mon 26 Oct\n\nNothing needs attention.");
  });

  it("marks a day priced from estimates", () => {
    const text = dailySummary(parts({ energy: overview([ledger("2026-10-25", { estimated: true, total: 1.19, fixed: 1.19 })]) }));
    expect(text).toContain("- Data: some hours priced from an estimate (no price known for them)");
  });

  it("lists what needs a look: alarms, open doors, low batteries, sensors not reporting, bad card fields, problems, the pause", () => {
    const entities = [
      entity("binary_sensor.kitchen_leak", "Kitchen leak", "on", { role: "leak", changedAt: AT - 2 * HOUR }),
      entity("binary_sensor.shed_door", "Shed door", "on", { role: "door", changedAt: Date.UTC(2026, 9, 25, 18, 30) }),
      entity("binary_sensor.back_door", "Back door", "off", { role: "door" }),
      entity("sensor.remote_battery", "Hall motion battery", "12", { role: "battery", attributes: { unit_of_measurement: "%" } }),
      entity("sensor.porch", "Porch battery", "80", { role: "battery" }),
      entity("binary_sensor.leak_a", "Leak sensor battery", "on", { role: "battery" }),
      entity("sensor.kitchen_temperature", "Attic temperature", "unavailable", { role: "temperature", changedAt: Date.UTC(2026, 9, 12, 9, 0) }),
    ];
    const cards: InstanceCard[] = [
      {
        key: "health-watch/nas",
        heuristic: "health-watch",
        id: "nas",
        mode: "active",
        card: {
          title: "NAS",
          fields: [
            { label: "Volume 1", value: "attention", tone: "bad" },
            { label: "Drive 1 temperature", value: 38, unit: "°C", tone: "ok" },
            { label: "Used", value: 93, unit: "%", tone: "bad" },
          ],
        },
      },
      { key: "door-nag/shed", heuristic: "door-nag", id: "shed", mode: "active", card: { title: "Shed door", fields: [{ label: "Open", value: "no", tone: "ok" }] } },
    ];
    const text = dailySummary(
      parts({
        house: house(entities, cards),
        problems: ["Teobeanie: refused light.turn_on light.porch for sensor-light/porch: not operable"],
        pause: { since: AT - 3 * HOUR, by: "alex" },
      }),
    );
    expect(text).toBe(
      [
        "Teobeanie, Mon 26 Oct",
        "",
        "Needs attention:",
        "- Alarm: Kitchen leak since 06:00",
        "- Open: Shed door since Sun 19:30",
        "- Low batteries: Hall motion battery 12 %, Leak sensor battery",
        "- Not reporting: Attic temperature since 12 Oct",
        "- NAS: Volume 1 attention, Used 93 %",
        "- refused light.turn_on light.porch for sensor-light/porch: not operable",
        "- All heuristics paused since 05:00 by alex: only guards act",
      ].join("\n"),
    );
  });

  it("names at most eight per line and counts the rest", () => {
    const ids = ["a", "b", "c", "d", "x", "y", "l1", "l2", "r", "n", "hall"];
    const quiet = ids.map((id, i) => entity(`sensor.${id}`, `S${i}`, "unknown", { changedAt: AT - (20 - i) * HOUR }));
    const line = dailySummary(parts({ house: house(quiet) })).split("\n").find((l) => l.startsWith("- Not reporting"))!;
    expect(line).toBe(`- Not reporting: ${Array.from({ length: 8 }, (_, i) => `S${i} since Sun ${String(12 + i).padStart(2, "0")}:00`).join(", ")} and 3 more`);
  });
});
