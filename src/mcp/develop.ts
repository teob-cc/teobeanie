// develop.ts — the MCP tools that change the house's behaviours: develop (packages,
// files, typings, specs, replay, the scope to observe, instances in shadow, an export)
// and operate (an instance's mode, the scope to operate, rollback, promote, the pause,
// a command). No tool here switches a device: behaviours act, through the
// SafeActuator, and a command reaches a behaviour, never Home Assistant.
//
// Every write is one change to the working set applied through the reload path
// (Reloader.write and edit, revisions.ts rollback, twins.ts promoteTwin): all or
// nothing, the folder put back when the reload rejects it, and journaled as the next
// revision with `by: mcp:<caller>`. A tool reports the revision it made; the MCP
// journal records it with the call (tool_calls).
//
// The platform's own guardrails sit here, under the ones the agent skills carry:
// instance_upsert never makes an instance active; instance_mode makes one active only
// when its specs pass now and it decided in shadow within the last day, or with a
// reason that is journaled; a guard leaves active only with a reason; scope_add only
// observes, scope_operate takes a reason. Write tools are annotated readOnlyHint false,
// operate tools destructiveHint true, so a client can ask its person first.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { MCPTool } from "@lambda-house/teob-ts/ai";
import type { JournalReader } from "@lambda-house/teob-ts/core";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import type { HouseScope } from "../allowlist.js";
import type { UserDirectory } from "../attribution.js";
import { houseZone } from "../kernel/clock.js";
import type { AnyHeuristic, CommandSource, HouseFacts } from "../kernel/heuristic.js";
import type { InstanceConfig, InstanceInfo } from "../kernel/host.js";
import { checkInstance, INSTANCE_ID, newIdProblem } from "../kernel/instance-check.js";
import { validateParams } from "../kernel/params.js";
import { MANIFEST, PATTERNS, SDK_VERSION, type Manifest } from "../packages/manifest.js";
import { PACKAGES, type Library, type PackageInfo, type StarterPackage } from "../packages/library.js";
import { LOCK_FILE, lockText, packageHash, readLock } from "../packages/lock.js";
import type { PauseControl } from "../pause.js";
import { formatHit, loadDenyList, scanFolder, type PrivacyHit } from "../privacy.js";
import { CONFIG_FILES, type Reloader, type ReloadOutcome } from "../reload.js";
import { compare, factsFor, formatParity, houseChanges, replay, replayEntities, type Recorded } from "../replay.js";
import { diffRevisions, inWorkingSet, listRevisions, rollback, workingSetPaths, type RevisionStore } from "../revisions.js";
import { addScopeEntity, scopeEntry, setScopeOperate } from "../scope-edit.js";
import { GENERATED } from "../studio/init.js";
import { writeTypes } from "../studio/write-types.js";
import { runSpecs, specFilesUnder, type SpecRun } from "../testing/spec-runner.js";
import { compareTwin, promoteTwin } from "../twins.js";
import { addInstance, describeEdit, readInstance, readInstances, replaceInstance, setInstanceField, setInstanceMode } from "../working-set.js";
import { callerLabel, type Caller } from "./access.js";
import { readJournal } from "./timeline.js";
import { bool, localTime, num, str, strs, tool, type Args } from "./tools.js";

/** MCP tool annotations (the spec's ToolAnnotations): what a client shows before it calls. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool with its annotations (index.ts adds them to tools/list). */
export type AnnotatedTool = MCPTool & { annotations?: ToolAnnotations };

/** A read tool, a write to the working set (develop), or a change to what the house does (operate). */
export type ToolKind = "read" | "write" | "operate";

export const annotate = (t: MCPTool, kind: ToolKind): AnnotatedTool => ({
  ...t,
  annotations:
    kind === "read" ? { readOnlyHint: true, openWorldHint: false }
    : kind === "write" ? { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
});

export interface DevelopToolDeps {
  configDir: string;
  reloader: Reloader;
  revisions: RevisionStore;
  journal: JournalReader;
  instances(): InstanceInfo[];
  /** The library the running set was loaded with. */
  library(): Pick<Library, "heuristics" | "facts" | "factSources" | "packages">;
  /** The add-on's starter set. */
  starter(): StarterPackage[];
  scope: HouseScope;
  /** Home Assistant's current states, every entity (the types tool keeps the scope's). */
  liveStates(): Iterable<HaEntityState>;
  /** The recorder and the logbook, for replay. */
  ha: { send<T = unknown>(message: Record<string, unknown>): Promise<T> };
  users?: Pick<UserDirectory, "originOf">;
  house: HouseFacts;
  pause: PauseControl;
  command(name: string, args: string[], from: CommandSource): string[];
  caller(): Caller | undefined;
  now?: () => number;
  /** The longest a test run may take (default 20 s). */
  specTimeoutMs?: number;
}

const DAY_MS = 24 * 3600_000;
const MAX_FILE = 256 * 1024;
const COMMAND_NAME = /^[A-Za-z0-9_]{1,32}$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A working-set path an agent may write: normalized, relative, inside the working set, not generated, not the lock. */
export function writablePath(path: string): string {
  if (typeof path !== "string" || path === "") throw new Error("path is required");
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) throw new Error(`${path}: a path relative to the config folder, with forward slashes`);
  const p = posix.normalize(path);
  if (p !== path || p.split("/").includes("..") || p.startsWith("./")) throw new Error(`${path}: not a plain path inside the config folder`);
  if (p === LOCK_FILE) throw new Error(`${LOCK_FILE} is written by the add-on (package_install), never by hand`);
  if (GENERATED.some((g) => p === g || p.startsWith(`${g}/`))) throw new Error(`${p} is generated: the types tool writes it`);
  if (!CONFIG_FILES.includes(p) && !p.startsWith("heuristics/") && !p.startsWith(`${PACKAGES}/`)) {
    throw new Error(`${p} is outside the working set: heuristics.json, allowlist.json, tiles.json, heuristics/** and packages/** only`);
  }
  if (!inWorkingSet(p)) throw new Error(`${p}: dot files and node_modules are not part of the working set`);
  return p;
}

/** Remove the folders a removal emptied, up to (not including) heuristics/ or packages/. */
function pruneEmpty(configDir: string, path: string): void {
  for (let dir = dirname(path); dir.includes("/"); dir = dirname(dir)) {
    const abs = join(configDir, dir);
    if (!existsSync(abs) || readdirSync(abs).length > 0) return;
    rmdirSync(abs);
  }
}

/** Files written into the config folder, and how to put them back as they were. */
function writeFiles(configDir: string, files: Record<string, string>): () => void {
  const before = new Map<string, Buffer | undefined>();
  const created: string[] = [];
  const restore = (): void => {
    for (const [p, bytes] of before) {
      const abs = join(configDir, p);
      if (bytes === undefined) {
        if (existsSync(abs)) unlinkSync(abs);
        pruneEmpty(configDir, p);
      } else writeFileSync(abs, bytes);
    }
    for (const d of created.reverse()) if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
  };
  try {
    for (const [p, text] of Object.entries(files)) {
      const abs = join(configDir, p);
      before.set(p, existsSync(abs) ? readFileSync(abs) : undefined);
      const dir = dirname(abs);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        created.push(dir);
      }
      writeFileSync(abs, text);
    }
  } catch (err) {
    restore();
    throw err;
  }
  return restore;
}

