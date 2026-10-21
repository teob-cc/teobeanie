// custom.ts — the heuristics a house runs live in its config folder, not in the image:
// CONFIG_DIR/packages/<name>/ (behaviour packages, src/packages/) and
// CONFIG_DIR/heuristics/*.ts (or .js, .mjs), loaded at startup and on every config
// reload (a file whose text changed is imported afresh); TypeScript runs
// through Node's type stripping, so there is no build step. A file imports what it
// needs from "teobeanie" (resolved here to the add-on's toolkit; "teob", its old name,
// still works) and default-exports a rule, a heuristic definition or a fact (fact.ts),
// or an array of them:
//
//   import { rule, keep, minutes } from "teobeanie";
//   export default rule("hallway-light", ({ ha, held }) => ha.light.hallway.to(...));
//
// A default export that is a function receives the toolkit instead (no import needed):
//
//   export default ({ defineHeuristic, notify, setTimer, minutes }) => defineHeuristic({ ... });

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as toolkit from "../toolkit.js";
import type { AnyHeuristic } from "./heuristic.js";
import { isFact, type AnyFact } from "./fact.js";

/** What a custom heuristic module's default-export function receives: the "teobeanie" module. */
export const TOOLKIT = toolkit;

export type Toolkit = typeof TOOLKIT;

// "teobeanie" (and "teob", its old name) → this add-on's toolkit module (toolkit.js
// when built, toolkit.ts from source).
export const TOOLKIT_SPECIFIERS: readonly string[] = ["teobeanie", "teob"];
const TOOLKIT_URL = new URL(`../toolkit${extname(fileURLToPath(import.meta.url))}`, import.meta.url).href;
let hooked = false;
function resolveToolkit(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve: (specifier, context, next) => {
      if (TOOLKIT_SPECIFIERS.includes(specifier)) return { url: TOOLKIT_URL, shortCircuit: true };
      const resolved = next(specifier, context);
      // A file imported afresh (?v=<hash>) imports its own files afresh too: a
      // package's helper module changes with the package.
      const version = /[?&]v=([0-9a-f]+)/.exec(context.parentURL ?? "")?.[1];
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (version !== undefined && relative && resolved.url.startsWith("file:") && !resolved.url.includes("?")) {
        return { ...resolved, url: `${resolved.url}?v=${version}` };
      }
      return resolved;
    },
  });
}

type Log = (level: "debug" | "info" | "warn" | "error", msg: string) => void;

const REQUIRED = ["id", "title", "watch", "actuates", "initial", "decide", "evolve"] as const;

function validate(def: unknown, file: string): AnyHeuristic {
  const d = def as Record<string, unknown> | null;
  if (typeof d !== "object" || d === null) throw new Error(`${file}: export is not a heuristic definition`);
  for (const key of REQUIRED) {
    if (d[key] === undefined) throw new Error(`${file}: heuristic is missing "${key}"`);
  }
  if (typeof d["id"] !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(d["id"])) {
    throw new Error(`${file}: id must be kebab-case (got ${JSON.stringify(d["id"])})`);
  }
  // A schema, if any, is the toolkit's: param.object({ ... }).
  const params = d["params"] as { spec?: { kind?: unknown } } | undefined;
  if (params !== undefined && params?.spec?.kind !== "object") {
    throw new Error(`${file}: params must be a schema made with param.object({ ... })`);
  }
  return d as unknown as AnyHeuristic;
}

/** A source file the loader picks: .ts, .js or .mjs, neither a declaration nor a test. */
export const isHeuristicSource = (f: string): boolean => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && !/\.test\.[jt]s$/.test(f);

/** One module to load: its path, and the name problems are reported under. */
export interface SourceModule {
  file: string;
  /** "door-nag.ts", "packages/door-watch/door-nag.ts" */
  label: string;
  /** The package's content hash: the module (and what it imports) is imported afresh when it changes. */
  version?: string;
}

/** A definition and the file that exported it. */
export interface Loaded {
  def: AnyHeuristic;
  file: string;
}

/** A fact and the file that exported it. */
export interface LoadedFact {
  fact: AnyFact;
  file: string;
}

