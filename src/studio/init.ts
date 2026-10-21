// init.ts — `teobeanie init <folder>`: a starter working set. The files are
// examples/starter (the README, the three JSON files, a sample rule with its test,
// tsconfig.json) and the starter packages (packages/, locked as the add-on locks them);
// what is generated is the typings, written for the starter's own
// allowlist because there is no Home Assistant to ask. The same folder is the add-on's
// example, so what init writes and what examples/starter holds cannot drift apart (a test
// compares them).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import { loadAllowlist } from "../allowlist.js";
import { generateHouseTypes } from "./house-types.js";
import { toolkitTypes } from "./toolkit-types.js";
import { installStarter } from "../packages/library.js";

export const STARTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "starter");

/** Generated, not copied: the typings of this folder's scope and of the "teobeanie" module. */
export const GENERATED = ["heuristics/ha.d.ts", ".teob"];

const isGenerated = (path: string): boolean => GENERATED.some((g) => path === g || path.startsWith(`${g}/`));

/** Every file under a folder, as slash-separated paths relative to it. */
export function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(root, join(dir, e.name)) : [relative(root, join(dir, e.name)).split("\\").join("/")],
  );
}

/** The starter's files as written by init (the generated ones left out), path → text. */
export function starterFiles(starterDir = STARTER_DIR): Record<string, string> {
  return Object.fromEntries(
    filesUnder(starterDir)
      .filter((f) => !isGenerated(f))
      .sort()
      .map((f) => [f, readFileSync(join(starterDir, f), "utf8")]),
  );
}

/** The typings of a folder's allowlist.json scope, with no Home Assistant to give states or attributes. */
export function scopeTypes(folder: string): string {
  const scope = loadAllowlist(folder, () => {}).scope;
  const states: HaEntityState[] = scope.observed.map((entity_id) => ({ entity_id, state: "unknown", attributes: {} }) as HaEntityState);
  return generateHouseTypes(states, { operable: scope.operated });
}

export interface InitResult {
  written: string[];
  entities: number;
  operable: number;
  /** The starter packages installed into packages/ (and locked in teobeanie.lock.json). */
  packages: string[];
  /** False when running from source: the "teobeanie" module's declarations need a build. */
  toolkit: boolean;
}

/**
 * Write a starter working set into `folder`. A folder that holds anything but a `.git`
 * is refused unless `force`; with it, files of the same name are overwritten and others
 * are left alone.
 */
export function initWorkingSet(folder: string, opts: { force?: boolean; starterDir?: string; packagesDir?: string } = {}): InitResult {
  if (existsSync(folder) && !opts.force && readdirSync(folder).some((f) => f !== ".git")) {
    throw new Error(`${folder} is not empty: pass --force to write the starter files into it (files of the same name are overwritten)`);
  }
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };
  const written: string[] = [];
  for (const [path, text] of Object.entries(starterFiles(opts.starterDir))) {
    write(path, text);
    written.push(path);
  }
  const scope = loadAllowlist(folder, () => {}).scope;
  write("heuristics/ha.d.ts", scopeTypes(folder));
  written.push("heuristics/ha.d.ts");
  const toolkit = toolkitTypes();
  for (const [file, text] of Object.entries(toolkit ?? {})) {
    write(`.teob/${file}`, text);
    written.push(`.teob/${file}`);
  }
  // The behaviour packages, as the add-on installs them on start.
  const { installed } = installStarter(folder, opts.packagesDir !== undefined ? { starterDir: opts.packagesDir } : {});
  return { written, packages: installed, entities: scope.observed.length, operable: scope.operated.length, toolkit: toolkit !== undefined };
}