/** What a write tool answers: the revision it made, or why nothing changed. */
function applied(o: ReloadOutcome, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (!o.ok) throw new Error(`the reload rejected the change, and the config folder is as it was: ${o.error ?? "?"}`);
  if (o.journaled?.revision === undefined) return { ...extra, unchanged: true, note: "nothing changed: no revision" };
  return { ...extra, revision: o.journaled.revision, ...(o.journaled.parent !== undefined ? { parent: o.journaled.parent } : {}), summary: o.journaled.summary, undo: o.journaled.parent !== undefined ? `rollback with n: ${o.journaled.parent}` : undefined };
}

/** The params of an example instance with every role's entities replaced by a placeholder ("light.lights"). */
function placeholderParams(params: unknown, roles: Record<string, { domain: string | string[]; many?: boolean }>): { params: unknown; ids: string[] } {
  const out = JSON.parse(JSON.stringify(params ?? {})) as unknown;
  const ids: string[] = [];
  for (const [path, role] of Object.entries(roles)) {
    const domain = Array.isArray(role.domain) ? role.domain[0]! : role.domain;
    const object = path.replace(/\[\]/g, "").split(".").pop()!.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/[^a-z0-9_]/g, "_");
    const id = `${domain}.${object}`;
    ids.push(object);
    const set = (at: unknown, segs: string[]): void => {
      if (typeof at !== "object" || at === null) return;
      const [seg, ...rest] = segs;
      const name = seg!.endsWith("[]") ? seg!.slice(0, -2) : seg!;
      const o = at as Record<string, unknown>;
      if (!(name in o)) return;
      if (seg!.endsWith("[]")) {
        const list = o[name];
        if (!Array.isArray(list)) return;
        if (rest.length === 0) o[name] = list.map(() => id);
        else for (const item of list) set(item, rest);
        return;
      }
      if (rest.length === 0) o[name] = Array.isArray(o[name]) ? (o[name] as unknown[]).map(() => id) : id;
      else set(o[name], rest);
    };
    set(out, path.split("."));
  }
  return { params: out, ids };
}

/** A new package's files: a manifest with its roles, the code (a decider or a rule), a spec, a README and an example. */
export function scaffoldFiles(name: string, pattern: string, kind: "decider" | "rule", title: string): Record<string, string> {
  const notice = pattern === "notice";
  const camel = name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const roles: Manifest["heuristics"][string]["roles"] = notice
    ? { sensor: { domain: "binary_sensor", doc: "The sensor whose on starts the notice." } }
    : {
        sensor: { domain: "binary_sensor", doc: "The sensor that switches the target on." },
        target: { domain: ["light", "switch"], operate: true, doc: "What it switches." },
      };
  const manifest: Manifest = {
    name,
    version: "0.1.0",
    platform: `>=${SDK_VERSION} <1.0.0`,
    title,
    description: `${title}: a new package. Say in one sentence what it does for the people in the house.`,
    pattern: pattern as Manifest["pattern"],
    heuristics: { [name]: { title, pattern: pattern as Manifest["pattern"], roles, ...(notice ? { uses: ["notify"] } : {}) } },
  };
  const params = notice ? { sensor: "binary_sensor.example_sensor" } : { sensor: "binary_sensor.example_sensor", target: "light.example_light", offAfterMin: 5 };
  const example = { heuristic: name, id: "example", mode: "shadow", params };
  const code =
    kind === "rule" && !notice
      ? `// ${name} — ${title}. A rule: it says what the target should be, and the kernel
// works out the calls. A person who switches the target is left alone until the
// rule's answer changes.

import { keep, minutes, param, rule, type Infer } from "teobeanie";

const PARAMS = param.object({
  sensor: param.entity("binary_sensor").doc("The sensor that switches the target on."),
  target: param.entity("light", "switch").doc("What it switches."),
  offAfterMin: param.duration("min", { positive: true }).default(5).doc("Minutes the sensor must be off before the target goes off."),
});

export type ${camel[0]!.toUpperCase()}${camel.slice(1)}Params = Infer<typeof PARAMS>;

export const ${camel} = rule<${camel[0]!.toUpperCase()}${camel.slice(1)}Params>(
  "${name}",
  ({ entity, held }, p) => {
    const on = entity(p.sensor).is("on");
    const quiet = held(() => entity(p.sensor).is("off"), minutes(p.offAfterMin));
    return entity(p.target).to(on ? "on" : quiet ? "off" : keep);
  },
  {
    title: "${title}",
    description: "Switches the target on while the sensor is on, and off after it has been off a while.",
    guarantees: "The target is switched on when the sensor turns on and off once it has been off for offAfterMin minutes.",
    params: PARAMS,
    owns: (p) => [p.target],
    pattern: "${pattern}",
  },
);

export default ${camel};
`
      : notice
        ? `// ${name} — ${title}. A decider: it tells people when the sensor turns on, and
// never acts on the house.

import { defineHeuristic, notify, param, type Infer } from "teobeanie";

const PARAMS = param.object({
  sensor: param.entity("binary_sensor").doc("The sensor whose on starts the notice."),
});

export type ${camel[0]!.toUpperCase()}${camel.slice(1)}Params = Infer<typeof PARAMS>;

export const ${camel} = defineHeuristic<${camel[0]!.toUpperCase()}${camel.slice(1)}Params, Record<string, never>, never>({
  id: "${name}",
  pattern: "notice",
  title: "${title}",
  description: "Tells people when the sensor turns on.",
  guarantees: "Says so once each time the sensor turns on. Never switches anything.",
  params: PARAMS,
  watch: (p) => [p.sensor],
  actuates: () => [],
  initial: () => ({}),

  decide(_state, input) {
    if (input.kind !== "signal" || input.value !== true) return undefined;
    return { why: \`\${input.entity} turned on\`, actions: [notify(\`\${input.entity} turned on\`)] };
  },

  evolve: (state) => state,
});

export default ${camel};
`
        : `// ${name} — ${title}. A decider: the sensor switches the target on, and the target
// goes off a while after the sensor went off. Edit the steps; keep the specs green.

import { call, cancelTimer, defineHeuristic, minutes, param, setTimer, type Infer } from "teobeanie";

const PARAMS = param.object({
  sensor: param.entity("binary_sensor").doc("The sensor that switches the target on."),
  target: param.entity("light", "switch").doc("What it switches."),
  offAfterMin: param.duration("min", { positive: true }).default(5).doc("Minutes after the sensor went off before the target goes off."),
});

export type ${camel[0]!.toUpperCase()}${camel.slice(1)}Params = Infer<typeof PARAMS>;

export const ${camel} = defineHeuristic<${camel[0]!.toUpperCase()}${camel.slice(1)}Params, Record<string, never>, never>({
  id: "${name}",
  pattern: "${pattern}",
  title: "${title}",
  description: "Switches the target on when the sensor turns on, and off a while after it turned off.",
  guarantees: "The target goes on when the sensor turns on, and off offAfterMin minutes after the sensor turned off.",
  params: PARAMS,
  watch: (p) => [p.sensor],
  actuates: (p) => [p.target],
  initial: () => ({}),

  decide(_state, input, ctx) {
    const p = ctx.params;
    const domain = p.target.slice(0, p.target.indexOf("."));
    switch (input.kind) {
      case "signal":
        if (input.value === true) {
          return { why: \`\${p.sensor} on\`, actions: ctx.value(p.target) === true ? [] : [call(\`\${domain}.turn_on\`, p.target)], timers: [cancelTimer("off")] };
        }
        return { why: \`\${p.sensor} off: off in \${p.offAfterMin} min\`, timers: [setTimer("off", ctx.now + minutes(p.offAfterMin))] };
      case "timer":
        if (ctx.value(p.target) !== true) return undefined;
        return { why: \`\${p.sensor} off for \${p.offAfterMin} min\`, actions: [call(\`\${domain}.turn_off\`, p.target)] };
      default:
        return undefined;
    }
  },

  evolve: (state) => state,
});

export default ${camel};
`;
  const spec = notice
    ? `// ${name}: the specs are the package's promises, played out on the simulator.

import { describe, expect, it, simulate } from "teobeanie/test";
import { ${camel} } from "./${name}.ts";

describe("${name}", () => {
  const params = { sensor: "binary_sensor.example_sensor" };

  it("tells people once when the sensor turns on", () => {
    const sim = simulate(${camel}, params, { "binary_sensor.example_sensor": "off" });
    sim.set("binary_sensor.example_sensor", "on");
    expect(sim.calls()).toEqual(["notify: binary_sensor.example_sensor turned on"]);
  });
});
`
    : `// ${name}: the specs are the package's promises, played out on the simulator.

import { describe, expect, it, simulate } from "teobeanie/test";
import { minutes } from "teobeanie";
import { ${camel} } from "./${name}.ts";

describe("${name}", () => {
  const params = { sensor: "binary_sensor.example_sensor", target: "light.example_light", offAfterMin: 5 };
  const world = { "binary_sensor.example_sensor": "off", "light.example_light": "off" };

  it("switches the target on when the sensor turns on", () => {
    const sim = simulate(${camel}, params, world);
    sim.set("binary_sensor.example_sensor", "on");
    expect(sim.calls()).toEqual(["light.turn_on light.example_light"]);
  });

  it("switches it off once the sensor has been off a while", () => {
    const sim = simulate(${camel}, params, world);
    sim.set("binary_sensor.example_sensor", "on").set("light.example_light", "on");
    sim.set("binary_sensor.example_sensor", "off").advance(minutes(5));
    expect(sim.calls()).toEqual(["light.turn_on light.example_light", "light.turn_off light.example_light"]);
  });
});
`;
  const readme = `# ${title}

A new package, made with package_scaffold. Say here what it does for the people in the
house, in a sentence or two, and keep this README in step with the code.

## Roles

| Role | Entities | |
|---|---|---|
${Object.entries(roles)
  .map(([path, r]) => `| \`${path}\` | ${(Array.isArray(r.domain) ? r.domain : [r.domain]).join(", ")}${r.operate ? ", switched" : ""} | ${r.doc ?? ""} |`)
  .join("\n")}

