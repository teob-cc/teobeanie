// Behaviour packages: the starter set's manifests, roles and examples; the loader over a
// config folder's packages/; installing the starter set with its lock.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { createHeuristicHost, type InstanceConfig } from "../src/kernel/host.js";
import { validateParams } from "../src/kernel/params.js";
import { entityPaths, manifestProblems, resolveRole, satisfies, SDK_VERSION, type RoleShape } from "../src/packages/manifest.js";
import { installStarter, loadLibrary, STARTER_DIR, starterPackages } from "../src/packages/library.js";
import { LOCK_FILE, packageHash, readLock } from "../src/packages/lock.js";
import { readConfig } from "../src/reload.js";

const noLog = (): void => {};
const tmp = (): string => mkdtempSync(join(tmpdir(), "teobeanie-packages-"));
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
/** Every entity id in a params value (strings that look like one). */
const entitiesIn = (v: unknown): string[] =>
  typeof v === "string" ? (/^[a-z_]+\.[a-z0-9_]+$/.test(v) ? [v] : []) : Array.isArray(v) ? v.flatMap(entitiesIn) : typeof v === "object" && v !== null ? Object.values(v).flatMap(entitiesIn) : [];

/** A package folder written from files. */
function writePackage(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, "packages", name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}
const manifest = (name: string, heuristics: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: "1.0.0", platform: ">=0.2.0 <1.0.0", title: name, heuristics, ...extra });
const ping = (id: string) =>
  `import { defineHeuristic, param } from "teobeanie";\n` +
  `export default defineHeuristic({ id: "${id}", pattern: "notice", title: "${id}", description: "x", params: param.object({ door: param.entity("binary_sensor").doc("A door.") }),\n` +
  `  watch: (p) => [p.door], actuates: () => [], initial: () => ({}), decide: () => undefined, evolve: (s) => s });\n`;

