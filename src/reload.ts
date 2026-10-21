// reload.ts — config changes without an add-on restart. The working set is read again
// when one of its files changes in the config folder (heuristics.json, allowlist.json,
// tiles.json, the lock, anything under heuristics/ or packages/; 1 s after the last
// change) or on POST api/reload. The whole config is validated first and applied only when all of it is
// valid: the scope, the routing, the House view and the heuristic instances, of
// which only the added and changed ones start. An invalid config is rejected with
// its reason, and the running set stays exactly as it was.
//
// A reload that changed something is journaled as a ConfigChanged (working-set.ts) with
// who did it: the file watch, the panel's HA user, the CLI. With a revision store it is
// also the working set's next revision (revisions.ts). The panel's own edits (an
// instance's mode, whole instances, a rollback, a promote) write the files, reload and
// journal in one step (`Reloader.write`), and put the files back when the reload
// rejects them.

import { existsSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { loadAllowlist, type Allowlist } from "./allowlist.js";
import { loadHouseConfig, type TileSpec } from "./tiles.js";
import type { GroupsConfig } from "./house/layout.js";
import { loadInstances, type HeuristicHost, type InstanceConfig, type InstanceInfo, type PreparedReload, type ReloadChanges } from "./kernel/host.js";
import { loadLibrary, type HeuristicSource, type PackageInfo } from "./packages/library.js";
import type { AnyHeuristic } from "./kernel/heuristic.js";
import { mayWrite } from "./studio/files.js";
import { requestUser } from "./pause.js";
import { changedFiles, configFingerprint, describeChanges, type ConfigChange } from "./working-set.js";
import { LOCK_FILE } from "./packages/lock.js";
import { inWorkingSet, type RevisionStore } from "./revisions.js";

/** The config files the panel edits as text. */
export const CONFIG_FILES = ["heuristics.json", "allowlist.json", "tiles.json"];

/** The top-level files whose digest says whether a reload changed a file (with heuristics/ and packages/). */
const FINGERPRINT_FILES = [...CONFIG_FILES, LOCK_FILE];

/** The add-on log convention: debug | info | warning | error. */
type Log = (level: string, msg: string) => void;

export interface ConfigFiles {
  allowlist: Allowlist;
  tiles: TileSpec[];
  groups: GroupsConfig;
  /** The packages' heuristics and the house's own files'. */
  library: AnyHeuristic[];
  /** The packages they came from. */
  packages: PackageInfo[];
  /** Per heuristic id, its file and package. */
  sources: Map<string, HeuristicSource>;
  instances: InstanceConfig[];
}

/**
 * Read the config folder. Throws with the reason when any part of it is unusable.
 * `extra`: definitions the folder does not hold, ahead of its own (tests).
 */
export async function readConfig(configDir: string, log: Log, extra: AnyHeuristic[] = []): Promise<ConfigFiles> {
  const allowlist = loadAllowlist(configDir, log);
  const { tiles, groups } = loadHouseConfig(configDir, log);
  const failures: string[] = [];
  const teobLog = (level: string, msg: string): void => log(level === "warn" ? "warning" : level, msg);
  const lib = await loadLibrary(configDir, teobLog, failures, { taken: extra });
  if (failures.length > 0) throw new Error(failures.join("; "));
  const instances = loadInstances(configDir, teobLog);
  return { allowlist, tiles, groups, library: [...extra, ...lib.heuristics], packages: lib.packages, sources: lib.sources, instances };
}

/**
 * Read, validate and apply the config. `swap` moves the rest of the add-on over (scope,
 * routing, House view); it runs only for a valid config, right before the host
 * commits, and must not fail on config grounds.
 */
export async function applyConfig(deps: {
  configDir: string;
  /** Definitions the folder does not hold (tests). */
  extra?: AnyHeuristic[];
  host: HeuristicHost;
  log: Log;
  swap?: (next: ConfigFiles, prepared: PreparedReload) => void;
}): Promise<ReloadChanges> {
  const next = await readConfig(deps.configDir, deps.log, deps.extra);
  const prepared = deps.host.prepare({
    library: next.library,
    instances: next.instances,
    scope: next.allowlist.scope,
    house: next.allowlist.house,
  });
  deps.swap?.(next, prepared);
  await prepared.commit();
  return prepared.changes;
}

export interface ReloadOutcome {
  ok: boolean;
  at: number;
  source: "file" | "api";
  /** Who reloaded: "file" (the watch), the panel's HA user (person:<name>, …), "cli". */
  by?: string;
  /** "+1 −0 ~2 (mode) unchanged 18" */
  summary?: string;
  changes?: ReloadChanges;
  /** The ConfigChanged journaled for it; absent when nothing changed (or it was rejected). */
  journaled?: ConfigChange;
  /** Why the config was rejected; the running set is unchanged. */
  error?: string;
}

/** One line: added, removed, changed (and why), unchanged. */
export function summarize(c: ReloadChanges): string {
  const why = [...new Set(c.changed.map((x) => x.why))];
  return `+${c.added.length} −${c.removed.length} ~${c.changed.length}${why.length > 0 ? ` (${why.join(", ")})` : ""} unchanged ${c.unchanged}`;
}

/**
 * A change to one working-set file, applied through the reload path. `change` gets the
 * file's text (undefined when there is none) and returns the new text, or the new text
 * and what the change was when only the text can tell (an instance's fields before and
 * after); it throws to refuse, and then nothing is written.
 */
export interface ConfigEdit {
  file: string;
  change: (text: string | undefined) => string | { text: string; summary: string };
  /** Who: the panel's HA user (requestUser), "cli". */
  by: string;
  /** What the person did, when the reload's diff says it less well; else the diff's lines. */
  summary?: string;
}

/**
 * A change to any working-set files, applied through the reload path. `apply` writes
 * them and returns how to put them back; it throws to refuse, having written nothing.
 */
export interface ConfigWrite {
  /** Who: the panel's HA user (requestUser), "cli", an agent. */
  by: string;
  /** What the person did, when the reload's diff says it less well; else the diff's lines. */
  summary?: string;
  /** Journal it (a revision) even when no file or instance changed: a rollback is always one. */
  always?: boolean;
  apply: () => () => void;
}

export interface Reloader {
  /** Reload now; reloads run one at a time, in order. */
  reload(source: ReloadOutcome["source"], opts?: { by?: string }): Promise<ReloadOutcome>;
  /**
   * Edit a working-set file and reload, in turn with the other reloads: written, applied
   * and journaled with `by`, or, when the reload rejects it, the file put back as it was
   * and nothing journaled (the outcome says why). Throws when `change` refuses.
   */
  edit(edit: ConfigEdit): Promise<ReloadOutcome>;
  /** The same for any working-set files: `apply` writes them, and its result puts them back on a rejection. */
  write(write: ConfigWrite): Promise<ReloadOutcome>;
  /** The latest reload since boot, if any. */
  last(): ReloadOutcome | undefined;
}

export function createReloader(opts: {
  apply: () => Promise<ReloadChanges>;
  log: Log;
  /** Told of every outcome (the add-on publishes it to the panel). */
  onReloaded?: (outcome: ReloadOutcome) => void;
  /** The config folder: which files a reload changed, and where edits are written. */
  configDir?: string;
  /** The running instances, for the journaled summary ("params changed (maxRunMin 180 → 240)"). */
  instances?: () => InstanceInfo[];
  /** Journal a reload that changed something (working-set.ts createConfigJournal). */
  record?: (change: ConfigChange) => Promise<void>;
  /** Each journaled change is the working set's next revision, its files stored here. */
  revisions?: RevisionStore;
  now?: () => number;
}): Reloader {
  const now = opts.now ?? Date.now;
  const files = (): Map<string, string> => (opts.configDir !== undefined ? configFingerprint(opts.configDir, FINGERPRINT_FILES) : new Map());
  let chain: Promise<unknown> = Promise.resolve();
  let last: ReloadOutcome | undefined;
  // What the running set was read from: boot read it just before.
  let applied = files();

  /**
   * The ConfigChanged of an applied reload, when it changed a file or an instance (or
   * `always`). With revisions, a file that changed at all (a test, a README, a re-indent)
   * counts too, and the change carries the new revision.
   */
  const journal = async (changes: ReloadChanges, touched: string[], before: InstanceInfo[], at: number, by: string, summary?: string, always = false): Promise<ConfigChange | undefined> => {
    const keys = [...changes.added, ...changes.removed, ...changes.changed.map((c) => c.key)];
    if (opts.record === undefined) return undefined;
    const rev = opts.revisions?.next();
    const files = [...new Set([...touched, ...(rev?.changed ?? [])])].sort();
    if (files.length === 0 && keys.length === 0 && !always) return undefined;
    const lines = describeChanges(changes, before, opts.instances?.() ?? []);
    const change: ConfigChange = {
      at,
      file: files.join(", ") || "config",
      by,
      summary: summary ?? (lines.length > 0 ? lines.join("; ") : "no instance changed"),
      // A scope change may change what any instance sees: global.
      ...(files.includes("allowlist.json") ? {} : { instances: keys }),
      ...(rev !== undefined ? { revision: rev.revision, ...(rev.parent !== undefined ? { parent: rev.parent } : {}), files: rev.files } : {}),
    };
    try {
      await opts.record(change);
      opts.revisions?.add(change);
      return change;
    } catch (err) {
      opts.log("error", `config journal: ${String(err)}`);
      return undefined;
    }
  };

  const attempt = async (source: ReloadOutcome["source"], by: string, summary?: string, always = false): Promise<ReloadOutcome> => {
    let outcome: ReloadOutcome;
    const before = opts.instances?.() ?? [];
    const read = files();
    try {
      const changes = await opts.apply();
      const touched = changedFiles(applied, read);
      applied = read;
      outcome = { ok: true, at: now(), source, by, summary: summarize(changes), changes };
      const keys = [
        ...changes.added.map((k) => `+${k}`),
        ...changes.removed.map((k) => `−${k}`),
        ...changes.changed.map((c) => `~${c.key} (${c.why})`),
      ];
      opts.log("info", `reload (${source}): ${outcome.summary}${keys.length > 0 ? ` — ${keys.join(", ")}` : ""}`);
      const journaled = await journal(changes, touched, before, outcome.at, by, summary, always);
      if (journaled !== undefined) outcome.journaled = journaled;
    } catch (err) {
      outcome = { ok: false, at: now(), source, by, error: (err as Error).message ?? String(err) };
      opts.log("warning", `reload (${source}) rejected, the running config stays: ${outcome.error}`);
    }
    last = outcome;
    opts.onReloaded?.(outcome);
    return outcome;
  };

  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  };

  /** Write, reload, and put the files back when the reload rejects them. */
  const write = async (w: ConfigWrite): Promise<ReloadOutcome> => {
    const restore = w.apply();
    // The file watch sees these writes too; its reload finds nothing new to journal.
    const outcome = await attempt("api", w.by, w.summary, w.always === true);
    if (!outcome.ok) restore();
    return outcome;
  };

  return {
    reload(source, o) {
      return inTurn(() => attempt(source, o?.by ?? (source === "file" ? "file" : "api")));
    },
    edit(e) {
      return inTurn(async () => {
        if (opts.configDir === undefined) throw new Error("no config folder to edit");
        if (!CONFIG_FILES.includes(e.file)) throw new Error(`${e.file}: not a config file`);
        const path = join(opts.configDir, e.file);
        const old = existsSync(path) ? readFileSync(path, "utf8") : undefined;
        const changed = e.change(old);
        const { text, summary } = typeof changed === "string" ? { text: changed, summary: e.summary } : changed;
        return write({
          by: e.by,
          ...(summary !== undefined ? { summary } : {}),
          apply: () => {
            if (text !== old) writeFileSync(path, text);
            return () => {
              if (old === undefined) unlinkSync(path);
              else writeFileSync(path, old);
            };
          },
        });
      });
    },
    write: (w) => inTurn(() => write(w)),
    last: () => last,
  };
}

