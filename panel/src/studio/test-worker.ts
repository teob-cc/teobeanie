// test-worker.ts — runs the Studio's files: every source is loaded the way the add-on
// loads it (and its rules probed for what they own and watch), and every *.test.ts
// runs against the add-on's own rule runtime and simulator. A worker, so a rule
// that loops can be stopped without freezing the panel.

import { transform } from "sucrase";
import * as toolkit from "../../../src/toolkit";
import type { AnyHeuristic } from "../../../src/kernel/heuristic";
import { createTestApi } from "./test-api";
import type { LoadResult, LoadedHeuristic, RunRequest, RunResult, TestResult } from "./protocol";

const TEST_FILE = /\.test\.(ts|js|mjs)$/;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function run(files: Record<string, string>): RunResult {
  const t0 = performance.now();
  // One module registry per run: a test file and the rule it imports share instances.
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  let testApi = createTestApi();

  const resolve = (spec: string): string | undefined => {
    const bare = spec.replace(/^\.\//, "");
    return [bare, `${bare}.ts`, `${bare}.js`, `${bare}.mjs`].find((n) => n in files);
  };

  const load = (name: string): Record<string, unknown> => {
    const hit = cache.get(name);
    if (hit) return hit.exports;
    const { code } = transform(files[name]!, { transforms: ["typescript", "imports"], filePath: name, production: true });
    const module = { exports: {} as Record<string, unknown> };
    cache.set(name, module);
    const require = (spec: string): unknown => {
      // "teob" and "teob/test": the names from before the rename to Teobeanie.
      if (spec === "teobeanie" || spec === "teob") return { __esModule: true, ...toolkit };
      if (spec === "teobeanie/test" || spec === "teob/test") return testApi.module;
      const target = spec.startsWith("./") ? resolve(spec) : undefined;
      if (target === undefined) throw new Error(`${name}: cannot import "${spec}" (only "teobeanie", "teobeanie/test" and ./files here)`);
      return load(target);
    };
    new Function("exports", "require", "module", code)(module.exports, require, module);
    return module.exports;
  };

  // The add-on's loader: a definition, an array, or a function of the toolkit.
  const definitions = (exports: Record<string, unknown>): AnyHeuristic[] => {
    const d = exports["default"];
    const v = typeof d === "function" ? (d as (t: typeof toolkit) => unknown)(toolkit) : d;
    const list = (Array.isArray(v) ? v : [v]) as AnyHeuristic[];
    for (const h of list) {
      if (typeof h !== "object" || h === null || typeof h.id !== "string" || typeof h.decide !== "function") {
        throw new Error("the default export is not a rule or heuristic definition");
      }
    }
    return list;
  };

  const describe = (h: AnyHeuristic): LoadedHeuristic => {
    const base = { id: h.id, kind: h.kind === "rule" ? ("rule" as const) : ("decider" as const) };
    try {
      return { ...base, owns: h.actuates({}), watches: h.watch({}) };
    } catch (e) {
      return { ...base, owns: null, watches: null, note: `needs params from heuristics.json (${errText(e)})` };
    }
  };

  const loads: LoadResult[] = [];
  for (const file of Object.keys(files).filter((f) => !TEST_FILE.test(f)).sort()) {
    try {
      loads.push({ file, ok: true, heuristics: definitions(load(file)).map(describe) });
    } catch (e) {
      loads.push({ file, ok: false, error: errText(e) });
    }
  }

  const tests: TestResult[] = [];
  for (const file of Object.keys(files).filter((f) => TEST_FILE.test(f)).sort()) {
    testApi = createTestApi();
    try {
      load(file);
    } catch (e) {
      tests.push({ file, name: "(loading the test file)", ok: false, error: errText(e), ms: 0 });
      continue;
    }
    for (const t of testApi.tests) {
      const start = performance.now();
      try {
        t.fn();
        tests.push({ file, name: t.name, ok: true, ms: performance.now() - start });
      } catch (e) {
        tests.push({ file, name: t.name, ok: false, error: errText(e), ms: performance.now() - start });
      }
    }
  }
  return { loads, tests, ms: performance.now() - t0 };
}

self.onmessage = (ev: MessageEvent<RunRequest>) => {
  self.postMessage(run(ev.data.files));
};
