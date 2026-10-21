// toolkit-types.ts — the "teobeanie" module's declarations (emitted by tsc next to the
// built JS), for editors: the Studio's language service and a config folder's own
// tsconfig. Paths are relative to the module root; "toolkit.d.ts" is the entry.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLKIT_DTS = ["toolkit.d.ts", "kernel/heuristic.d.ts", "kernel/rule.d.ts", "kernel/clock.d.ts", "kernel/params.d.ts"];

/** The declaration files, or undefined when running from source (no emitted .d.ts). */
export function toolkitTypes(): Record<string, string> | undefined {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (!TOOLKIT_DTS.every((f) => existsSync(join(root, f)))) return undefined;
  return Object.fromEntries(TOOLKIT_DTS.map((f) => [f, readFileSync(join(root, f), "utf8")]));
}

/** A tsconfig for a config folder: type-checks heuristics/*.ts and the packages against .teob/ and ha.d.ts. */
export const CONFIG_TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    types: [],
    // .teob/ and "teob" are the names from before the rename; existing folders use them.
    paths: { teobeanie: ["./.teob/toolkit.d.ts"], teob: ["./.teob/toolkit.d.ts"] },
  },
  // The packages' specs import "teobeanie/test", which has no declarations here: left out.
  include: ["heuristics/**/*.ts", "packages/**/*.ts"],
  exclude: ["packages/**/*.test.ts"],
};
