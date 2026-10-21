// test-api.ts — the "teobeanie/test" module inside the Studio's test worker: test(),
// a small expect(), and simulate() — the add-on's own simulator, so a test runs the
// exact decideStep the house runs.

import { simulate as simulateKernel, type Sim } from "../../../src/kernel/simulate";
import type { AnyHeuristic } from "../../../src/kernel/heuristic";

export interface RegisteredTest {
  name: string;
  fn: () => unknown;
}

const show = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "symbol") return v.description ?? "symbol";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface Matchers {
  toBe(v: unknown): void;
  toEqual(v: unknown): void;
  toHaveLength(n: number): void;
  toContain(v: unknown): void;
  toMatch(re: RegExp | string): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toThrow(re?: RegExp | string): void;
  readonly not: Matchers;
}

function matchers(actual: unknown, negate: boolean): Matchers {
  const check = (pass: boolean, what: string): void => {
    if (pass === negate) throw new Error(`expected ${show(actual)} ${negate ? "not " : ""}${what}`);
  };
  return {
    toBe: (v) => check(Object.is(actual, v), `to be ${show(v)}`),
    toEqual: (v) => check(equal(actual, v), `to equal ${show(v)}`),
    toHaveLength: (n) => check((actual as { length?: number })?.length === n, `to have length ${n}`),
    toContain: (v) =>
      check(
        typeof actual === "string" ? actual.includes(String(v)) : Array.isArray(actual) && actual.some((x) => equal(x, v)),
        `to contain ${show(v)}`,
      ),
    toMatch: (re) => check(typeof actual === "string" && (typeof re === "string" ? actual.includes(re) : re.test(actual)), `to match ${String(re)}`),
    toBeTruthy: () => check(Boolean(actual), "to be truthy"),
    toBeFalsy: () => check(!actual, "to be falsy"),
    toThrow: (re) => {
      let threw: unknown;
      try {
        (actual as () => unknown)();
      } catch (e) {
        threw = e;
      }
      const msg = threw instanceof Error ? threw.message : String(threw);
      const ok = threw !== undefined && (re === undefined || (typeof re === "string" ? msg.includes(re) : re.test(msg)));
      if (ok === negate) throw new Error(negate ? `expected no throw, got "${msg}"` : `expected a throw${re ? ` matching ${String(re)}` : ""}, ${threw === undefined ? "got none" : `got "${msg}"`}`);
    },
    get not() {
      return matchers(actual, !negate);
    },
  };
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
      expect: (actual: unknown) => matchers(actual, false),
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
