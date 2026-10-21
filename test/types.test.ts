// Typed rules: the generated house types plus the "teob" module make misspelled ids,
// impossible states and wrong desired values compile errors — checked with tsc over a
// made-up house, the way a config folder (or the Studio) type-checks.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateHouseTypes, stateType } from "../src/studio/house-types.js";
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
  });

  it("rules type-check against the house, and mistakes are compile errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-types-"));
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "ha.d.ts"), generateHouseTypes(HOUSE, { operable: OPERABLE }));
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
]);
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
    // The examples are clean; every error is in the mistakes file, one per line 3–9.
    expect(errors.every((l) => l.includes("zz-mistakes.ts"))).toBe(true);
    expect(errors.map((l) => Number(/zz-mistakes\.ts\((\d+),/.exec(l)?.[1]))).toEqual([3, 4, 5, 6, 6, 7, 8, 9]);
    expect(out).toMatch(/Did you mean 'hallway'\?/);
    expect(out).toMatch(/light\.porch is outside the operation scope/);
  }, 30_000);
});
