// teobeanie-test.ts — the "teobeanie/test" module under vitest: a package's specs
// (packages/*/*.test.ts) import describe, it, test and expect from here, with the
// kernel's own simulate(). In the Studio the same names come from its test worker
// (panel/src/studio/test-api.ts), which knows a subset of the matchers.

export { describe, expect, it, test } from "vitest";
export { simulate, type Sim, type SimOptions } from "../src/kernel/simulate.js";
