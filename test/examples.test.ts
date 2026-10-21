import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCustomHeuristics } from "../src/kernel/custom.js";
import { createHeuristicHost, type InstanceConfig } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { minutes } from "../src/kernel/heuristic.js";
import { simulate } from "../src/kernel/simulate.js";
import { STARTER as LIBRARY } from "./starter.js";
import { loadHouseConfig } from "../src/tiles.js";
import { loadAllowlist } from "../src/allowlist.js";
import { loadLibrary } from "../src/packages/library.js";

const root = join(import.meta.dirname, "..");
const noLog = (): void => {};
const instancesOf = (dir: string): InstanceConfig[] =>
  (JSON.parse(readFileSync(join(root, "examples", dir, "heuristics.json"), "utf8")) as { instances: InstanceConfig[] }).instances;

describe("examples/", () => {
  it("starter: every instance resolves against the built-in library and claims are conflict-free", async () => {
    const logged: string[] = [];
    const host = createHeuristicHost({
      library: [...LIBRARY, ...(await loadCustomHeuristics(join(root, "examples", "starter"), LIBRARY, noLog))],
      instances: instancesOf("starter"),
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
      liveState: () => undefined,
      scope: loadAllowlist(join(root, "examples", "starter"), noLog).scope,
      forceShadow: true,
      log: (_l, m) => logged.push(m),
    });
    expect(logged).toEqual([]);
    expect(host.instances().length).toBe(instancesOf("starter").length);
  });

  it("starter: the sample rule does what its test (heuristics/night-light.test.ts) says", async () => {
    const [nightLight] = await loadCustomHeuristics(join(root, "examples", "starter"), LIBRARY, noLog);
    const world = { "binary_sensor.hallway_motion": "off", "light.hallway_night": "off" };
    const sim = simulate(nightLight!, {}, world).start();
    sim.advance(minutes(11 * 60 + 30)); // 23:30
    sim.set("binary_sensor.hallway_motion", "on");
    expect(sim.calls()).toEqual(["light.turn_on light.hallway_night"]);
    sim.set("light.hallway_night", "on"); // the light follows
    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(3));
    expect(sim.calls()).toEqual(["light.turn_on light.hallway_night", "light.turn_off light.hallway_night"]);
    const day = simulate(nightLight!, {}, world).start();
    day.set("binary_sensor.hallway_motion", "on").advance(minutes(1));
    expect(day.calls()).toEqual([]);
  });

  it("starter tiles.json loads, with tiles and keywords", () => {
    const { tiles, groups } = loadHouseConfig(join(root, "examples", "starter"), noLog);
    expect(tiles.length).toBeGreaterThan(0);
    expect(groups.keywords?.room?.length).toBeGreaterThan(0);
  });

  it("custom-heuristic: loads from the config folder and behaves", async () => {
    const defs = await loadCustomHeuristics(join(root, "examples", "custom-heuristic"), LIBRARY, noLog);
    expect(defs.map((d) => d.id)).toEqual(["appliance-done"]);
    const washer = instancesOf("custom-heuristic")[0]!;
    const sim = simulate(defs[0]!, washer.params, { "sensor.washing_machine_power": "0" });
    sim.set("sensor.washing_machine_power", "1800").advance(minutes(40));
    sim.set("sensor.washing_machine_power", "1").advance(minutes(2));
    sim.set("sensor.washing_machine_power", "60").advance(minutes(10)); // spin pause, not done
    expect(sim.calls()).toEqual([]);
    sim.set("sensor.washing_machine_power", "0").advance(minutes(5));
    expect(sim.calls()).toEqual(["notify: The washing machine is done."]);
  });

  it("rules: TypeScript rules load from the config folder, resolve their instances and behave", async () => {
    const dir = join(root, "examples", "rules");
    const defs = await loadCustomHeuristics(dir, LIBRARY, noLog);
    expect(defs.map((d) => d.id).sort()).toEqual(["hallway-light", "pump-run-on"]);
    const logged: string[] = [];
    const host = createHeuristicHost({
      library: [...LIBRARY, ...defs],
      instances: instancesOf("rules"),
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
      liveState: () => undefined,
      scope: loadAllowlist(join(root, "examples", "rules"), noLog).scope,
      forceShadow: true,
      log: (_l, m) => logged.push(m),
    });
    expect(logged).toEqual([]);
    expect(host.instances().map((i) => [i.key, i.watch, i.actuates])).toEqual([
      ["hallway-light/main", ["binary_sensor.hallway_motion"], ["light.hallway"]],
      ["pump-run-on/main", ["binary_sensor.boiler_heating"], ["switch.circulation_pump"]],
    ]);

    const hallway = defs.find((d) => d.id === "hallway-light")!;
    // 2026-01-05 22:30 UTC = 23:30 in Lagos (UTC+1): night brightness.
    const sim = simulate(hallway, {}, { "binary_sensor.hallway_motion": "off", "light.hallway": "off" }, { t0: Date.UTC(2026, 0, 5, 22, 30), timeZone: "Africa/Lagos" });
    sim.start().set("binary_sensor.hallway_motion", "on");
    expect(sim.actions().map((a) => a.action)).toEqual([
      { kind: "call", service: "light.turn_on", entities: ["light.hallway"], data: { brightness_pct: 15 } },
    ]);
    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(5));
    expect(sim.calls().at(-1)).toBe("light.turn_off light.hallway");
  });

  it("rules: the facts example loads, one fact reading the other", async () => {
    const lib = await loadLibrary(join(root, "examples", "rules"), noLog);
    expect(lib.facts.map((f) => f.id)).toEqual(["hallway-quiet", "heating-unattended"]);
    expect(lib.factSources.get("hallway-quiet")?.binding).toBe("hallwayQuiet");
    const [quiet, unattended] = lib.facts;
    const sim = simulate(unattended!, undefined, { "binary_sensor.hallway_motion": "on", "binary_sensor.boiler_heating": "on" }, { facts: [quiet!] });
    sim.set("binary_sensor.hallway_motion", "off").advance(minutes(15));
    expect(sim.fact("heating-unattended")).toEqual({ value: true, since: sim.now });
    sim.set("binary_sensor.boiler_heating", "off");
    expect(sim.fact("heating-unattended")?.value).toBe(false);
  });

  it("a broken custom file is skipped and logged, not fatal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-custom-"));
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "a-broken.js"), "export default { id: 'Bad Id' };");
    writeFileSync(join(dir, "heuristics", "b-clash.js"), "export default ({ defineHeuristic }) => defineHeuristic({ id: 'door-nag', title: 'x', watch: () => [], actuates: () => [], initial: () => ({}), decide: () => undefined, evolve: (s) => s });");
    const logged: string[] = [];
    const defs = await loadCustomHeuristics(dir, LIBRARY, (_l, m) => logged.push(m));
    expect(defs).toEqual([]);
    expect(logged.join("\n")).toMatch(/a-broken\.js.*missing "title"[\s\S]*b-clash\.js.*already defined/);
  });

  it('rule files import from "teobeanie", and "teob" (the old name) still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-names-"));
    mkdirSync(join(dir, "heuristics"));
    const body = (id: string) => `export default rule("${id}", ({ ha }) => ha.light.hallway.to("on"));\n`;
    writeFileSync(join(dir, "heuristics", "new-name.ts"), `import { rule } from "teobeanie";\n${body("new-name")}`);
    writeFileSync(join(dir, "heuristics", "old-name.ts"), `import { rule } from "teob";\n${body("old-name")}`);
    const logged: string[] = [];
    const defs = await loadCustomHeuristics(dir, LIBRARY, (l, m) => l !== "info" && l !== "debug" && logged.push(m));
    expect(logged).toEqual([]);
    expect(defs.map((d) => d.id).sort()).toEqual(["new-name", "old-name"]);
  });

  it("an instance of an unknown heuristic is skipped, not fatal", () => {
    const logged: string[] = [];
    const host = createHeuristicHost({
      library: LIBRARY,
      instances: [{ heuristic: "no-such-thing", id: "x", params: {} }],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
      liveState: () => undefined,
      forceShadow: true,
      log: (_l, m) => logged.push(m),
    });
    expect(host.instances()).toEqual([]);
    expect(logged[0]).toMatch(/unknown heuristic "no-such-thing"/);
  });
});
