// Typed rules: the generated house types plus the "teob" module make misspelled ids,
// impossible states and wrong desired values compile errors — checked with tsc over a
// made-up house, the way a config folder (or the Studio) type-checks.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factModule, generateHouseTypes, stateType } from "../src/studio/house-types.js";
import { CONFIG_TSCONFIG } from "../src/studio/toolkit-types.js";

const root = join(import.meta.dirname, "..");
const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}) => ({
  entity_id, state, attributes, last_changed: "", last_updated: "",
});
const HOUSE = [
  st("binary_sensor.hallway_motion", "off", { friendly_name: "Hallway motion", device_class: "motion" }),
  st("binary_sensor.boiler_heating", "off"),
  st("light.hallway", "off", { friendly_name: "Hallway */ ceiling" }),
  st("switch.circulation_pump", "off"),
  st("climate.living", "heat", { hvac_modes: ["off", "heat"] }),
  st("select.mode", "eco", { options: ["eco", "comfort"] }),
  st("sensor.lux", "1200", { unit_of_measurement: "lx" }),
  st("sun.sun", "above_horizon"),
  st("light.porch", "off"),
];
/** Everything but light.porch: in the house, not in its operation scope. */
const OPERABLE = ["light.hallway", "switch.circulation_pump", "climate.living", "select.mode"];

describe("house types", () => {
  it("state unions come from the domain and the entity's attributes", () => {
    expect(stateType(HOUSE[2]!)).toBe(`"on" | "off"`);
    expect(stateType(HOUSE[4]!)).toBe(`"off" | "heat"`);
    expect(stateType(HOUSE[5]!)).toBe(`"eco" | "comfort"`);
    expect(stateType(HOUSE[6]!)).toBe("string");
    const dts = generateHouseTypes(HOUSE);
    expect(dts).toContain(`/** Hallway motion · motion */\n    "binary_sensor.hallway_motion": "on" | "off";`);
    expect(dts).toContain("/** Hallway * / ceiling */"); // a name cannot end the comment
    expect(dts).not.toContain("TeobFacts"); // no facts: ha.facts takes any name
    const withFacts = generateHouseTypes(HOUSE, { facts: [{ id: "quiet", title: "Quiet */ now", module: "./q", binding: "quiet" }, { id: "raw", module: "./r" }, { id: "dflt", module: "../packages/p/d", binding: "default" }] });
    expect(withFacts).toContain(`  interface TeobFacts {
    "dflt": import("teobeanie").FactValue<typeof import("../packages/p/d").default>;
    /** Quiet * / now */
    "quiet": import("teobeanie").FactValue<typeof import("./q").quiet>;
    "raw": import("teobeanie").Json;
  }`);
    expect([factModule("/c/heuristics", "/c/heuristics/a.ts"), factModule("/c/heuristics", "/c/packages/p/b.ts"), factModule("/c", "/c/heuristics/a.ts"), factModule("/c", "/c/x.mjs")]).toEqual([
      "./a",
      "../packages/p/b",
      "./heuristics/a",
      undefined,
    ]);
  });

  it("rules type-check against the house, and mistakes are compile errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-types-"));
    mkdirSync(join(dir, "heuristics"));
    const facts = [
      { id: "hallway-quiet", title: "Nobody in the hallway for 15 minutes", module: factModule(join(dir, "heuristics"), join(dir, "heuristics", "house-facts.ts")), binding: "hallwayQuiet" },
      { id: "heating-unattended", module: "./house-facts", binding: "heatingUnattended" },
      // In an array only (no name): any JSON value.
      { id: "js-fact", module: "./house-facts" },
      { id: "lights-out", module: "./zz-facts", binding: "lightsOut" },
    ];
    writeFileSync(join(dir, "heuristics", "ha.d.ts"), generateHouseTypes(HOUSE, { operable: OPERABLE, facts }));
    cpSync(join(root, "examples", "rules", "heuristics"), join(dir, "heuristics"), { recursive: true });
    writeFileSync(
      join(dir, "heuristics", "zz-mistakes.ts"),
      `import { rule } from "teob";
export default rule("mistakes", ({ ha, entity }) => [
  ha.light.halway.to("on"),
  ha.light.hallway.to("purple"),
  ha.climate.living.to({ hvac_mode: "cool" }),
  ha.select.mode.to(ha.binary_sensor.hallway_motion.is("open") ? "eco" : "turbo"),
  ha.sensor.lux.to("on"),
  entity("switch.circulation_pmp").to("on"),
  ha.light.porch.to("on"),
  ha.light.hallway.to(ha.facts.hallwayQuite.is(true) ? "off" : "on"),
  ha.light.hallway.to(ha.facts.hallway_quiet.is("yes") || ha.facts.lightsOut.is("dim") ? "off" : "on"),
]);
`,
    );
    // Facts read the right way: by camelCase and snake_case name, typed from their module.
    writeFileSync(
      join(dir, "heuristics", "zz-facts.ts"),
      `import { defineHeuristic, fact, keep, rule } from "teobeanie";
// A fact and a rule that reads it, in one file.
export const lightsOut = fact("lights-out", ({ ha }) => (ha.facts.heating_unattended.value === true && ha.facts.jsFact.value !== null ? "dark" : "lit"));
export default [
  lightsOut,
  rule("quiet-light", ({ ha }) => ha.light.hallway.to(ha.facts.hallwayQuiet.value === true || ha.facts.lightsOut.is("dark") ? "off" : keep)),
  defineHeuristic<void, null, never>({
    id: "reads-a-fact", title: "x", description: "", watch: () => [], facts: () => ["hallway-quiet"], actuates: () => [], initial: () => null,
    decide: (_s, _i, ctx) => {
      const q: boolean | undefined = ctx.fact("hallway-quiet")?.value;
      return q ? { why: "quiet" } : undefined;
    },
    evolve: (s) => s,
  }),
];
`,
    );
    const tsconfig = structuredClone(CONFIG_TSCONFIG) as typeof CONFIG_TSCONFIG & { compilerOptions: { paths: Record<string, string[]> } };
    // The examples import "teobeanie", the mistakes file "teob" (the old name): both resolve.
    tsconfig.compilerOptions.paths = { teobeanie: [join(root, "src", "toolkit.ts")], teob: [join(root, "src", "toolkit.ts")] };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));

    let out = "";
    try {
      execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", dir], { encoding: "utf8" });
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? err);
    }
    const errors = out.split("\n").filter((l) => /error TS/.test(l));
    // The examples are clean; every error is in the mistakes file, one per line 3–11, two on 11
    // (a boolean fact is not "yes"; lights-out is "dark" or "lit", typed from its module).
    expect(errors.filter((l) => !l.includes("zz-mistakes.ts"))).toEqual([]);
    expect(errors.map((l) => Number(/zz-mistakes\.ts\((\d+),/.exec(l)?.[1]))).toEqual([3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 11]);
    expect(out).toMatch(/"dim"/);
    expect(out).toMatch(/Did you mean 'hallwayQuiet'\?/);
    expect(out).toMatch(/Did you mean 'hallway'\?/);
    expect(out).toMatch(/light\.porch is outside the operation scope/);
  }, 30_000);
});