describe("the starter set", async () => {
  const starters = starterPackages();
  const lib = await loadLibrary(tmp(), noLog, undefined, { withStarter: true });

  it("is the twelve packages, every one loading with its manifest", () => {
    expect(starters.map((s) => s.name)).toEqual([
      "appliance", "button", "climate-guard", "door-watch", "garage-door", "hold", "leak-guard", "relay-pulse", "sensor-light", "sun-screen", "trigger", "water-meter",
    ]);
    expect(lib.packages.map((p) => p.name)).toEqual(starters.map((s) => s.name));
    expect(lib.packages.every((p) => p.origin === "starter" && !p.modified && !p.installed)).toBe(true);
  });

  it("keeps every heuristic id existing houses use", () => {
    expect(lib.heuristics.map((d) => d.id).sort()).toEqual([
      "appliance-auto-off", "button", "button-cover", "climate-guard", "door-nag", "follow-with-run-on", "garage-door", "hold",
      "leak-shutoff", "night-leak", "occupancy-light", "relay-pulse", "screen-guard", "sensor-light", "shower-summary", "sustained-notice", "trigger",
    ]);
  });

  for (const s of starters) {
    describe(s.name, () => {
      it("has a manifest on this platform, a README, specs and an example", () => {
        expect(manifestProblems(json(join(s.dir, "teobeanie.json")), s.name)).toEqual([]);
        expect(s.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(satisfies(SDK_VERSION, s.manifest.platform)).toBe(true);
        for (const f of ["README.md", "example.json"]) expect(existsSync(join(s.dir, f)), f).toBe(true);
        expect(lib.packages.find((p) => p.name === s.name)!.files.some((f) => f.endsWith(".test.ts"))).toBe(true);
      });

      it("names a role for every entity parameter", () => {
        for (const [id, h] of Object.entries(s.manifest.heuristics)) {
          const def = lib.heuristics.find((d) => d.id === id)!;
          expect(Object.keys(h.roles ?? {}).sort(), id).toEqual(entityPaths(def.params?.spec).sort());
          expect(def.guarantees, `${id}: guarantees`).toBeTruthy();
        }
      });

      it("its example fits the schema, and switches exactly the roles marked operate", () => {
        const example = json(join(s.dir, "example.json")) as InstanceConfig;
        const def = lib.heuristics.find((d) => d.id === example.heuristic)!;
        expect(def, example.heuristic).toBeDefined();
        expect(validateParams(def, example.params)).toEqual([]);
        const roles = s.manifest.heuristics[def.id]!.roles ?? {};
        const switched = new Set([...def.actuates(example.params), ...(def.uses?.(example.params) ?? [])]);
        // The entities the example gives a role.
        const given = (path: string): string[] =>
          entitiesIn(
            path.split(".").reduce<unknown[]>(
              (vals, seg) =>
                vals.flatMap((v) => {
                  const x = (v as Record<string, unknown> | undefined)?.[seg.replace(/\[\]$/, "")];
                  return seg.endsWith("[]") && Array.isArray(x) ? x : x === undefined ? [] : [x];
                }),
              [example.params],
            ),
          );
        const operated = new Set(Object.entries(roles).flatMap(([path, role]) => (role.operate ? given(path) : [])));
        for (const [path, role] of Object.entries(roles)) {
          expect(typeof resolveRole(def.params!.spec, path), path).toBe("object");
          // A read-only role may name an entity another role switches (hold's target and condition).
          for (const e of given(path)) expect(switched.has(e), `${def.id}: ${path} ${e} switched`).toBe(role.operate === true || operated.has(e));
        }
        expect([...switched].sort(), `${def.id}: what it switches is in an operate role`).toEqual([...operated].sort());
      });
    });
  }
});

describe("roles and manifests", () => {
  it("a role must fit the parameter: an entity param, many and optional as the schema says, a domain it takes", async () => {
    const dir = tmp();
    writePackage(dir, "doors", {
      "teobeanie.json": manifest("doors", {
        "door-ping": { pattern: "notice", roles: { door: { domain: ["binary_sensor", "light"], many: true }, nope: { domain: "sensor" } } },
      }),
      "door-ping.ts": ping("door-ping"),
    });
    const failures: string[] = [];
    const lib = await loadLibrary(dir, noLog, failures);
    expect(lib.heuristics).toEqual([]);
    expect(failures).toEqual([
      "packages/doors: heuristics.door-ping.roles.door: takes one entity: many must be false; heuristics.door-ping.roles.door: domain light is not one the param takes (binary_sensor); heuristics.door-ping.roles.nope: no param nope",
    ]);
  });

  it("a manifest names the folder, a version, a platform range and its heuristics, and nothing unknown", () => {
    expect(manifestProblems({ name: "Bad Name", version: "1", platform: "soon", title: "", heuristics: {}, colour: "red" }, "bad")).toEqual([
      "colour: unknown, expected one of name, version, platform, title, description, pattern, main, heuristics, facts",
      "name: expected a kebab-case name",
      'version: expected "major.minor.patch"',
      'platform: expected a version range of the "teobeanie" module, e.g. ">=0.2.0 <1.0.0"',
      "title: expected a string",
      "heuristics: expected an object with an entry per heuristic id",
    ]);
    expect(manifestProblems(json(join(STARTER_DIR, "hold", "teobeanie.json")), "other")).toEqual(['name: "hold" is not the folder\'s name (other)']);
  });

  it("version ranges", () => {
    expect(satisfies("0.2.0", ">=0.2.0 <1.0.0")).toBe(true);
    expect(satisfies("1.0.0", ">=0.2.0 <1.0.0")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfies("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfies("0.2.9", "~0.2.1")).toBe(true);
    expect(satisfies("0.1.0", "0.1.0 || >=2.0.0")).toBe(true);
    expect(satisfies("0.2.0", "*")).toBe(true);
  });
});

describe("the loader", () => {
  it("loads a package of the house's own next to its heuristics/ files; origin local", async () => {
    const dir = tmp();
    writePackage(dir, "doors", {
      "teobeanie.json": manifest("doors", { "door-ping": { pattern: "notice", roles: { door: { domain: "binary_sensor", device_class: "door" } } } }),
      "door-ping.ts": ping("door-ping"),
      "door-ping.test.ts": "this is not loaded",
      "README.md": "# Doors",
    });
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "mine.ts"), ping("mine"));
    const lib = await loadLibrary(dir, noLog);
    expect(lib.heuristics.map((d) => d.id)).toEqual(["door-ping", "mine"]);
    expect(lib.packages).toMatchObject([{ name: "doors", origin: "local", modified: false, installed: true, heuristics: ["door-ping"], sources: { "door-ping": "door-ping.ts" } }]);
    expect(lib.sources.get("mine")).toEqual({ file: join(dir, "heuristics", "mine.ts") });
  });

  it("rejects, as a whole: code and manifest that disagree, another platform, an id taken twice", async () => {
    const dir = tmp();
    writePackage(dir, "a-extra", { "teobeanie.json": manifest("a-extra", { "a-one": {}, "a-two": {} }), "a.ts": ping("a-one") });
    writePackage(dir, "b-later", { "teobeanie.json": manifest("b-later", { "b-one": {} }, { platform: ">=2.0.0" }), "b.ts": ping("b-one") });
    writePackage(dir, "c-pattern", { "teobeanie.json": manifest("c-pattern", { "c-one": { pattern: "guard", uses: ["outdoor"] } }), "c.ts": ping("c-one") });
    writePackage(dir, "d-first", { "teobeanie.json": manifest("d-first", { twice: {} }), "d.ts": ping("twice") });
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "twice.ts"), ping("twice"));
    const failures: string[] = [];
    const lib = await loadLibrary(dir, noLog, failures);
    expect(lib.heuristics.map((d) => d.id)).toEqual(["twice"]);
    expect(failures).toEqual([
      "packages/a-extra: teobeanie.json names a-two, which the code does not define",
      `packages/b-later: platform: needs "teobeanie" >=2.0.0, this is ${SDK_VERSION}`,
      'packages/c-pattern: heuristics.c-one.pattern: "guard", the heuristic says "notice"; heuristics.c-one.uses: "outdoor", but it does not read the outdoor conditions',
      'twice.ts: heuristic id "twice" is already defined',
    ]);
    // A reload is all or nothing: any of these rejects it.
    await expect(readConfig(dir, noLog)).rejects.toThrow(/a-extra.*b-later.*c-pattern.*twice\.ts/s);
  });

  // Node's module hooks (not vitest's loader): the built add-on, in a node of its own.
  const built = existsSync(join(import.meta.dirname, "..", "dist", "packages", "library.js"));
  it.skipIf(!built)("an edited package file is imported afresh, its siblings with it (the built add-on)", () => {
    const dir = tmp();
    const helper = (n: number) => `export const N = ${n};\n`;
    const main = `import { defineHeuristic } from "teobeanie";\nimport { N } from "./n.ts";\n` +
      `export default defineHeuristic({ id: "count", title: "count " + N, description: "x", watch: () => [], actuates: () => [], initial: () => ({}), decide: () => undefined, evolve: (s) => s });\n`;
    writePackage(dir, "counter", { "teobeanie.json": manifest("counter", { count: {} }, { main: "count.ts" }), "count.ts": main, "n.ts": helper(1) });
    const script = `
      import { writeFileSync } from "node:fs";
      import { loadLibrary } from ${JSON.stringify(join(import.meta.dirname, "..", "dist", "packages", "library.js"))};
      const dir = ${JSON.stringify(dir)};
      const titles = [(await loadLibrary(dir, () => {})).heuristics[0]?.title];
      writeFileSync(dir + "/packages/counter/n.ts", ${JSON.stringify(helper(2))});
      titles.push((await loadLibrary(dir, () => {})).heuristics[0]?.title);
      console.log(JSON.stringify(titles));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(["count 1", "count 2"]);
  });
});

describe("installing the starter set", () => {
  const instances = (dir: string, ids: string[]) =>
    writeFileSync(join(dir, "heuristics.json"), JSON.stringify({ instances: ids.map((h, i) => ({ heuristic: h, id: `i${i}`, params: {} })) }));

  it("a fresh folder gets every starter package, locked with origin, version and hash", async () => {
    const dir = tmp();
    const r = installStarter(dir);
    const names = starterPackages().map((s) => s.name);
    expect(r.installed).toEqual(names);
    const lock = readLock(dir);
    expect(Object.keys(lock.packages)).toEqual(names);
    expect(lock.packages["door-watch"]).toEqual({ origin: "starter", version: "1.0.0", hash: packageHash(join(STARTER_DIR, "door-watch")) });
    expect(packageHash(join(dir, "packages", "door-watch"))).toBe(lock.packages["door-watch"]!.hash);
    // A second start changes nothing.
    expect(installStarter(dir)).toEqual({ installed: [], modified: [], removed: [], upstream: [], lockWritten: false });
    // What is installed is what runs, and the catalogue says where it came from.
    const lib = await loadLibrary(dir, noLog);
    expect(lib.packages.every((p) => p.installed && p.origin === "starter" && !p.modified)).toBe(true);
  });

  it("an existing house keeps its instances: the starter set appears beside its own files and resolves every former built-in", async () => {
    const dir = tmp();
    cpSync(join(import.meta.dirname, "..", "examples", "starter"), dir, { recursive: true });
    installStarter(dir);
    const next = await readConfig(dir, noLog);
    const logged: string[] = [];
    const host = createHeuristicHost({
      library: next.library,
      instances: next.instances,
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
      liveState: () => undefined,
      scope: next.allowlist.scope,
      forceShadow: true,
      log: (_l, m) => logged.push(m),
    });
    expect(logged).toEqual([]);
    expect(host.instances().length).toBe(next.instances.length);
  });

  it("never overwrites: a changed package is marked modified and kept", () => {
    const dir = tmp();
    installStarter(dir);
    const file = join(dir, "packages", "hold", "hold.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("Hold", "My hold"));
    const r = installStarter(dir);
    expect(r.modified).toEqual(["hold"]);
    expect(readFileSync(file, "utf8")).toContain("My hold");
    expect(readLock(dir).packages["hold"]).toMatchObject({ origin: "starter", modified: true, hash: packageHash(join(STARTER_DIR, "hold")) });
  });

  it("a starter package the house removed stays removed, unless an instance needs it", () => {
    const dir = tmp();
    installStarter(dir);
    rmSync(join(dir, "packages", "door-watch"), { recursive: true });
    expect(installStarter(dir).removed).toEqual(["door-watch"]);
    expect(existsSync(join(dir, "packages", "door-watch"))).toBe(false);
    expect(readLock(dir).packages["door-watch"]).toMatchObject({ removed: true });
    instances(dir, ["door-nag"]);
    expect(installStarter(dir).installed).toEqual(["door-watch"]);
    expect(readLock(dir).packages["door-watch"]).toEqual({ origin: "starter", version: "1.0.0", hash: packageHash(join(STARTER_DIR, "door-watch")) });
  });

  it("a package already there without a lock (copied by hand) is locked as it is; one of the house's own is local", () => {
    const dir = tmp();
    cpSync(join(STARTER_DIR, "relay-pulse"), join(dir, "packages", "relay-pulse"), { recursive: true });
    writePackage(dir, "doors", { "teobeanie.json": manifest("doors", { "door-ping": {} }), "door-ping.ts": ping("door-ping") });
    const r = installStarter(dir);
    expect(r.installed).not.toContain("relay-pulse");
    const lock = readLock(dir);
    expect(lock.packages["relay-pulse"]).toEqual({ origin: "starter", version: "1.0.0", hash: packageHash(join(STARTER_DIR, "relay-pulse")) });
    expect(lock.packages["doors"]).toEqual({ origin: "local", version: "1.0.0", hash: packageHash(join(dir, "packages", "doors")) });
    expect(readFileSync(join(dir, LOCK_FILE), "utf8")).toMatch(/^\{\n {2}"lockfileVersion": 1,/);
  });
});

describe("one version", () => {
  it("package.json, the panel's, both add-ons' config.yaml, the plugin and the SDK packages are checked against agree", () => {
    const root = join(import.meta.dirname, "..");
    const pkg = (json(join(root, "package.json")) as { version: string }).version;
    const addon = (folder: string) => /^version:\s*"([^"]+)"/m.exec(readFileSync(join(root, folder, "config.yaml"), "utf8"))?.[1];
    expect(SDK_VERSION).toBe(pkg);
    expect(addon("teobeanie")).toBe(pkg);
    // Teobeanie Whisper is released with it, at the same version (one tag builds both).
    expect(addon("whisper")).toBe(pkg);
    // The Claude Code plugin with the skills is released with the add-on.
    expect((json(join(root, ".claude-plugin", "plugin.json")) as { version: string }).version).toBe(pkg);
    expect((json(join(root, "panel", "package.json")) as { version: string }).version).toBe(pkg);
    // The changelog's newest entry is this version.
    expect(/^## (\d+\.\d+\.\d+)/m.exec(readFileSync(join(root, "teobeanie", "CHANGELOG.md"), "utf8"))?.[1]).toBe(pkg);
  });
});
