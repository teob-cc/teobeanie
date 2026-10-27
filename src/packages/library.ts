// library.ts — the heuristics a house can run: its behaviour packages
// (<config>/packages/<name>/, each with a teobeanie.json) and its own files
// (<config>/heuristics/*.ts), loaded together. The image ships no heuristics of its
// own: the starter packages (packages/ in the repository) are copied into the config
// folder on start and on `teobeanie init`, and are then the house's to change.
//
// Loading is all or nothing per package: a package whose manifest is wrong, whose
// platform range leaves this version out, whose code fails to load, or whose code and
// manifest disagree (ids, patterns, uses, roles) is skipped as a whole, and a reload
// with such a package is rejected. Two packages (or a package and a file) defining one
// heuristic id is an error, as between two files.
//
// Installing never overwrites: a starter package already in the folder stays as it is,
// and the lock records whether it still matches what was installed ("modified" when
// not). A starter package the house removed stays removed, unless an instance in
// heuristics.json names one of its heuristics.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyHeuristic } from "../kernel/heuristic.js";
import type { AnyFact } from "../kernel/fact.js";
import { heuristicFiles, isHeuristicSource, loadModules, type LoadedFact, type SourceModule } from "../kernel/custom.js";
import { checkAgainstDefinition, MANIFEST, parseManifest, satisfies, SDK_VERSION, type Manifest } from "./manifest.js";
import { packageFiles, packageHash, readLock, writeLock, type Lock, type LockEntry, type Origin } from "./lock.js";

/** The starter packages: packages/ next to src/ (and dist/ in the image). */
export const STARTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages");

export const PACKAGES = "packages";

type Log = (level: "debug" | "info" | "warn" | "error", msg: string) => void;

/** A package as the house has it: the catalogue, the Studio and the MCP tools show this. */
export interface PackageInfo {
  name: string;
  version: string;
  title: string;
  description?: string;
  pattern?: Manifest["pattern"];
  origin: Origin;
  /** Its files differ from what was installed (a starter package the house changed). */
  modified: boolean;
  /** The add-on ships another version of it. */
  upstream?: { version: string; hash: string };
  /** Where it is: the config folder, or the add-on's starter set (the CLI, before install). */
  dir: string;
  installed: boolean;
  /** Its files, relative to dir. */
  files: string[];
  /** The heuristic ids it defines. */
  heuristics: string[];
  /** Per heuristic id, the file (relative to dir) that defines it. */
  sources: Record<string, string>;
  /** The fact ids it defines (fact.ts), with the file of each (relative to dir). */
  facts: string[];
  factSources: Record<string, string>;
  manifest: Manifest;
}

/** Where a heuristic (or a fact) came from. */
export interface HeuristicSource {
  file: string;
  /** Its package's name; absent: a file in heuristics/. */
  package?: string;
  /** A fact's export: its name in the module, or "default" (custom.ts LoadedFact.binding). */
  binding?: string;
}

export interface Library {
  heuristics: AnyHeuristic[];
  packages: PackageInfo[];
  sources: Map<string, HeuristicSource>;
  /** The facts the packages and the house's files define (fact.ts), and where each is. */
  facts: AnyFact[];
  factSources: Map<string, HeuristicSource>;
}

