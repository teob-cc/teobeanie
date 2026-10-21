// The add-on's own spec runner (test_run, the Studio's matchers): the starter packages'
// specs pass there as under vitest, a failing spec says why, a loop is stopped, and an
// import outside the config folder is refused.

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect as vexpect, it } from "vitest";
import { STARTER_DIR, starterPackages } from "../src/packages/library.js";
import { expect } from "../src/testing/expect.js";
import { runSpecs, specFilesUnder } from "../src/testing/spec-runner.js";

const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "teobeanie-specs-"));
  mkdirSync(join(dir, "packages"));
  return dir;
};

describe("runSpecs", () => {
  it("runs every starter package's specs green, as vitest does", async () => {
    const dir = folder();
    cpSync(STARTER_DIR, join(dir, "packages"), { recursive: true });
    const files = specFilesUnder(dir, "packages");
    vexpect(files.length).toBe(starterPackages().length);
    const run = await runSpecs({ configDir: dir, files });
    vexpect(run.loadErrors).toEqual([]);
    vexpect(run.specs.filter((s) => !s.ok)).toEqual([]);
    vexpect(run.passed).toBeGreaterThan(50);
  });

  it("reports a failing spec with its message, and the others pass", async () => {
    const dir = folder();
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "two.ts"), `export const two = (): number => 2;\n`);
    writeFileSync(
      join(dir, "heuristics", "two.test.ts"),
      `import { describe, expect, it } from "teobeanie/test";\nimport { minutes } from "teobeanie";\nimport { two } from "./two.ts";\n` +
        `describe("two", () => {\n  it("is two", () => expect(two()).toBe(2));\n  it("is three", () => expect(two()).toBe(3));\n  it("a minute", () => expect(minutes(1)).toEqual(60000));\n});\n`,
    );
    const run = await runSpecs({ configDir: dir, files: ["heuristics/two.test.ts"] });
    vexpect(run.passed).toBe(2);
    vexpect(run.failed).toBe(1);
    vexpect(run.specs.find((s) => !s.ok)).toMatchObject({ name: "two › is three", error: "expected 2 to be 3" });
  });

  it("stops a spec that loops, and refuses imports outside the config folder", async () => {
    const dir = folder();
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "loop.test.ts"), `import { it } from "teobeanie/test";\nit("loops", () => { for (;;) {} });\n`);
    writeFileSync(join(dir, "heuristics", "fs.test.ts"), `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`);
    writeFileSync(join(dir, "heuristics", "up.test.ts"), `import x from "../../etc/passwd";\nexport default x;\n`);
    const loose = await runSpecs({ configDir: dir, files: ["heuristics/fs.test.ts", "heuristics/up.test.ts"] });
    vexpect(loose.loadErrors.map((e) => e.error)).toEqual([
      'heuristics/fs.test.ts: cannot import "node:fs" (only "teobeanie", "teobeanie/test" and files in the config folder)',
      'heuristics/up.test.ts: cannot import "../../etc/passwd" (only "teobeanie", "teobeanie/test" and files in the config folder)',
    ]);
    const loop = await runSpecs({ configDir: dir, files: ["heuristics/loop.test.ts"], timeoutMs: 300 });
    vexpect(loop.timedOut).toBe(true);
    vexpect(loop.failed).toBe(1);
  });
});

describe("expect (vitest's matchers)", () => {
  const fails = (f: () => void, message: RegExp): void => vexpect(f).toThrow(message);

  it("compares as vitest does", () => {
    expect({ a: 1, b: undefined }).toEqual({ a: 1 });
    fails(() => expect({ a: 1, b: undefined }).toStrictEqual({ a: 1 }), /strictly equal/);
    expect({ a: 1, b: { c: [1, 2], d: "x" } }).toMatchObject({ b: { c: [1, 2] } });
    fails(() => expect({ a: 1 }).toMatchObject({ a: 2 }), /to match object/);
    expect([{ a: 1 }, { a: 2 }]).toContainEqual({ a: 2 });
    expect([1, 2]).toContain(2);
    fails(() => expect([{ a: 1 }]).toContain({ a: 1 }), /to contain/);
    expect(["a small use", "a correction", "x"]).toEqual(expect.arrayContaining(["x", "a small use"]));
    expect({ at: 5, why: "door open" }).toEqual({ at: expect.any(Number), why: expect.stringContaining("open") });
    expect({ a: { b: [1, { c: 3 }] } }).toHaveProperty("a.b[1].c", 3);
    expect(undefined).toBeUndefined();
    expect(null).toBeNull();
    expect(0.1 + 0.2).toBeCloseTo(0.3);
    expect(3).toBeGreaterThan(2);
    expect(() => {
      throw new Error("no way");
    }).toThrow(/no/);
    expect(1).not.toBe(2);
    fails(() => expect(1, "the count").toBe(2), /^the count: expected 1 to be 2$/);
  });
});