## Guarantees

${notice ? "Says so once each time the sensor turns on. Never switches anything." : "The target goes on when the sensor turns on, and off a while after the sensor turned off."}

## Specs

\`${name}.test.ts\`, run with test_run. Write the spec for a change first.
`;
  return {
    [`${PACKAGES}/${name}/${MANIFEST}`]: `${JSON.stringify(manifest, null, 2)}\n`,
    [`${PACKAGES}/${name}/${name}.ts`]: code,
    [`${PACKAGES}/${name}/${name}.test.ts`]: spec,
    [`${PACKAGES}/${name}/README.md`]: readme,
    [`${PACKAGES}/${name}/example.json`]: `${JSON.stringify(example, null, 2)}\n`,
  };
}

export function createDevelopTools(deps: DevelopToolDeps): AnnotatedTool[] {
  const now = deps.now ?? Date.now;
  const zone = (): string => houseZone(deps.house);
  const local = (ms: number): string => localTime(ms, zone());
  /** Who, in the journal: mcp:agent:<token name>, mcp:person:<HA user>. */
  const by = (): string => `mcp:${callerLabel(deps.caller() ?? { via: "local" })}`;
  const heuristicsText = (): string | undefined => {
    const p = join(deps.configDir, "heuristics.json");
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  };
  const defOf = (id: string): AnyHeuristic | undefined => deps.library().heuristics.find((d) => d.id === id);
  const packageOf = (heuristic: string): PackageInfo | undefined => deps.library().packages.find((p) => p.heuristics.includes(heuristic));
  const keyOf = (a: Args, name = "key"): string => {
    const key = str(a, name);
    if (key === undefined || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(key)) throw new Error(`${name} is required: an instance key, <heuristic>/<id>`);
    return key;
  };

  /** The spec files that cover a heuristic: its package's, or the house's own in heuristics/. */
  const specsOf = (heuristic: string): string[] => {
    const pkg = packageOf(heuristic);
    return pkg !== undefined ? specFilesUnder(deps.configDir, `${PACKAGES}/${pkg.name}`) : specFilesUnder(deps.configDir, "heuristics");
  };
  const shownRun = (run: SpecRun) => ({
    files: run.files,
    passed: run.passed,
    failed: run.failed,
    ...(run.skipped > 0 ? { skipped: run.skipped } : {}),
    ...(run.timedOut ? { timed_out: true } : {}),
    specs: run.specs.map((s) => ({ file: s.file, name: s.name, ok: s.ok, ...(s.skipped ? { skipped: true } : {}), ...(s.error !== undefined ? { error: s.error } : {}) })),
  });

  /** The instance's last Decided in shadow within the window, if any. */
  const lastShadowDecision = (key: string, sinceMs: number): { at: number; event_id?: string } | undefined => {
    const slash = key.indexOf("/");
    const rows = readJournal(deps.journal, { category: key.slice(0, slash), entityId: key.slice(slash + 1), sinceMs }, 20_000);
    const hit = rows.find((r) => r.manifest === "Decided" && (r.payload as { mode?: string }).mode === "shadow");
    return hit === undefined ? undefined : { at: hit.ts * 1000, ...(hit.envelope?.eventId !== undefined ? { event_id: hit.envelope.eventId } : {}) };
  };

  // ---- develop ----

  const develop: AnnotatedTool[] = [
    annotate(
      tool(
        "package_list",
        "The behaviour packages: the ones installed in the config folder (version, pattern, origin starter or local, whether the house changed a starter one, a newer starter version) and the add-on's starter set, each marked installed or not. Read-only.",
        {},
        () => {
          const lib = deps.library();
          const lock = readLock(deps.configDir);
          const loaded = new Set(lib.packages.map((p) => p.name));
          const folders = existsSync(join(deps.configDir, PACKAGES))
            ? readdirSync(join(deps.configDir, PACKAGES)).filter((n) => !n.startsWith(".") && statSync(join(deps.configDir, PACKAGES, n)).isDirectory())
            : [];
          return {
            installed: [
              ...lib.packages.map((p) => ({
                name: p.name,
                version: p.version,
                title: p.title,
                ...(p.pattern !== undefined ? { pattern: p.pattern } : {}),
                origin: p.origin,
                modified: p.modified,
                ...(p.upstream !== undefined ? { upstream: p.upstream.version } : {}),
                heuristics: p.heuristics,
                ...(p.facts.length > 0 ? { facts: p.facts } : {}),
                files: p.files,
              })),
              ...folders.filter((n) => !loaded.has(n)).map((n) => ({ name: n, loaded: false, note: "in the folder but not loaded: the reload's reason is on the panel's Heuristics tab" })),
            ],
            starter: deps.starter().map((s) => ({
              name: s.name,
              version: s.manifest.version,
              title: s.manifest.title,
              ...(s.manifest.pattern !== undefined ? { pattern: s.manifest.pattern } : {}),
              installed: folders.includes(s.name),
              ...(lock.packages[s.name]?.removed ? { removed_by_the_house: true } : {}),
            })),
          };
        },
      ),
      "read",
    ),

    annotate(
      tool(
        "package_install",
        "Install a starter package that is missing from the config folder (package_list says which): its files are copied in and the lock records it. One revision. Installing from a git URL is not built yet.",
        { name: { type: "string", description: "a starter package's name, e.g. sensor-light" } },
        async (a) => {
          const name = str(a, "name");
          if (name === undefined) throw new Error("name is required");
          if (/[:/@]|\.git$/.test(name)) throw new Error("not yet: installing a package from a git URL is not built. Copy its files in with file_write, under packages/<name>/");
          const starter = deps.starter().find((s) => s.name === name);
          if (starter === undefined) throw new Error(`no starter package ${name}: package_list names them`);
          const target = join(deps.configDir, PACKAGES, name);
          if (existsSync(target)) throw new Error(`${name} is already in the config folder`);
          const lockPath = join(deps.configDir, LOCK_FILE);
          const o = await deps.reloader.write({
            by: by(),
            summary: `install package ${name} ${starter.manifest.version} from the starter set`,
            apply: () => {
              const oldLock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
              const lock = readLock(deps.configDir);
              mkdirSync(join(deps.configDir, PACKAGES), { recursive: true });
              cpSync(starter.dir, target, { recursive: true, filter: (src) => !/[\\/](\.[^\\/]+|node_modules)$/.test(src) });
              lock.packages[name] = { origin: "starter", version: starter.manifest.version, hash: packageHash(target) };
              writeFileSync(lockPath, lockText(lock));
              return () => {
                rmSync(target, { recursive: true, force: true });
                if (oldLock === undefined) unlinkSync(lockPath);
                else writeFileSync(lockPath, oldLock);
              };
            },
          });
          return applied(o, { package: name, version: starter.manifest.version });
        },
      ),
      "write",
    ),

    annotate(
      tool(
        "package_scaffold",
        "Start a new behaviour package in the config folder: packages/<name>/ with a manifest (roles), the code (a decider, or a rule), a spec that passes, a README and an example instance. Edit it with file_write, run its specs with test_run. One revision.",
        {
          name: { type: "string", description: "kebab-case; also its heuristic's id" },
          pattern: { type: "string", enum: [...PATTERNS], description: "trigger, hold, momentary, button, command, notice or guard: a label for the catalogue (notice makes a notify-only skeleton)" },
          kind: { type: "string", enum: ["decider", "rule"], description: "decider (default): decide/evolve with timers; rule: what the target should be" },
          title: { type: "string" },
        },
        async (a) => {
          const name = str(a, "name");
          const pattern = str(a, "pattern");
          const kind = str(a, "kind") ?? "decider";
          if (name === undefined || !KEBAB.test(name)) throw new Error("name is required, kebab-case");
          if (pattern === undefined || !(PATTERNS as readonly string[]).includes(pattern)) throw new Error(`pattern is required: ${PATTERNS.join(", ")}`);
          if (kind !== "decider" && kind !== "rule") throw new Error('kind is "decider" or "rule"');
          if (existsSync(join(deps.configDir, PACKAGES, name))) throw new Error(`packages/${name} already exists`);
          if (deps.starter().some((s) => s.name === name)) throw new Error(`${name} is a starter package's name: choose another`);
          if (defOf(name) !== undefined) throw new Error(`a heuristic ${name} already exists: choose another name`);
          const title = str(a, "title") ?? name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
          const files = scaffoldFiles(name, pattern, kind, title);
          const o = await deps.reloader.write({ by: by(), summary: `new package ${name} (${kind}, ${pattern})`, apply: () => writeFiles(deps.configDir, files) });
          return applied(o, { package: name, files: Object.keys(files), next: "edit with file_write, then test_run with package" });
        },
      ),
      "write",
    ),

    annotate(
      tool(
        "file_read",
        "A file of the working set (heuristics.json, allowlist.json, tiles.json, teobeanie.lock.json, heuristics/**, packages/**), as text. Without a path, lists the working set's files. Read-only.",
        { path: { type: "string", description: "relative to the config folder, e.g. packages/sensor-light/sensor-light.ts" } },
        (a) => {
          const path = str(a, "path");
          if (path === undefined) return { files: workingSetPaths(deps.configDir) };
          const p = posix.normalize(path);
          if (p !== path || p.startsWith("/") || p.split("/").includes("..") || (!inWorkingSet(p) && p !== "heuristics/ha.d.ts")) throw new Error(`${path} is not a file of the working set`);
          const abs = join(deps.configDir, p);
          if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`no file ${p}`);
          return { path: p, text: readFileSync(abs, "utf8") };
        },
      ),
      "read",
    ),

    annotate(
      tool(
        "file_write",
        "Write one file of the working set (heuristics.json, allowlist.json, tiles.json, heuristics/**, packages/**; not the lock or generated files) with the whole new text. A JSON file must parse. Applied through the reload, all or nothing: rejected, the folder stays as it was and the reason comes back. One revision. Instances: instance_upsert keeps the file's layout; scope: scope_add.",
        { path: { type: "string" }, content: { type: "string", description: "the whole file" } },
        async (a) => {
          const p = writablePath(str(a, "path") ?? "");
          const content = str(a, "content");
          if (content === undefined) throw new Error("content is required");
          if (Buffer.byteLength(content) > MAX_FILE) throw new Error(`${p}: larger than ${MAX_FILE / 1024} KB`);
          if (p.endsWith(".json")) {
            try {
              JSON.parse(content);
            } catch (err) {
              throw new Error(`${p}: not JSON: ${(err as Error).message}`);
            }
          }
          if (p === "allowlist.json") {
            const before = (() => {
              const t = existsSync(join(deps.configDir, p)) ? readFileSync(join(deps.configDir, p), "utf8") : undefined;
              return t === undefined ? [] : ((JSON.parse(t) as { entities?: Array<{ id?: string; operate?: boolean }> }).entities ?? []).filter((e) => e.operate === true).map((e) => e.id);
            })();
            const widened = ((JSON.parse(content) as { entities?: Array<{ id?: string; operate?: boolean }> }).entities ?? []).filter((e) => e.operate === true && !before.includes(e.id)).map((e) => e.id);
            if (widened.length > 0) throw new Error(`allowlist.json: this would let Teobeanie switch ${widened.join(", ")}; only scope_operate does that, with the reason`);
          }
          if (p === "heuristics.json" && readInstances(content).some((i) => i.mode === "active" && readInstance(heuristicsText() ?? '{"instances":[]}', `${i.heuristic}/${i.id}`)?.mode !== "active")) {
            throw new Error("heuristics.json: this would make an instance active; only instance_mode does that, after its checks");
          }
          const o = await deps.reloader.write({ by: by(), apply: () => writeFiles(deps.configDir, { [p]: content }) });
          return applied(o, { path: p });
        },
      ),
      "write",
    ),

    annotate(
      tool(
        "types",
        "Write the config folder's typings from the house as it is now: heuristics/ha.d.ts (the house scope's entities, operable ones take .to(), and the facts), .teob/ (the \"teobeanie\" module and heuristics.schema.json) and a tsconfig.json when there is none. Generated files: no revision, no reload.",
        {},
        () => {
          const states = [...deps.liveStates()].filter((s) => deps.scope.observes(s.entity_id));
          const r = writeTypes(deps.configDir, { states, operable: deps.scope.operated, library: deps.library(), at: now() });
          return { entities: r.entities, operable: r.operable, facts: r.facts, files: r.files };
        },
      ),
      "write",
    ),

    annotate(
      tool(
        "test_run",
        "Run specs the way the Studio does, with vitest's matchers, against the kernel's simulator: a package's (package), one spec file or folder (path), or all of them (neither). Each spec with pass or fail and the failure's message. Read-only.",
        {
          package: { type: "string", description: "a package in the config folder" },
          path: { type: "string", description: "a spec file or folder under packages/ or heuristics/" },
        },
        async (a) => {
          const pkg = str(a, "package");
          const path = str(a, "path");
          let files: string[];
          if (pkg !== undefined) {
            if (!KEBAB.test(pkg) || !existsSync(join(deps.configDir, PACKAGES, pkg))) throw new Error(`no package ${pkg} in the config folder`);
            files = specFilesUnder(deps.configDir, `${PACKAGES}/${pkg}`);
          } else if (path !== undefined) {
            const p = posix.normalize(path).replace(/\/$/, "");
            if (p !== path.replace(/\/$/, "") || p.split("/").includes("..") || !(p.startsWith(`${PACKAGES}/`) || p.startsWith("heuristics/") || p === PACKAGES || p === "heuristics")) {
              throw new Error(`${path}: a spec file or folder under packages/ or heuristics/`);
            }
            files = specFilesUnder(deps.configDir, p);
          } else files = [...specFilesUnder(deps.configDir, PACKAGES), ...specFilesUnder(deps.configDir, "heuristics")];
          if (files.length === 0) throw new Error("no spec files there (*.test.ts)");
          return shownRun(await runSpecs({ configDir: deps.configDir, files, ...(deps.specTimeoutMs !== undefined ? { timeoutMs: deps.specTimeoutMs } : {}) }));
        },
      ),
      "read",
    ),

    annotate(
      tool(
        "replay",
        "Run an instance over the recorder's last days (at most 7) and compare what it would have done with what happened to the entities it owns, and who did that. Its facts are evaluated over the same history. Calls nothing. With replaces (a user as the logbook names it, e.g. Supervisor for Node-RED), Teobeanie drives its entities in place of that one and is compared with it alone. Read-only.",
        {
          instance: { type: "string", description: "instance key, <heuristic>/<id>" },
          days: { type: "number", description: "default 3, at most 7" },
          params: { type: "object", description: "try other params without editing the instance" },
          replaces: { type: "string", description: "who Teobeanie would take over from, as the logbook names it" },
          window_sec: { type: "number", description: "how close a call and a change must be to match (default 120)" },
        },
        async (a) => {
          const key = keyOf(a, "instance");
          const text = heuristicsText();
          const inst = deps.instances().find((i) => i.key === key) ?? (text !== undefined ? readInstance(text, key) : undefined);
          if (inst === undefined) throw new Error(`no instance ${key}`);
          const def = defOf(inst.heuristic);
          if (def === undefined) throw new Error(`no heuristic ${inst.heuristic} in the library`);
          const params = a["params"] !== undefined ? a["params"] : inst.params;
          const invalid = validateParams(def, params);
          if (invalid.length > 0) throw new Error(`${inst.heuristic}: the params do not fit its schema: ${invalid.join("; ")}`);
          const days = num(a, "days", 3, 1, 7);
          const windowMs = num(a, "window_sec", 120, 1, 3600) * 1000;
          const to = now();
          const from = to - days * DAY_MS;
          const house = deps.house;
          const facts = factsFor(def, params, deps.library().facts, house);
          if (facts.unknown.length > 0) throw new Error(`${inst.heuristic} reads fact ${facts.unknown.join(", ")}, which nothing in the library defines`);
          const entities = replayEntities(def, params, house, facts.entities);
          const owned = def.actuates(params);
          type Compressed = { s: string; a?: Record<string, unknown>; lu: number; lc?: number };
          const history = await deps.ha.send<Record<string, Compressed[]>>({
            type: "history/history_during_period",
            start_time: new Date(from).toISOString(),
            end_time: new Date(to).toISOString(),
            entity_ids: entities,
            minimal_response: false,
            no_attributes: false,
            significant_changes_only: false,
          });
          const recorded: Recorded[] = Object.entries(history).flatMap(([entity, rows]) => {
            let attrs: Record<string, unknown> = {};
            return rows.map((r) => {
              attrs = r.a ?? attrs;
              return { entity, at: Math.round(r.lu * 1000), state: r.s, attributes: attrs };
            });
          });
          const missing = entities.filter((e) => !recorded.some((r) => r.entity === e));
          // Who made each change of an owned entity, from the logbook.
          type Entry = { when: number | string; state?: string; entity_id?: string; context_user_id?: string | null; context_entity_id?: string };
          const log =
            owned.length === 0
              ? []
              : await deps.ha
                  .send<Entry[]>({ type: "logbook/get_events", start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(), entity_ids: owned })
                  .catch(() => [] as Entry[]);
          const whoRows = await Promise.all(
            log.map(async (e) => ({
              entity: e.entity_id ?? "",
              at: typeof e.when === "number" ? e.when * 1000 : Date.parse(e.when),
              state: e.state ?? "",
              by: e.context_user_id ? ((await deps.users?.originOf(e.context_user_id)) ?? `user:${e.context_user_id.slice(0, 8)}`) : (e.context_entity_id ?? "device"),
            })),
          );
          const plain = (who: string): string => who.replace(/^(person|system|user):/, "");
          const who = (entity: string, at: number, state: string): string | undefined => whoRows.find((w) => w.entity === entity && w.state === state && Math.abs(w.at - at) < 2000)?.by;
          const replaces = str(a, "replaces");
          const calls = replay(def, params, recorded, { from, to }, {
            house,
            facts: facts.facts,
            ...(replaces !== undefined ? { drive: { keep: (r: Recorded) => plain(who(r.entity, r.at, r.state) ?? "") !== plain(replaces) } } : {}),
          });
          const all = houseChanges(recorded, owned).map((c) => {
            const b = who(c.entity, c.at, c.state);
            return { ...c, ...(b !== undefined ? { by: b } : {}) };
          });
          const changes = replaces === undefined ? all : all.filter((c) => plain(c.by ?? "") === plain(replaces));
          const parity = compare(calls, changes, owned, windowMs);
          return {
            instance: key,
            ...(a["params"] !== undefined ? { with_params: params } : {}),
            from: local(from),
            to: local(to),
            days,
            recorded: recorded.length,
            entities,
            ...(missing.length > 0 ? { no_history: missing } : {}),
            ...(facts.facts.length > 0 ? { facts: facts.facts.map((f) => f.id) } : {}),
            ...(replaces !== undefined ? { replaces } : {}),
            would_call: calls.length,
            parity: parity.map((r) => ({ entity: r.entity, teobeanie_calls: r.calls.length, house_changes: r.changes.length, matched: r.matched, teobeanie_only: r.teobOnly.length, house_only: r.houseOnly.length })),
            calls: calls.slice(0, 50).map((c) => ({ at: local(c.at), service: c.service, entity: c.entity, why: c.why })),
            report: formatParity(parity, windowMs, house),
          };
        },
      ),
      "read",
    ),

    annotate(
      tool(
        "scope_add",
        "Add an entity to the house scope (allowlist.json) to observe: an instance may watch and read it, never switch it. Switching is scope_operate, an operate step with a reason. One revision.",
        { entity: { type: "string" }, operate: { type: "boolean", description: "always false here" } },
        async (a) => {
          const entity = str(a, "entity");
          if (entity === undefined) throw new Error("entity is required");
          if (bool(a, "operate", false)) throw new Error("scope_add only observes: letting Teobeanie switch an entity is scope_operate, with a reason, after the owner said yes");
          const o = await deps.reloader.edit({
            file: "allowlist.json",
            by: by(),
            summary: `scope: +${entity} (observe)`,
            change: (text) => addScopeEntity(text ?? '{\n  "policyVersion": 1,\n  "entities": []\n}\n', entity),
          });
          return applied(o, { entity, operate: false });
        },
      ),
      "write",
    ),

    annotate(
      tool(
        "instance_upsert",
        "Add an instance to heuristics.json, or change one, in shadow or off: never active (instance_mode does that, after its checks), and never an instance that is active now (add a twin instead: twinOf names the instance it runs beside, in shadow, on the same inputs). Checked as the panel checks it, then applied through the reload, all or nothing. One revision.",
        {
          heuristic: { type: "string" },
          id: { type: "string", description: "kebab-case, unique per heuristic; it names the journal stream" },
          params: { type: "object" },
          mode: { type: "string", enum: ["shadow", "off"], description: "default shadow" },
          twinOf: { type: "string", description: "<heuristic>/<id> of the instance this one is a shadow twin of" },
          alerts: { type: "boolean" },
          notifyPerHour: { type: "number" },
          commandHelp: { type: "object" },
        },
        async (a) => {
          const heuristic = str(a, "heuristic");
          const id = str(a, "id");
          if (heuristic === undefined || id === undefined) throw new Error("heuristic and id are required");
          const mode = str(a, "mode") ?? "shadow";
          if (mode === "active") throw new Error("instance_upsert never makes an instance active: instance_mode does, after the specs and a day of shadow decisions");
          if (mode !== "shadow" && mode !== "off") throw new Error('mode is "shadow" or "off"');
          const twinOf = str(a, "twinOf");
          if (twinOf !== undefined && !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(twinOf)) throw new Error("twinOf is an instance key, <heuristic>/<id>");
          const def = defOf(heuristic);
          const key = `${heuristic}/${id}`;
          const fields = {
            mode,
            params: a["params"] ?? {},
            ...(a["alerts"] !== undefined ? { alerts: bool(a, "alerts", false) } : {}),
            ...(a["notifyPerHour"] !== undefined ? { notifyPerHour: a["notifyPerHour"] as number } : {}),
            ...(a["commandHelp"] !== undefined ? { commandHelp: a["commandHelp"] as Record<string, string> } : {}),
          } as Pick<InstanceConfig, "mode" | "params" | "alerts" | "notifyPerHour" | "commandHelp">;
          const o = await deps.reloader.edit({
            file: "heuristics.json",
            by: by(),
            change: (text) => {
              const current = text ?? '{\n  "instances": []\n}\n';
              const before = readInstance(current, key);
              if (before?.mode === "active") throw new Error(`${key} is active: instance_upsert never changes an active instance. Add a twin (twinOf: "${key}") with the change, or take it to shadow with instance_mode first`);
              const taken = readInstances(current).filter((i) => i.heuristic === heuristic).map((i) => i.id);
              const problems = [
                ...(def === undefined ? [`heuristic: no heuristic ${heuristic} in the library`] : []),
                ...(before === undefined ? [newIdProblem(id, taken)].filter((p): p is string => p !== undefined) : []),
                ...(!INSTANCE_ID.test(id) ? [`id: ${id} is not kebab-case`] : []),
                ...checkInstance(def?.params?.spec, fields),
                ...(twinOf !== undefined && readInstance(current, twinOf) === undefined ? [`twinOf: no instance ${twinOf}`] : []),
              ];
              if (problems.length > 0) throw new Error([...new Set(problems)].join("; "));
              let next = before === undefined ? addInstance(current, { heuristic, id, ...fields }) : replaceInstance(current, key, fields);
              if (twinOf !== undefined) next = setInstanceField(next, key, "twinOf", twinOf);
              return { text: next, summary: `${describeEdit(key, before, readInstance(next, key))}${twinOf !== undefined ? `, twin of ${twinOf}` : ""}` };
            },
          });
          return applied(o, { instance: key, mode });
        },
      ),
      "write",
    ),

    annotate(
      tool(
        "package_export",
        "A package made fit to share: the house's entity ids in its example replaced by its roles' placeholders, then the privacy scan (the house's entity ids, chat ids, tokens, private addresses, the deny list) over every file. Answers the files when the scan is clean, else the hits to fix first. Writes nothing. Read-only.",
        { name: { type: "string" } },
        (a) => {
          const name = str(a, "name");
          const pkg = deps.library().packages.find((p) => p.name === name);
          if (pkg === undefined) throw new Error(`no package ${name ?? ""} loaded from the config folder`);
          const roles = Object.values(pkg.manifest.heuristics).reduce<Record<string, { domain: string | string[]; many?: boolean }>>((acc, h) => ({ ...acc, ...(h.roles ?? {}) }), {});
          const files: Record<string, string> = {};
          const placeholders: string[] = [];
          for (const f of pkg.files) {
            const text = readFileSync(join(pkg.dir, f), "utf8");
            if (f === "example.json") {
              try {
                const ex = JSON.parse(text) as { id?: string; params?: unknown };
                const p = placeholderParams(ex.params, roles);
                placeholders.push(...p.ids);
                files[f] = `${JSON.stringify({ ...ex, id: "example", params: p.params }, null, 2)}\n`;
                continue;
              } catch {
                // left as written: the scan says what is in it
              }
            }
            files[f] = text;
          }
          // The house's own ids, wherever they are: the scan's placeholders do not cover them.
          const houseIds = [...deps.liveStates()].map((s) => s.entity_id).concat(deps.scope.observed);
          const hits: PrivacyHit[] = [];
          for (const [f, text] of Object.entries(files)) {
            text.split("\n").forEach((line, i) => {
              for (const id of houseIds) if (new RegExp(`(?<![\\w.])${id.replace(/\./g, "\\.")}(?![\\w])`).test(line)) hits.push({ file: f, line: i + 1, rule: "entity-id", reason: "an entity id of this house" });
            });
          }
          const tmp = mkdtempSync(join(tmpdir(), "teobeanie-export-"));
          try {
            for (const [f, text] of Object.entries(files)) {
              mkdirSync(dirname(join(tmp, f)), { recursive: true });
              writeFileSync(join(tmp, f), text);
            }
            hits.push(...scanFolder(tmp, { deny: loadDenyList().words, allowObjectIds: placeholders }));
          } finally {
            rmSync(tmp, { recursive: true, force: true });
          }
          const unique = [...new Map(hits.map((h) => [`${h.file}:${h.line}:${h.rule}:${h.reason}`, h])).values()];
          if (unique.length > 0) return { package: pkg.name, exportable: false, hits: unique.map(formatHit) };
          return { package: pkg.name, version: pkg.version, exportable: true, files };
        },
      ),
      "read",
    ),
  ];

  // ---- operate ----

  const operate: AnnotatedTool[] = [
    annotate(
      tool(
        "instance_mode",
        "Set an instance's mode: off, shadow (decides and journals, never acts) or active (acts through the SafeActuator). Active is refused unless the instance's specs pass now (they are run) and it decided in shadow within the last 24 h, unless override_reason says why (journaled). Taking a guard out of active also needs a reason. One revision; the answer names the rollback.",
        {
          key: { type: "string", description: "instance key, <heuristic>/<id>" },
          mode: { type: "string", enum: ["off", "shadow", "active"] },
          override_reason: { type: "string", description: "why the checks are skipped: the owner's words; journaled" },
        },
        async (a) => {
          const key = keyOf(a);
          const mode = str(a, "mode");
          if (mode !== "off" && mode !== "shadow" && mode !== "active") throw new Error('mode is "off", "shadow" or "active"');
          const override = str(a, "override_reason")?.trim().slice(0, 300) || undefined;
          const text = heuristicsText();
          const configured = text === undefined ? undefined : readInstance(text, key);
          if (configured === undefined) throw new Error(`heuristics.json: no instance ${key}`);
          const running = deps.instances().find((i) => i.key === key);
          const checks: Record<string, unknown> = {};
          if (mode === "active" && configured.mode !== "active") {
            const files = specsOf(configured.heuristic);
            const run = files.length > 0 ? await runSpecs({ configDir: deps.configDir, files, ...(deps.specTimeoutMs !== undefined ? { timeoutMs: deps.specTimeoutMs } : {}) }) : undefined;
            const specsOk = run !== undefined && run.failed === 0 && run.passed > 0;
            const shadow = lastShadowDecision(key, now() - DAY_MS);
            checks["specs"] = run === undefined ? "none found" : `${run.passed} passed, ${run.failed} failed`;
            checks["shadow_decision"] = shadow === undefined ? "none in the last 24 h" : { at: local(shadow.at), ...(shadow.event_id !== undefined ? { event_id: shadow.event_id } : {}) };
            const refusals = [
              ...(!specsOk ? [run === undefined ? "it has no specs" : `its specs do not pass (${run.failed} failed${run.timedOut ? ", timed out" : ""}): ${run.specs.filter((s) => !s.ok).slice(0, 3).map((s) => `${s.name}: ${s.error}`).join("; ")}`] : []),
              ...(shadow === undefined ? ["it has not decided in shadow within the last 24 h"] : []),
            ];
            if (refusals.length > 0 && override === undefined) throw new Error(`refused: ${key} stays ${configured.mode ?? "shadow"} because ${refusals.join(", and ")}. Give override_reason (journaled) only on the owner's say-so`);
            if (refusals.length > 0) checks["overridden"] = refusals;
          }
          if ((running?.pattern ?? defOf(configured.heuristic)?.pattern) === "guard" && (configured.mode ?? "shadow") === "active" && mode !== "active" && override === undefined) {
            throw new Error(`refused: ${key} is a guard; taking it out of active needs override_reason (journaled), on the owner's say-so`);
          }
          const parent = deps.revisions.last()?.revision;
          const o = await deps.reloader.edit({
            file: "heuristics.json",
            by: by(),
            change: (t) => {
              if (t === undefined) throw new Error("no heuristics.json");
              const next = setInstanceMode(t, key, mode);
              return { text: next, summary: `${describeEdit(key, readInstance(t, key), readInstance(next, key))}${override !== undefined ? ` (override: ${override})` : ""}` };
            },
          });
          const after = deps.instances().find((i) => i.key === key);
          return {
            ...applied(o, { instance: key, mode }),
            ...(Object.keys(checks).length > 0 ? { checks } : {}),
            ...(after !== undefined && after.mode !== after.configuredMode ? { runs: after.mode, note: "the add-on's shadow_mode option forces every instance to shadow: turning it off is the owner's step" } : {}),
            ...(parent !== undefined && o.journaled?.revision !== undefined ? { rollback: `rollback with n: ${parent}` } : {}),
          };
        },
      ),
      "operate",
    ),

    annotate(
      tool(
        "scope_operate",
        "Let Teobeanie switch an entity already in the house scope (\"operate\": true in allowlist.json), with the reason the owner gave: which behaviour switches it and why. Journaled with the reason. One revision.",
        { entity: { type: "string" }, operate: { type: "boolean", description: "always true here" }, reason: { type: "string" } },
        async (a) => {
          const entity = str(a, "entity");
          const reason = str(a, "reason")?.trim().slice(0, 300);
          if (entity === undefined) throw new Error("entity is required");
          if (a["operate"] !== undefined && !bool(a, "operate", true)) throw new Error("scope_operate only widens: to stop operating an entity, write allowlist.json with file_write");
          if (!reason) throw new Error("reason is required: which behaviour switches it and why, as told to the owner");
          const o = await deps.reloader.edit({
            file: "allowlist.json",
            by: by(),
            summary: `scope: ${entity} may be operated (${reason})`,
            change: (text) => {
              if (text === undefined) throw new Error("no allowlist.json");
              const entry = scopeEntry(text, entity);
              if (entry?.operate === true) throw new Error(`${entity} is already operable`);
              return setScopeOperate(text, entity);
            },
          });
          return applied(o, { entity, operate: true, reason });
        },
      ),
      "operate",
    ),

    annotate(
      tool(
        "revisions",
        "The working set's revisions, newest first: number, when, who (mcp:… for an agent), what changed and which files. Read-only.",
        { limit: { type: "number", description: "default 20, max 200" } },
        (a) =>
          listRevisions(deps.revisions)
            .slice(0, num(a, "limit", 20, 1, 200))
            .map((r) => ({ revision: r.revision, ...(r.parent !== undefined ? { parent: r.parent } : {}), at: local(r.at), by: r.by, summary: r.summary, file: r.file, ...(r.instances !== undefined ? { instances: r.instances } : {}) })),
      ),
      "read",
    ),

    annotate(
      tool(
        "revision_diff",
        "What changed from revision a to revision b: a unified diff per file. Read-only.",
        { a: { type: "number" }, b: { type: "number" }, path: { type: "string", description: "only this file" } },
        (args) => {
          const a = num(args, "a", NaN, 1, Number.MAX_SAFE_INTEGER);
          const b = num(args, "b", NaN, 1, Number.MAX_SAFE_INTEGER);
          if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("a and b are required");
          const only = str(args, "path");
          return {
            from: a,
            to: b,
            files: diffRevisions(deps.revisions, a, b)
              .filter((f) => only === undefined || f.path === only)
              .map((f) => ({ ...f, diff: f.diff.length > 20_000 ? `${f.diff.slice(0, 20_000)}\n… (cut)` : f.diff })),
          };
        },
      ),
      "read",
    ),

    annotate(
      tool(
        "rollback",
        "Put the working set back to revision n: its files written back (only those that differ; files it did not have removed), applied through the reload, all or nothing. Itself a new revision, so it can be undone the same way.",
        { n: { type: "number" } },
        async (a) => {
          const n = num(a, "n", NaN, 1, Number.MAX_SAFE_INTEGER);
          if (!Number.isFinite(n)) throw new Error("n is required");
          const o = await rollback({ store: deps.revisions, reloader: deps.reloader }, Math.round(n), by());
          return applied(o, { to: Math.round(n) });
        },
      ),
      "operate",
    ),

    annotate(
      tool(
        "twin_compare",
        "A shadow twin against its original: per input signal and fact change, whether they decided the same actions, and where they differ. key is the twin's, or the original's. Default range: the last day. Read-only.",
        {
          key: { type: "string" },
          from: { type: "number", description: "epoch ms" },
          to: { type: "number", description: "epoch ms" },
          limit: { type: "number", description: "differences shown, default 20" },
        },
        (a) => {
          const key = keyOf(a);
          const all = deps.instances();
          const twin = all.find((i) => i.key === key && i.twinOf !== undefined) ?? all.find((i) => i.twinOf === key);
          if (twin === undefined) throw new Error(`${key} is no running twin, and has none`);
          const toMs = num(a, "to", now(), 0, Number.MAX_SAFE_INTEGER);
          const fromMs = num(a, "from", toMs - DAY_MS, 0, toMs);
          const c = compareTwin(deps.journal, twin.key, twin.twinOf!, { fromMs, toMs }, num(a, "limit", 20, 1, 200));
          return { ...c, from: local(c.from), to: local(c.to), differences: c.differences.map((d) => ({ ...d, at: local(d.at) })) };
        },
      ),
      "read",
    ),

    annotate(
      tool(
        "promote",
        "Promote a shadow twin over its original: in one edit of heuristics.json the original is removed (its journal stays) and the twin takes its id and its mode. One revision, which rollback undoes.",
        { key: { type: "string", description: "the twin's key" } },
        async (a) => {
          const key = keyOf(a);
          const o = await promoteTwin({ reloader: deps.reloader }, key, by());
          return applied(o, { promoted: key });
        },
      ),
      "operate",
    ),

    annotate(
      tool(
        "pause",
        "Pause every behaviour: each call and notice is refused with \"all heuristics paused\", except a guard's (a guard always acts). Instances still decide and journal. Journaled with who and why; survives a restart.",
        { reason: { type: "string" } },
        async (a) => {
          const reason = str(a, "reason")?.trim().slice(0, 200) || undefined;
          const s = await deps.pause.set(true, by(), reason);
          return { paused: s.paused, by: s.by, ...(s.reason !== undefined ? { reason: s.reason } : {}), note: "guards still act" };
        },
      ),
      "operate",
    ),

    annotate(
      tool("resume", "Resume after a pause: behaviours act again. Journaled with who.", {}, async () => {
        const s = await deps.pause.set(false, by());
        return { paused: s.paused, by: s.by };
      }),
      "operate",
    ),

    annotate(
      tool(
        "command",
        "Send a named command to the behaviours that answer it (heuristics lists their commands), as Telegram or the panel would, with this agent as the sender. The behaviour decides and acts through the SafeActuator; its reply is a notice. Journaled with the decision.",
        { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
        (a) => {
          const name = str(a, "name");
          const args = strs(a, "args") ?? [];
          if (name === undefined || !COMMAND_NAME.test(name)) throw new Error("name is a command name: letters, digits and _");
          if (args.length > 8 || !args.every((x) => x.length > 0 && x.length <= 64)) throw new Error("args: at most 8 words of at most 64 characters");
          const reached = deps.command(name.toLowerCase(), args, { channel: "mcp", user: by() });
          if (reached.length === 0) throw new Error(`no running instance answers /${name.toLowerCase()}`);
          return { command: name.toLowerCase(), args, reached };
        },
      ),
      "operate",
    ),
  ];

  return [...develop, ...operate];
}

/** The server's instructions, after the read tools' own (tools.ts INSTRUCTIONS). */
export const DEVELOP_INSTRUCTIONS = `Work in this order: explore (the read tools), develop in shadow, then operate. Develop: package_list, package_install (a starter package), package_scaffold (a new one), file_read and file_write (the working set), types, test_run (specs), replay (the recorder's last days), scope_add (observe only), instance_upsert (shadow or off), package_export. Operate: instance_mode, scope_operate, rollback, promote, pause, resume, command; revisions, revision_diff and twin_compare show what changed. Every write is one revision of the working set, applied all or nothing and journaled with you as mcp:<you>; the answer names the revision and the one to roll back to. No tool switches a device: behaviours act, through the SafeActuator.
The agent skills (onboard, develop, operate, explain) carry the guardrails: show the owner the specs, the replay and a day of shadow decisions, get a yes, name the rollback revision, then act; never pause or weaken a guard; never widen operate without saying which entity and why. The platform checks too: active needs passing specs and a shadow decision in the last day (or a journaled override_reason).`;