/** fs.watch's shape, as far as the watcher uses it (tests pass a fake). File names are relative to `dir`, sub-folders included. */
export type WatchFn = (dir: string, listener: (event: string, filename: string | null) => void) => { close(): void };

const fsWatch: WatchFn = (dir, listener) => {
  // Recursive: heuristics/ and packages/ are part of the working set.
  const w = watch(dir, { recursive: true }, (event, filename) => listener(event, filename === null ? null : String(filename)));
  // A watch that breaks (the folder removed) stops reloading; the endpoint still works.
  w.on("error", () => w.close());
  return w;
};

/**
 * Call `onChange` once the working set's files have been quiet for `debounceMs`: an
 * editor's save is several events (write, rename, chmod), a copy of a package is more.
 * The files: heuristics.json, allowlist.json, tiles.json, the lock, and anything under
 * heuristics/ and packages/ but dot files and the generated typings (`files` narrows it).
 */
export function watchConfig(opts: {
  dir: string;
  onChange: (files: string[]) => void;
  log: Log;
  files?: string[];
  debounceMs?: number;
  watch?: WatchFn;
}): { close(): void } {
  const watched = (f: string): boolean => {
    const p = f.split("\\").join("/");
    if (opts.files !== undefined) return opts.files.includes(p);
    // The folders themselves too: one created, removed or renamed whole.
    return p === "heuristics" || p === "packages" || inWorkingSet(p);
  };
  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    timer = undefined;
    const list = [...changed].sort();
    changed.clear();
    opts.onChange(list);
  };
  try {
    const w = (opts.watch ?? fsWatch)(opts.dir, (_event, filename) => {
      // No file name (some platforms): it may have been one of ours.
      if (filename !== null && !watched(filename)) return;
      changed.add(filename ?? "?");
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, opts.debounceMs ?? 1000);
    });
    return {
      close() {
        if (timer !== undefined) clearTimeout(timer);
        w.close();
      },
    };
  } catch (err) {
    opts.log("warning", `cannot watch ${opts.dir} (${String(err)}): config changes need POST api/reload or a restart`);
    return { close() {} };
  }
}

/** POST api/reload: through Home Assistant ingress only, like the Studio's writes. */
export function mountReload(app: Hono, deps: { mode: "addon" | "standalone"; reloader: Reloader }): void {
  app.post("/api/reload", async (c) => {
    const peer = (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;
    if (!mayWrite(deps.mode, peer)) return c.json({ error: "Forbidden", reason: "reload through the Home Assistant panel only" }, 403);
    const outcome = await deps.reloader.reload("api", { by: requestUser((n) => c.req.header(n)) });
    return c.json(outcome, outcome.ok ? 200 : 422);
  });
}
