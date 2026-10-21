import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllowlist } from "../src/allowlist.js";
import { filesUnder, initWorkingSet, STARTER_DIR, starterFiles } from "../src/studio/init.js";
import { CONFIG_TSCONFIG } from "../src/studio/toolkit-types.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "teobeanie-init-"));

describe("teobeanie init", () => {
  it("writes exactly examples/starter (the .teob/ declarations aside: they need a build)", () => {
    const dir = join(tmp(), "house");
    const r = initWorkingSet(dir);
    expect(r.entities).toBe(loadAllowlist(STARTER_DIR, () => {}).scope.observed.length);
    const written = filesUnder(dir)
      .filter((f) => !f.startsWith(".teob/") && !f.startsWith("packages/") && f !== "teobeanie.lock.json")
      .sort();
    expect(written).toEqual(filesUnder(STARTER_DIR).sort());
    for (const f of written) expect(readFileSync(join(dir, f), "utf8"), f).toBe(readFileSync(join(STARTER_DIR, f), "utf8"));
    expect(Object.keys(starterFiles())).toEqual(expect.arrayContaining(["README.md", "heuristics.json", "allowlist.json", "tiles.json", "tsconfig.json"]));
  });

  it("the starter's tsconfig is the config folder's, with the tests left out (they run in the Studio)", () => {
    const tsconfig = JSON.parse(readFileSync(join(STARTER_DIR, "tsconfig.json"), "utf8")) as Record<string, unknown>;
    expect(tsconfig).toEqual({ ...CONFIG_TSCONFIG, exclude: ["heuristics/**/*.test.ts", "packages/**/*.test.ts"] });
  });

  it("types the operable entities", () => {
    const dts = readFileSync(join(STARTER_DIR, "heuristics", "ha.d.ts"), "utf8");
    expect(dts).toContain('"light.hallway_night": true;');
    expect(dts).not.toContain('"sensor.indoor_co2": true;');
  });

  it("refuses a folder that is not empty, writing nothing; --force overwrites and keeps other files", () => {
    const dir = tmp();
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics.json"), "mine");
    writeFileSync(join(dir, "heuristics", "own.ts"), "mine");
    expect(() => initWorkingSet(dir)).toThrow(/not empty.*--force/);
    expect(filesUnder(dir).sort()).toEqual(["heuristics.json", "heuristics/own.ts"]);
    expect(readFileSync(join(dir, "heuristics.json"), "utf8")).toBe("mine");
    initWorkingSet(dir, { force: true });
    expect(readFileSync(join(dir, "heuristics.json"), "utf8")).toBe(readFileSync(join(STARTER_DIR, "heuristics.json"), "utf8"));
    expect(readFileSync(join(dir, "heuristics", "own.ts"), "utf8")).toBe("mine");
  });

  it("accepts an empty folder and one that holds only a .git", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));
    expect(() => initWorkingSet(dir)).not.toThrow();
    expect(() => initWorkingSet(tmp())).not.toThrow();
  });
});
