import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const toolkit = fileURLToPath(new URL("./src/toolkit.ts", import.meta.url));
const testing = fileURLToPath(new URL("./test/teobeanie-test.ts", import.meta.url));
const extra = process.env["TEOBEANIE_PACKAGES"] !== undefined ? resolve(process.env["TEOBEANIE_PACKAGES"]) : undefined;

export default defineConfig({
  // Rule files and packages import from "teobeanie" ("teob", its old name, too), their
  // specs from "teobeanie/test"; in the add-on the custom loader resolves them.
  resolve: {
    alias: [
      { find: /^(teobeanie|teob)\/test$/, replacement: testing },
      { find: /^(teobeanie|teob)$/, replacement: toolkit },
    ],
  },
  // Agent worktrees live under .claude/worktrees: their tests are theirs. Tests in examples/
  // are for the Studio ("teobeanie/test"); test/examples.test.ts runs the same checks here.
  // packages/*/ holds the starter packages, each with its specs. TEOBEANIE_PACKAGES names
  // another folder of packages to run the specs of (a house's own, in its config repo):
  //   TEOBEANIE_PACKAGES=../my-house/packages pnpm vitest run
  test: {
    include: ["test/**/*.test.ts", "packages/**/*.test.ts", ...(extra !== undefined ? [`${extra}/**/*.test.ts`] : [])],
    exclude: [...configDefaults.exclude, ".claude/**", "examples/**"],
  },
});