/** Where loadModules collects the facts: the ids taken so far (added to), and the list. */
export interface FactSink {
  taken: Set<string>;
  out: LoadedFact[];
}

/**
 * What each file exported, by path and text: an unchanged file gives the same
 * definitions back (the host sees its instances as unchanged), an edited one is
 * imported under a new URL. A file of a package is imported afresh whenever any file
 * of the package changed; a module a heuristics/ file imports stays as first loaded.
 */
const loaded = new Map<string, { hash: string; exported: unknown }>();

const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Import modules and validate what they default-export. An id in `taken` (or one
 * exported twice) is an error; the ids loaded are added to it. A broken module is
 * logged and skipped; with `failures`, its reason is collected too (a reload then
 * rejects the whole config).
 */
export async function loadModules(modules: SourceModule[], taken: Set<string>, log: Log, failures?: string[], facts?: FactSink): Promise<Loaded[]> {
  resolveToolkit();
  const out: Loaded[] = [];
  for (const m of modules) {
    try {
      const own = digest(readFileSync(m.file));
      const hash = m.version === undefined ? own : digest(`${m.version}:${own}`);
      const cached = loaded.get(m.file)?.hash === hash;
      let exported = cached ? loaded.get(m.file)!.exported : undefined;
      if (!cached) {
        const mod = (await import(`${pathToFileURL(m.file).href}?v=${hash}`)) as { default?: unknown };
        exported = typeof mod.default === "function" ? (mod.default as (t: Toolkit) => unknown)(TOOLKIT) : mod.default;
        loaded.set(m.file, { hash, exported });
      }
      const items = Array.isArray(exported) ? exported : [exported];
      // Facts: collected where the caller takes them, else left alone.
      const factDefs = items.filter(isFact);
      const defs = items.filter((d) => !isFact(d)).map((d) => validate(d, m.label));
      const ids = new Set<string>();
      for (const def of defs) {
        if (taken.has(def.id) || ids.has(def.id)) throw new Error(`${m.label}: heuristic id "${def.id}" is already defined`);
        ids.add(def.id);
      }
      const factIds = new Set<string>();
      for (const f of factDefs) {
        if (typeof f.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(f.id)) throw new Error(`${m.label}: fact id must be kebab-case (got ${JSON.stringify(f.id)})`);
        if (facts?.taken.has(f.id) || factIds.has(f.id)) throw new Error(`${m.label}: fact id "${f.id}" is already defined`);
        factIds.add(f.id);
      }
      for (const def of defs) {
        taken.add(def.id);
        out.push({ def, file: m.file });
      }
      if (facts !== undefined) {
        for (const f of factDefs) {
          facts.taken.add(f.id);
          facts.out.push({ fact: f, file: m.file });
        }
      }
      if (!cached) log("info", `${m.label}: ${[...defs.map((d) => d.id), ...factDefs.map((f) => `fact ${f.id}`)].join(", ")}`);
    } catch (err) {
      const reason = (err as Error).message ?? String(err);
      log(failures === undefined ? "error" : "warn", `skipping ${m.file}: ${reason}`);
      failures?.push(reason.startsWith(`${m.label}:`) ? reason : `${m.label}: ${reason}`);
    }
  }
  return out;
}

/** The heuristics/*.ts|*.js|*.mjs files of a config folder, as modules to load. */
export function heuristicFiles(configDir: string): SourceModule[] {
  const dir = join(configDir, "heuristics");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isHeuristicSource)
    .sort()
    .map((f) => ({ file: join(dir, f), label: f }));
}

/**
 * Load every heuristics/*.ts|*.js|*.mjs in the config folder. A broken file is logged and
 * skipped (its instances then fail to resolve and are skipped too) — one bad file
 * must not take the add-on down with it. A reload passes `failures` to reject instead.
 * `taken`: definitions already loaded (the packages'), whose ids a file may not reuse.
 */
export async function loadCustomHeuristics(configDir: string, taken: AnyHeuristic[], log: Log, failures?: string[]): Promise<AnyHeuristic[]> {
  const defs = await loadModules(heuristicFiles(configDir), new Set(taken.map((h) => h.id)), log, failures);
  return defs.map((l) => l.def);
}
