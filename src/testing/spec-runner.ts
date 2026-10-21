// spec-runner.ts — run a working set's specs inside the add-on, the way the Studio's
// test worker runs them in the browser: each file compiled from TypeScript on the spot
// (sucrase), its imports resolved here ("teobeanie" to the toolkit, "teobeanie/test" to
// describe, it, test, expect and the kernel's own simulate, "./file" inside the config
// folder, nothing else), and every test run against the same decideStep the house
// runs. The matchers are vitest's (expect.ts), so a spec green here is green under
// vitest in the repository too.
//
// Nothing is imported into the add-on's module graph: a run loads its files afresh and
// leaves nothing behind. A run is limited in time (a spec that loops is stopped), and
// runs go one at a time.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import vm from "node:vm";
import { transform } from "sucrase";
import { TOOLKIT } from "../kernel/custom.js";
import { simulate } from "../kernel/simulate.js";
import { expect } from "./expect.js";

/** A spec file: *.test.ts, *.test.js or *.test.mjs. */
export const SPEC_FILE = /\.test\.(ts|js|mjs)$/;

export interface SpecResult {
  /** The spec file, relative to the config folder. */
  file: string;
  /** "describe › it". */
  name: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  ms: number;
}

export interface SpecRun {
  files: string[];
  specs: SpecResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** Files that did not load (a syntax error, an import that is not allowed), with the reason. */
  loadErrors: Array<{ file: string; error: string }>;
  /** The run hit its time limit; what ran before it is reported. */
  timedOut?: boolean;
  ms: number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Registered {
  name: string;
  fn?: () => unknown;
  skip: boolean;
}

/** The "teobeanie/test" module of one file: what its describe/it/test register. */
function testModule(tests: Registered[]) {
  const scope: string[] = [];
  const before: Array<Array<() => unknown>> = [[]];
  const after: Array<Array<() => unknown>> = [[]];
  const register = (name: string, fn: (() => unknown) | undefined, skip: boolean): void => {
    const hooksBefore = before.flat();
    const hooksAfter = after.flat().reverse();
    tests.push({
      name: [...scope, name].join(" › "),
      skip,
      ...(fn !== undefined
        ? {
            fn: () => {
              for (const h of hooksBefore) h();
              try {
                return fn();
              } finally {
                for (const h of hooksAfter) h();
              }
            },
          }
        : {}),
    });
  };
  const test = Object.assign((name: string, fn: () => unknown) => register(name, fn, false), {
    skip: (name: string, fn?: () => unknown) => register(name, fn, true),
    todo: (name: string) => register(name, undefined, true),
  });
  const describe = Object.assign(
    (name: string, fn: () => void) => {
      scope.push(name);
      before.push([]);
      after.push([]);
      try {
        fn();
      } finally {
        scope.pop();
        before.pop();
        after.pop();
      }
    },
    { skip: (name: string) => register(`${name} (skipped)`, undefined, true) },
  );
  return {
    __esModule: true,
    test,
    it: test,
    describe,
    expect,
    simulate,
    beforeEach: (fn: () => unknown) => void before.at(-1)!.push(fn),
    afterEach: (fn: () => unknown) => void after.at(-1)!.push(fn),
  };
}

/** The spec files under a folder of the config folder, relative to it, sorted. */
export function specFilesUnder(configDir: string, sub: string): string[] {
  const dir = join(configDir, sub);
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return SPEC_FILE.test(sub) ? [sub] : [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => (e.isDirectory() ? specFilesUnder(configDir, `${sub}/${e.name}`) : SPEC_FILE.test(e.name) ? [`${sub}/${e.name}`] : []))
    .sort();
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run spec files (paths relative to the config folder) and report each test. A file may
 * import "teobeanie", "teobeanie/test" ("teob", "teob/test") and files inside the
 * config folder. `timeoutMs` bounds the whole run (default 20 s).
 */
export function runSpecs(opts: { configDir: string; files: string[]; timeoutMs?: number }): Promise<SpecRun> {
  const run = queue.then(() => runNow(opts));
  queue = run.catch(() => undefined);
  return run;
}

async function runNow(opts: { configDir: string; files: string[]; timeoutMs?: number }): Promise<SpecRun> {
  const t0 = performance.now();
  const root = resolve(opts.configDir);
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const specs: SpecResult[] = [];
  const loadErrors: SpecRun["loadErrors"] = [];
  const pending: Array<{ result: SpecResult; promise: Promise<unknown>; start: number }> = [];
  let timedOut = false;

  // One module registry per run: a spec and the code it imports share their instances.
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  let current: ReturnType<typeof testModule> | undefined;

  const inside = (abs: string): boolean => abs === root || abs.startsWith(root + sep);
  const resolveFile = (from: string, spec: string): string | undefined => {
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.js`, `${base}.mjs`].find((p) => inside(p) && existsSync(p) && statSync(p).isFile());
  };
  const load = (abs: string): Record<string, unknown> => {
    const hit = cache.get(abs);
    if (hit !== undefined) return hit.exports;
    const label = relative(root, abs).split(sep).join("/");
    const { code } = transform(readFileSync(abs, "utf8"), { transforms: ["typescript", "imports"], filePath: abs, production: true });
    const module = { exports: {} as Record<string, unknown> };
    cache.set(abs, module);
    const require = (spec: string): unknown => {
      if (spec === "teobeanie" || spec === "teob") return { __esModule: true, ...TOOLKIT };
      if (spec === "teobeanie/test" || spec === "teob/test") {
        if (current === undefined) throw new Error(`${label}: "teobeanie/test" is for spec files`);
        return current;
      }
      const target = spec.startsWith("./") || spec.startsWith("../") ? resolveFile(abs, spec) : undefined;
      if (target === undefined) throw new Error(`${label}: cannot import "${spec}" (only "teobeanie", "teobeanie/test" and files in the config folder)`);
      return load(target);
    };
    new Function("exports", "require", "module", code)(module.exports, require, module);
    return module.exports;
  };

  const runFile = (file: string): void => {
    const abs = resolve(root, file);
    const tests: Registered[] = [];
    current = testModule(tests);
    try {
      if (!inside(abs) || !existsSync(abs)) throw new Error("no such file in the config folder");
      load(abs);
    } catch (e) {
      loadErrors.push({ file, error: errText(e) });
      specs.push({ file, name: "(loading the spec file)", ok: false, error: errText(e), ms: 0 });
      return;
    } finally {
      current = undefined;
    }
    for (const t of tests) {
      if (t.skip || t.fn === undefined) {
        specs.push({ file, name: t.name, ok: true, skipped: true, ms: 0 });
        continue;
      }
      const start = performance.now();
      const result: SpecResult = { file, name: t.name, ok: true, ms: 0 };
      specs.push(result);
      try {
        const out = t.fn();
        if (typeof (out as { then?: unknown } | undefined)?.then === "function") pending.push({ result, promise: out as Promise<unknown>, start });
      } catch (e) {
        result.ok = false;
        result.error = errText(e);
      }
      result.ms = performance.now() - start;
    }
  };

  for (const file of opts.files) {
    const left = deadline - Date.now();
    if (left <= 0) {
      timedOut = true;
      break;
    }
    try {
      // Synchronous code is stopped at the deadline, a loop in a spec or in the code it tests too.
      vm.runInNewContext("run()", { run: () => runFile(file) }, { timeout: left });
    } catch (e) {
      if ((e as { code?: string }).code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") throw e;
      timedOut = true;
      specs.push({ file, name: "(time limit)", ok: false, error: `stopped after ${opts.timeoutMs ?? 20_000} ms: a spec or the code it tests does not finish`, ms: 0 });
      break;
    }
  }
  // Async specs: awaited within what is left of the time.
  for (const p of pending) {
    const left = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([p.promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), left)))]);
    } catch (e) {
      p.result.ok = false;
      p.result.error = errText(e);
      if (errText(e) === "timed out") timedOut = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    p.result.ms = performance.now() - p.start;
  }

  const ran = specs.filter((s) => !s.skipped);
  return {
    files: opts.files,
    specs,
    passed: ran.filter((s) => s.ok).length,
    failed: ran.filter((s) => !s.ok).length,
    skipped: specs.length - ran.length,
    loadErrors,
    ...(timedOut ? { timedOut } : {}),
    ms: performance.now() - t0,
  };
}