export interface StarterPackage {
  name: string;
  dir: string;
  manifest: Manifest;
  hash: string;
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** A package folder's manifest, checked (the name must be the folder's). */
export function readManifest(dir: string): Manifest {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) throw new Error(`no ${MANIFEST}`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${MANIFEST}: unparseable JSON: ${(err as Error).message}`);
  }
  return parseManifest(json, dir.split(/[\\/]/).pop());
}

/** The starter set the add-on ships, by name (a folder without a valid manifest is none). */
export function starterPackages(starterDir = STARTER_DIR): StarterPackage[] {
  if (!isDir(starterDir)) return [];
  return readdirSync(starterDir)
    .filter((n) => !n.startsWith(".") && isDir(join(starterDir, n)))
    .sort()
    .flatMap((name) => {
      const dir = join(starterDir, name);
      try {
        return [{ name, dir, manifest: readManifest(dir), hash: packageHash(dir) }];
      } catch {
        return [];
      }
    });
}

/** The package folders of a config folder, by name. */
export function installedPackageDirs(configDir: string): string[] {
  const root = join(configDir, PACKAGES);
  if (!isDir(root)) return [];
  return readdirSync(root)
    .filter((n) => !n.startsWith(".") && isDir(join(root, n)))
    .sort()
    .map((n) => join(root, n));
}

/** The modules that default-export a package's heuristics. */
function entryModules(dir: string, name: string, manifest: Manifest, version: string): SourceModule[] {
  const main = manifest.main === undefined ? undefined : Array.isArray(manifest.main) ? manifest.main : [manifest.main];
  const files = main ?? readdirSync(dir).filter((f) => isHeuristicSource(f) && !isDir(join(dir, f))).sort();
  if (files.length === 0) throw new Error("no source file");
  return files.map((f) => {
    if (!existsSync(join(dir, f))) throw new Error(`main: no file ${f}`);
    return { file: join(dir, f), label: `${PACKAGES}/${name}/${f}`, version };
  });
}

/** Where a package came from and whether the house changed it, from the lock and the starter set. */
function provenance(name: string, hash: string, lock: Lock, starters: StarterPackage[]): Pick<PackageInfo, "origin" | "modified" | "upstream"> {
  const entry: LockEntry | undefined = lock.packages[name];
  const starter = starters.find((s) => s.name === name);
  const origin = entry?.origin ?? (starter !== undefined ? "starter" : "local");
  // Files that are exactly the add-on's version are that version, however they got there.
  if (origin === "starter" && starter !== undefined && hash === starter.hash) return { origin, modified: false };
  const baseline = entry?.hash ?? starter?.hash;
  const modified = origin !== "local" && baseline !== undefined && hash !== baseline;
  const upstream = origin === "starter" && starter !== undefined && starter.hash !== baseline ? { version: starter.manifest.version, hash: starter.hash } : undefined;
  return { origin, modified, ...(upstream !== undefined ? { upstream } : {}) };
}

/**
 * Load the house's library: every package in <config>/packages (with `withStarter`,
 * also the starter packages not installed there, read from the add-on: the CLI on a
 * folder the add-on has not prepared), then heuristics/*. A package or file that fails
 * is logged and skipped; with `failures`, its reason is collected too (a reload rejects).
 */
export async function loadLibrary(
  configDir: string,
  log: Log,
  failures?: string[],
  opts: { starterDir?: string; withStarter?: boolean; taken?: AnyHeuristic[] } = {},
): Promise<Library> {
  const lock = readLock(configDir);
  const starters = starterPackages(opts.starterDir);
  const installed = installedPackageDirs(configDir);
  const dirs = [
    ...installed.map((dir) => ({ dir, installed: true })),
    ...(opts.withStarter ? starters.filter((s) => !installed.some((d) => d.endsWith(`/${s.name}`) || d.endsWith(`\\${s.name}`))).map((s) => ({ dir: s.dir, installed: false })) : []),
  ];
  const taken = new Set((opts.taken ?? []).map((h) => h.id));
  const heuristics: AnyHeuristic[] = [];
  const packages: PackageInfo[] = [];
  const sources = new Map<string, HeuristicSource>();
  const factsTaken = new Set<string>();
  const facts: AnyFact[] = [];
  const factSources = new Map<string, HeuristicSource>();

  for (const { dir, installed: inFolder } of dirs) {
    const name = dir.split(/[\\/]/).pop()!;
    const label = `${PACKAGES}/${name}`;
    const problems: string[] = [];
    try {
      const manifest = readManifest(dir);
      if (!satisfies(SDK_VERSION, manifest.platform)) throw new Error(`platform: needs "teobeanie" ${manifest.platform}, this is ${SDK_VERSION}`);
      const hash = packageHash(dir);
      const own = new Set(taken);
      const ownFacts: LoadedFact[] = [];
      const loaded = await loadModules(entryModules(dir, name, manifest, hash.slice(7, 23)), own, () => {}, problems, { taken: new Set(factsTaken), out: ownFacts });
      if (problems.length === 0) {
        const factIds = ownFacts.map((l) => l.fact.id);
        const named = Object.keys(manifest.facts ?? {});
        const unnamed = factIds.filter((id) => !named.includes(id));
        const undefinedFacts = named.filter((id) => !factIds.includes(id));
        if (undefinedFacts.length > 0) problems.push(`${MANIFEST} names fact ${undefinedFacts.join(", ")}, which the code does not define`);
        if (unnamed.length > 0) problems.push(`the code defines fact ${unnamed.join(", ")}, which ${MANIFEST} does not name (under "facts")`);
        const ids = loaded.map((l) => l.def.id);
        const declared = Object.keys(manifest.heuristics);
        const missing = declared.filter((id) => !ids.includes(id));
        const extra = ids.filter((id) => !declared.includes(id));
        if (missing.length > 0) problems.push(`${MANIFEST} names ${missing.join(", ")}, which the code does not define`);
        if (extra.length > 0) problems.push(`the code defines ${extra.join(", ")}, which ${MANIFEST} does not name`);
        for (const l of loaded) {
          const h = manifest.heuristics[l.def.id];
          if (h !== undefined) problems.push(...checkAgainstDefinition(l.def, h).map((p) => `heuristics.${l.def.id}.${p}`));
        }
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
      for (const l of loaded) {
        taken.add(l.def.id);
        heuristics.push(l.def);
        sources.set(l.def.id, { file: l.file, package: name });
      }
      for (const l of ownFacts) {
        factsTaken.add(l.fact.id);
        facts.push(l.fact);
        factSources.set(l.fact.id, { file: l.file, package: name, ...(l.binding !== undefined ? { binding: l.binding } : {}) });
      }
      packages.push({
        name,
        version: manifest.version,
        title: manifest.title,
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        ...(manifest.pattern !== undefined ? { pattern: manifest.pattern } : {}),
        ...(inFolder ? provenance(name, hash, lock, starters) : { origin: "starter", modified: false }),
        dir,
        installed: inFolder,
        files: packageFiles(dir),
        heuristics: loaded.map((l) => l.def.id),
        sources: Object.fromEntries(loaded.map((l) => [l.def.id, relative(dir, l.file).split("\\").join("/")])),
        facts: ownFacts.map((l) => l.fact.id),
        factSources: Object.fromEntries(ownFacts.map((l) => [l.fact.id, relative(dir, l.file).split("\\").join("/")])),
        manifest,
      });
    } catch (err) {
      const reason = (err as Error).message ?? String(err);
      log(failures === undefined ? "error" : "warn", `skipping package ${label}: ${reason}`);
      failures?.push(`${label}: ${reason}`);
    }
  }

  const ownFacts: LoadedFact[] = [];
  for (const l of await loadModules(heuristicFiles(configDir), taken, log, failures, { taken: factsTaken, out: ownFacts })) {
    heuristics.push(l.def);
    sources.set(l.def.id, { file: l.file });
  }
  for (const l of ownFacts) {
    facts.push(l.fact);
    factSources.set(l.fact.id, { file: l.file, ...(l.binding !== undefined ? { binding: l.binding } : {}) });
  }
  return { heuristics, packages, sources, facts, factSources };
}

export interface InstallReport {
  /** Copied in: new starter packages, or ones an instance needed again. */
  installed: string[];
  /** Present and changed by the house: left as they are. */
  modified: string[];
  /** Starter packages the house removed and no instance needs: left out. */
  removed: string[];
  /** The add-on ships another version of these (an installed one is never replaced). */
  upstream: string[];
  lockWritten: boolean;
}

/** The heuristic ids heuristics.json's instances name (none when it is missing or unreadable). */
export function instanceHeuristics(configDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "heuristics.json"), "utf8")) as { instances?: Array<{ heuristic?: unknown }> };
    return (parsed.instances ?? []).map((i) => i.heuristic).filter((h): h is string => typeof h === "string");
  } catch {
    return [];
  }
}

/**
 * Bring the config folder's packages up to the starter set: copy in every starter
 * package that is missing (one the house removed only when an instance names one of its
 * heuristics), never overwrite one that is there, and write the lock: origin, version
 * and hash per package, "modified" for one whose files differ from what was installed.
 */
export function installStarter(configDir: string, opts: { starterDir?: string; log?: Log } = {}): InstallReport {
  const log = opts.log ?? (() => {});
  const lock = readLock(configDir);
  const report: InstallReport = { installed: [], modified: [], removed: [], upstream: [], lockWritten: false };
  const root = join(configDir, PACKAGES);
  const needed = new Set(instanceHeuristics(configDir));
  const starters = starterPackages(opts.starterDir);

  for (const s of starters) {
    const target = join(root, s.name);
    const entry = lock.packages[s.name];
    if (!existsSync(target)) {
      const wanted = Object.keys(s.manifest.heuristics).filter((id) => needed.has(id));
      if (entry !== undefined && wanted.length === 0) {
        lock.packages[s.name] = { ...entry, removed: true };
        report.removed.push(s.name);
        continue;
      }
      mkdirSync(root, { recursive: true });
      cpSync(s.dir, target, { recursive: true, filter: (src) => !/[\\/](\.[^\\/]+|node_modules)$/.test(src) });
      lock.packages[s.name] = { origin: "starter", version: s.manifest.version, hash: s.hash };
      report.installed.push(s.name);
      log("info", `package ${s.name} ${s.manifest.version} installed from the starter set${entry !== undefined ? ` (${wanted.join(", ")} in heuristics.json needs it)` : ""}`);
      continue;
    }
    const hash = packageHash(target);
    let version = entry?.version ?? s.manifest.version;
    try {
      version = readManifest(target).version;
    } catch {
      // a broken manifest: the loader says so; the lock keeps what it knew
    }
    const next: LockEntry = entry !== undefined ? { ...entry, version } : { origin: "starter", version, hash: s.hash };
    delete next.removed;
    // Files that are exactly the add-on's version (written by hand, or an upgrade) are that version.
    if (next.origin === "starter" && hash === s.hash) next.hash = s.hash;
    next.modified = next.origin !== "local" && hash !== next.hash;
    if (!next.modified) delete next.modified;
    if (next.origin === "starter" && s.hash !== next.hash) next.upstream = { version: s.manifest.version, hash: s.hash };
    else delete next.upstream;
    lock.packages[s.name] = next;
    if (next.modified) report.modified.push(s.name);
    if (next.upstream !== undefined) report.upstream.push(s.name);
  }

  // Packages that are not the add-on's: local unless the lock says otherwise.
  const present = new Set(installedPackageDirs(configDir).map((d) => d.split(/[\\/]/).pop()!));
  for (const name of present) {
    if (starters.some((s) => s.name === name)) continue;
    const dir = join(root, name);
    const hash = packageHash(dir);
    const entry = lock.packages[name];
    let version = entry?.version ?? "0.0.0";
    try {
      version = readManifest(dir).version;
    } catch {
      // the loader reports it
    }
    if (entry === undefined || entry.origin === "local") lock.packages[name] = { origin: "local", version, hash };
    else {
      const next: LockEntry = { ...entry, version, modified: hash !== entry.hash };
      if (!next.modified) delete next.modified;
      lock.packages[name] = next;
    }
  }
  for (const name of Object.keys(lock.packages)) {
    const e = lock.packages[name]!;
    if (!present.has(name) && !starters.some((s) => s.name === name) && e.origin === "local") delete lock.packages[name];
  }

  report.lockWritten = writeLock(configDir, lock);
  if (report.modified.length > 0) log("info", `packages changed by the house, left as they are: ${report.modified.join(", ")}`);
  if (report.upstream.length > 0) log("info", `the add-on ships other versions of: ${report.upstream.join(", ")} (the installed ones stay)`);
  return report;
}
