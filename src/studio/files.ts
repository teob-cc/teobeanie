// files.ts — the Studio's view of the config folder: the rule and heuristic sources
// in heuristics/, read and written as plain files (so a private git repository and a
// deploy script keep working), plus the types the editor checks them against. The
// behaviour packages in packages/ are listed and read, not written, here.
//
// Writing a file is writing code the add-on runs from its next config reload, so writes
// are accepted only through Home Assistant ingress (admin-only panel), never from
// other add-ons on the internal network.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import type { HouseScope } from "../allowlist.js";
import { factModule, generateHouseTypes } from "./house-types.js";
import { toolkitTypes } from "./toolkit-types.js";
import type { PackageInfo } from "../packages/library.js";

/** A source file the Studio may create or edit: kebab-case, optionally a test. */
export const SOURCE_NAME = /^[a-z0-9][a-z0-9-]*(\.test)?\.(ts|js|mjs)$/;
const MAX_BYTES = 256 * 1024;

/** Supervisor's ingress gateway: the only peer that may write in add-on mode. */
const INGRESS_PEER = "172.30.32.2";

export interface StudioDeps {
  configDir: string;
  mode: "addon" | "standalone";
  liveStates: () => Iterable<HaEntityState>;
  /** Only the entities in the house scope are typed; only operable ones take .to(). */
  scope: HouseScope;
  /** The packages the running set was loaded with (packages/ in the config folder), shown read-only. */
  packages?: () => PackageInfo[];
  /** The facts the library defines, with the file of each: typed in the editor's ha.d.ts. */
  facts?: () => Array<{ id: string; title: string; file?: string; binding?: string }>;
}

/** A package as the Studio lists it. */
export interface StudioPackage {
  name: string;
  version: string;
  title: string;
  description?: string;
  /** "starter", "local"; later a git URL. */
  origin: string;
  modified: boolean;
  heuristics: string[];
  /** Per heuristic id, the file that defines it. */
  sources: Record<string, string>;
  /** Its files: sources, specs, README, manifest, example. */
  files: string[];
}

export interface SourceFile {
  name: string;
  bytes: number;
  modifiedAt: number;
}

export function listSources(configDir: string): SourceFile[] {
  const dir = join(configDir, "heuristics");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => SOURCE_NAME.test(f))
    .sort()
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, bytes: st.size, modifiedAt: st.mtimeMs };
    });
}

/** Whether a peer may write: the ingress gateway in add-on mode, loopback standalone. */
export function mayWrite(mode: StudioDeps["mode"], peer: string | undefined): boolean {
  const ip = (peer ?? "").replace(/^::ffff:/, "");
  return mode === "addon" ? ip === INGRESS_PEER : ip === "127.0.0.1" || ip === "::1";
}

type Peer = { env?: { incoming?: { socket?: { remoteAddress?: string } } } };

export function mountStudio(app: Hono, deps: StudioDeps): void {
  const dir = join(deps.configDir, "heuristics");

  app.get("/api/studio/files", (c) => c.json({ files: listSources(deps.configDir) }));

  app.get("/api/studio/files/:name", (c) => {
    const name = c.req.param("name");
    if (!SOURCE_NAME.test(name) || !existsSync(join(dir, name))) return c.json({ error: "NotFound" }, 404);
    return c.text(readFileSync(join(dir, name), "utf8"));
  });

  app.put("/api/studio/files/:name", async (c) => {
    if (!mayWrite(deps.mode, (c as unknown as Peer).env?.incoming?.socket?.remoteAddress)) {
      return c.json({ error: "Forbidden", reason: "files are written through the Home Assistant panel only" }, 403);
    }
    const name = c.req.param("name");
    if (!SOURCE_NAME.test(name)) return c.json({ error: "BadName", reason: `${name}: use kebab-case .ts, .js or .mjs` }, 400);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BYTES) return c.json({ error: "TooLarge" }, 413);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
    const st = statSync(join(dir, name));
    return c.json({ name, bytes: st.size, modifiedAt: st.mtimeMs });
  });

  // The packages, read-only: what they are and their files.
  app.get("/api/studio/packages", (c) =>
    c.json({
      packages: (deps.packages?.() ?? []).map(
        (p): StudioPackage => ({
          name: p.name,
          version: p.version,
          title: p.title,
          ...(p.description !== undefined ? { description: p.description } : {}),
          origin: p.origin,
          modified: p.modified,
          heuristics: p.heuristics,
          sources: p.sources,
          files: p.files,
        }),
      ),
    }),
  );

  app.get("/api/studio/packages/:name/:file", (c) => {
    const p = deps.packages?.().find((x) => x.name === c.req.param("name"));
    const file = c.req.param("file");
    // Only a file the package lists, at its top level.
    if (p === undefined || file.includes("/") || !p.files.includes(file)) return c.json({ error: "NotFound" }, 404);
    return c.text(readFileSync(join(p.dir, file), "utf8"));
  });

  // The "teobeanie" module's declarations and this house's entities, for the editor.
  app.get("/api/studio/types", (c) =>
    c.json({
      toolkit: toolkitTypes() ?? null,
      house: generateHouseTypes(
        [...deps.liveStates()].filter((s) => deps.scope.observes(s.entity_id)),
        {
          at: Date.now(),
          operable: deps.scope.operated,
          // The editor's ha.d.ts sits at the root, the files under heuristics/ and packages/ as in the folder.
          facts: (deps.facts?.() ?? []).map((f) => {
            const module = f.file === undefined ? undefined : factModule(deps.configDir, f.file);
            return { id: f.id, title: f.title, ...(module !== undefined ? { module } : {}), ...(f.binding !== undefined ? { binding: f.binding } : {}) };
          }),
        },
      ),
      scope: { observed: deps.scope.observed.length, operated: deps.scope.operated.length },
    }),
  );
}
