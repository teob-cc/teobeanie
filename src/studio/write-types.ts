// write-types.ts — the typings of a config folder, written into it: heuristics/ha.d.ts
// (the house scope, typed from the states given, and the facts the library defines),
// .teob/ (the "teobeanie" module's declarations and heuristics.schema.json, heuristics.json
// as a JSON Schema built from the heuristics' parameter schemas) and, when absent, a
// tsconfig.json. `cli.js types` writes them from Home Assistant's REST API, the `types`
// MCP tool from the add-on's live states. They are generated files, not part of the
// working set: writing them is no revision and reloads nothing.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import type { Library } from "../packages/library.js";
import { heuristicsJsonSchema } from "./config-schema.js";
import { factModule, generateHouseTypes } from "./house-types.js";
import { CONFIG_TSCONFIG, toolkitTypes } from "./toolkit-types.js";

export interface WrittenTypes {
  entities: number;
  operable: number;
  facts: number;
  /** The files written, relative to the folder. */
  files: string[];
  /** No emitted declarations next to the toolkit (a source checkout that was not built): .teob/ has only the schema. */
  noToolkit?: boolean;
}

export function writeTypes(dir: string, opts: { states: HaEntityState[]; operable: readonly string[]; library: Pick<Library, "heuristics" | "facts" | "factSources">; at?: number }): WrittenTypes {
  const files: string[] = [];
  const write = (rel: string, text: string): void => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    files.push(rel);
  };
  const lib = opts.library;
  const facts = lib.facts.map((f) => {
    const src = lib.factSources.get(f.id);
    const module = src === undefined ? undefined : factModule(join(dir, "heuristics"), src.file);
    return { id: f.id, title: f.title, ...(module !== undefined ? { module } : {}), ...(src?.binding !== undefined ? { binding: src.binding } : {}) };
  });
  write(join("heuristics", "ha.d.ts"), generateHouseTypes(opts.states, { at: opts.at ?? Date.now(), operable: opts.operable, facts }));
  const toolkit = toolkitTypes();
  for (const [file, text] of Object.entries(toolkit ?? {})) write(join(".teob", file), text);
  // heuristics.json's instances, checked by an editor as the loader checks them.
  write(join(".teob", "heuristics.schema.json"), `${JSON.stringify(heuristicsJsonSchema(lib.heuristics), null, 2)}\n`);
  if (!existsSync(join(dir, "tsconfig.json"))) write("tsconfig.json", `${JSON.stringify(CONFIG_TSCONFIG, null, 2)}\n`);
  return { entities: opts.states.length, operable: opts.operable.length, facts: facts.length, files, ...(toolkit === undefined ? { noToolkit: true } : {}) };
}
