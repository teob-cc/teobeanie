// climate-guard on the host: a waiver across a restart, the command routed through the host, the bot's menu.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import { hours } from "../src/kernel/heuristic.js";
import { simulate } from "../src/kernel/simulate.js";
import { isKernelEvent } from "../src/kernel/step.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { climateGuard, type ClimateGuardParams } from "../packages/climate-guard/climate-guard.ts";

const bedroom: ClimateGuardParams = {
  climate: "climate.bedroom",
  setpoints: { heat: 20, cool: 22 },
  maxRunMin: 180,
  startHeatBelow: 17,
  waive: { command: "climate_waive", room: "bedroom" },
};
const heating = (temperature = 20, current = 19) => ({ "climate.bedroom": { state: "heat", attributes: { current_temperature: current, temperature } } });
const bed = (state: string, attributes: Record<string, unknown>) => ["climate.bedroom", state, attributes] as const;
const alex = { channel: "telegram", user: "alex" };
// t0 is noon UTC: 07:00 in New York.
const tz = { timeZone: "America/New_York" };

describe("climate-guard waiver on the host", () => {
  it("a restart keeps a running waiver: its state folds from the journal, its timer stands", () => {
    const sim = simulate(climateGuard, bedroom, heating(), tz).start();
    sim.command("climate_waive", ["bedroom"], alex).advance(hours(1));
    sim.start(); // the add-on restarts
    expect(sim.whys().at(-1)).toBe("waived until 10:00 by alex: climate.bedroom left alone");
    expect(sim.calls()).toHaveLength(1);
    expect(sim.timers["waiver"]?.at).toBe(sim.now + hours(2));
    const folded = sim.journal
      .map((e) => e.event)
      .filter((e) => !isKernelEvent(e))
      .reduce((s, e) => climateGuard.evolve(s, e as never), climateGuard.initial(bedroom));
    expect(folded).toEqual(sim.state);
    expect(folded.waiver).toEqual({ by: "alex", until: sim.now + hours(2) });
    // Ran out while the add-on was down: the start ends it, and cancels its overdue timer.
    const now = sim.now + hours(3);
    const ctx = { now, params: bedroom, instance: "sim", get: () => undefined, value: () => undefined, timer: (id: string) => (id === "waiver" ? now - hours(1) : undefined), house: tz };
    const d = climateGuard.decide(folded, { kind: "start", at: now }, ctx);
    expect(d?.events?.[0]).toEqual({ tag: "WaiverEnded", reason: "ran out" });
    expect(d?.timers).toEqual([{ op: "cancel", timer: "waiver" }]);
  });

  it("routes through the host: one reply for a room nobody answers for", async () => {
    const host = createHeuristicHost({
      library: [climateGuard],
      instances: [
        { heuristic: "climate-guard", id: "bedroom", mode: "shadow", params: bedroom },
        { heuristic: "climate-guard", id: "study", mode: "shadow", params: { ...bedroom, climate: "climate.study", waive: { command: "climate_waive", room: "study" } } },
      ],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } }),
      liveState: () => undefined,
      forceShadow: false,
      log: () => {},
    });
    const journal = createSqliteJournal({ path: join(mkdtempSync(join(tmpdir(), "teobeanie-waive-")), "journal.db") });
    host.attach(journal);
    await host.start({ subscribeTrigger: async () => async () => {} });
    const whys = () =>
      journal
        .queryEvents({ category: "climate-guard", limit: 100 })
        .filter((r) => r.manifest === "Decided" && (r.payload as { input: { kind: string } }).input.kind === "command")
        .map((r) => `${r.entityId}: ${(r.payload as { why?: string }).why}`);
    expect(host.command("climate_waive", ["kitchen"], alex)).toEqual(["climate-guard/bedroom", "climate-guard/study"]);
    host.command("climate_waive", ["study"], alex);
    await vi.waitFor(() => expect(whys()).toHaveLength(2));
    expect(whys().sort()).toEqual([
      'bedroom: climate_waive by alex: No room "kitchen". Rooms: /climate_waive bedroom, /climate_waive study.',
      expect.stringMatching(/^study: climate_waive by alex: guard waived for study until \d\d:\d\d, climate.study left alone$/),
    ]);
    await host.stop();
    journal.close();
  });

  it("the bot's menu and keyboard: active instances' rooms, and ending a running waiver", async () => {
    const sent: string[] = [];
    const host = createHeuristicHost({
      library: [climateGuard],
      instances: [
        { heuristic: "climate-guard", id: "study", mode: "active", params: { ...bedroom, climate: "climate.study", waive: { command: "climate_waive", room: "study" } } },
        { heuristic: "climate-guard", id: "bedroom", mode: "active", params: bedroom, commandHelp: { climate_waive: "Warmer or cooler for a while" } },
        { heuristic: "climate-guard", id: "den", mode: "shadow", params: { ...bedroom, climate: "climate.den", waive: { command: "climate_waive", room: "den" } } },
      ],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) }, notifier: { send: async (t) => void sent.push(t) } }),
      liveState: () => undefined,
      forceShadow: false,
      log: () => {},
    });
    expect(host.commandMenu()).toEqual([{ command: "climate_waive", description: "Lift the climate guard in a room for a while" }]);
    // The shadow room is a choice (typed, it reaches its instance), not a button.
    expect(host.commandKeyboard("climate_waive")).toEqual({ choices: ["bedroom", "den", "study"], rows: [["bedroom"], ["study"]] });
    expect(host.commandKeyboard("climate_other")).toBeUndefined();
    const journal = createSqliteJournal({ path: join(mkdtempSync(join(tmpdir(), "teobeanie-waive-")), "journal.db") });
    host.attach(journal);
    await host.start({ subscribeTrigger: async () => async () => {} });
    host.command("climate_waive", ["study"], alex);
    await vi.waitFor(() => expect(host.commandKeyboard("climate_waive")?.rows).toEqual([["bedroom"], ["study", "study off"]]));
    host.command("climate_waive", ["study", "off"], alex);
    await vi.waitFor(() => expect(host.commandKeyboard("climate_waive")?.rows).toEqual([["bedroom"], ["study"]]));
    expect(sent.at(-1)).toBe("Climate guard is back on for study.");
    // An instance's own description wins; without an active instance a command has no entry.
    const next = host.prepare({
      library: [climateGuard],
      instances: [
        { heuristic: "climate-guard", id: "bedroom", mode: "active", params: bedroom, commandHelp: { climate_waive: "Warmer or cooler for a while" } },
        { heuristic: "climate-guard", id: "den", mode: "shadow", params: { ...bedroom, climate: "climate.den", waive: { command: "climate_waive", room: "den" } } },
      ],
    });
    await next.commit();
    expect(host.commandMenu()).toEqual([{ command: "climate_waive", description: "Warmer or cooler for a while" }]);
    await host.prepare({ library: [climateGuard], instances: [{ heuristic: "climate-guard", id: "den", mode: "shadow", params: bedroom }] }).commit();
    expect(host.commandMenu()).toEqual([]);
    expect(host.commandKeyboard("climate_waive")).toBeUndefined();
    await host.stop();
    journal.close();
  });
});
