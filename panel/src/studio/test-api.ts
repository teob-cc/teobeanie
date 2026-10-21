// test-api.ts — the "teobeanie/test" module inside the Studio's test worker: test(),
// expect() with vitest's matchers (src/testing/expect.ts, the same the add-on's test_run
// tool uses), and simulate() — the add-on's own simulator, so a test runs the exact
// decideStep the house runs.

import { simulate as simulateKernel, type Sim } from "../../../src/kernel/simulate";
import type { AnyHeuristic } from "../../../src/kernel/heuristic";
import { expect } from "../../../src/testing/expect";

export interface RegisteredTest {
  name: string;
  fn: () => unknown;
}

/** A fresh "teobeanie/test" module; tests registered through it are collected in `tests`. */
export function createTestApi() {
  const tests: RegisteredTest[] = [];
  // describe() names the tests inside it, as a package's specs (vitest in the repository) write them.
  const scope: string[] = [];
  const test = (name: string, fn: () => unknown) => void tests.push({ name: [...scope, name].join(" › "), fn });
  return {
    tests,
    module: {
      __esModule: true,
      test,
      it: test,
      describe: (name: string, fn: () => void) => {
        scope.push(name);
        try {
          fn();
        } finally {
          scope.pop();
        }
      },
      expect,
      simulate: (
        def: AnyHeuristic,
        params?: unknown,
        world?: Record<string, string>,
        opts: { t0?: number | string; mode?: "active" | "shadow" } = {},
      ): Sim<unknown> =>
        simulateKernel(def, params, world ?? {}, {
          ...(opts.mode ? { mode: opts.mode } : {}),
          ...(opts.t0 !== undefined ? { t0: typeof opts.t0 === "string" ? Date.parse(opts.t0) : opts.t0 } : {}),
        }),
    },
  };
}
