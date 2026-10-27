// revisions.ts — the working set's history, and undo. Every applied change to the config
// folder (the file watch, the panel, the CLI, the agent) is revision n: a snapshot of
// the whole working set, journaled as ConfigChanged { revision, parent, files } with who
// did it and what it changed. The journal holds the history; the files' contents are
// stored once each, by their hash, under /data/revisions/objects, so a revision that
// changes one line of heuristics.json costs one file.
//
// Rolling back to revision n writes n's files back into the config folder (only those
// that differ; a working-set file n did not have is removed, nothing else is touched),
// and applies them through the reload path like any edit: all or nothing, the files put
// back when the reload rejects them. The rollback is itself a new revision, so it can
// be undone the same way.
//
// The functions at the bottom (listRevisions, revisionDetail, revisionFile,
// diffRevisions, rollback) are what the panel's API calls, and what an agent's tools call.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JournalReader } from "@lambda-house/teob-ts/core";
import type { Hono } from "hono";
import { LOCK_FILE } from "./packages/lock.js";
import { requestUser } from "./pause.js";
import type { Reloader, ReloadOutcome } from "./reload.js";
import { GENERATED } from "./studio/init.js";
import { mayWrite } from "./studio/files.js";
import { CONFIG_CATEGORY, CONFIG_ENTITY, type ConfigChange, type ConfigChanged } from "./working-set.js";

/** The working set's top-level files; heuristics/ and packages/ are taken whole. */
export const SNAPSHOT_FILES = ["heuristics.json", "allowlist.json", "tiles.json", "energy.json", "voice.json", LOCK_FILE];
export const SNAPSHOT_DIRS = ["heuristics", "packages"];

/** Path → "sha256-<hex>" of its bytes. */
export type SnapshotFiles = Record<string, string>;

/** A revision as the API answers it. */
export interface Revision {
  revision: number;
  parent?: number;
  at: number;
  by: string;
  summary: string;
  /** The instances it touched; absent: possibly all of them. */
  instances?: string[];
  /** The files it changed against its parent. */
  file: string;
  files: SnapshotFiles;
}

/** Leave out what is not the house's to version: dot files, node_modules, the generated typings. */
function skipped(path: string): boolean {
  const parts = path.split("/");
  return parts.some((p) => p.startsWith(".") || p === "node_modules" || p.endsWith("~")) || GENERATED.some((g) => path === g || path.startsWith(`${g}/`));
}

/** Whether a path (relative, slash-separated) is one a snapshot takes. */
export function inWorkingSet(path: string): boolean {
  const p = path.split("\\").join("/");
  if (SNAPSHOT_FILES.includes(p)) return true;
  return SNAPSHOT_DIRS.some((d) => p.startsWith(`${d}/`)) && !skipped(p);
}

function walk(root: string, sub: string): string[] {
  const dir = join(root, sub);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = `${sub}/${e.name}`;
    if (skipped(rel)) return [];
    return e.isDirectory() ? walk(root, rel) : e.isFile() ? [rel] : [];
  });
}

/** The working set's files in a config folder, sorted. */
export function workingSetPaths(configDir: string): string[] {
  return [...SNAPSHOT_FILES.filter((f) => existsSync(join(configDir, f))), ...SNAPSHOT_DIRS.flatMap((d) => walk(configDir, d))].sort();
}

const hashOf = (bytes: Buffer): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

/** Files by their hash, each stored once. */
export interface ObjectStore {
  put(bytes: Buffer): string;
  get(hash: string): Buffer | undefined;
  has(hash: string): boolean;
}

export function createObjectStore(dir: string): ObjectStore {
  const pathOf = (hash: string): string => {
    const hex = hash.replace(/^sha256-/, "");
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a content hash: ${hash}`);
    return join(dir, hex.slice(0, 2), hex);
  };
  return {
    put(bytes) {
      const hash = hashOf(bytes);
      const path = pathOf(hash);
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        // Written whole or not at all: a crash never leaves half an object under its hash.
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, path);
      }
      return hash;
    },
    get(hash) {
      const path = pathOf(hash);
      return existsSync(path) ? readFileSync(path) : undefined;
    },
    has: (hash) => existsSync(pathOf(hash)),
  };
}

/** The config folder's working set as it is now, its files stored. */
export function takeSnapshot(configDir: string, objects: ObjectStore): SnapshotFiles {
  const out: SnapshotFiles = {};
  for (const p of workingSetPaths(configDir)) out[p] = objects.put(readFileSync(join(configDir, p)));
  return out;
}

/** The paths whose content differs between two snapshots (added and removed ones too). */
export function changedPaths(before: SnapshotFiles, after: SnapshotFiles): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
}

export interface RevisionStore {
  objects: ObjectStore;
  configDir: string;
  list(): Revision[];
  get(n: number): Revision | undefined;
  last(): Revision | undefined;
  /** The folder now, as the next revision's fields: its number, its parent and its files. */
  next(): { revision: number; parent?: number; files: SnapshotFiles; changed: string[] };
  /** A revision once journaled. */
  add(change: ConfigChange): void;
}

/** A ConfigChanged that is a revision. */
const isRevision = (c: Partial<ConfigChanged>): c is ConfigChanged & { revision: number; files: SnapshotFiles } =>
  typeof c.revision === "number" && typeof c.files === "object" && c.files !== null;

const toRevision = (c: ConfigChanged & { revision: number; files: SnapshotFiles }): Revision => ({
  revision: c.revision,
  ...(c.parent !== undefined ? { parent: c.parent } : {}),
  at: c.at,
  by: c.by,
  summary: c.summary,
  ...(c.instances !== undefined ? { instances: c.instances } : {}),
  file: c.file,
  files: c.files,
});

/**
 * The revisions, folded from the journal's teob-config stream (rows from before
 * revisions have none and are left out), over the objects under `dir`.
 */
export function createRevisionStore(opts: { dir: string; configDir: string; journal: Pick<JournalReader, "queryEvents"> }): RevisionStore {
  const objects = createObjectStore(join(opts.dir, "objects"));
  const revisions: Revision[] = [];
  let cursor: number | undefined;
  for (;;) {
    const rows = opts.journal.queryEvents({ category: CONFIG_CATEGORY, entityId: CONFIG_ENTITY, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    for (const r of rows) {
      const c = r.payload as Partial<ConfigChanged>;
      if (r.manifest === "ConfigChanged" && isRevision(c)) revisions.push(toRevision(c));
    }
    if (rows.length < 1000) break;
    cursor = rows.at(-1)!.globalSeq;
  }
  return {
    objects,
    configDir: opts.configDir,
    list: () => [...revisions],
    get: (n) => revisions.find((r) => r.revision === n),
    last: () => revisions.at(-1),
    next() {
      const last = revisions.at(-1);
      const files = takeSnapshot(opts.configDir, objects);
      return { revision: (last?.revision ?? 0) + 1, ...(last !== undefined ? { parent: last.revision } : {}), files, changed: changedPaths(last?.files ?? {}, files) };
    },
    add(change) {
      if (isRevision(change as ConfigChanged)) revisions.push(toRevision({ tag: "ConfigChanged", ...change } as ConfigChanged & { revision: number; files: SnapshotFiles }));
    },
  };
}

/**
 * At start: the folder as revision 1 when there is none, or as a new revision when it
 * differs from the last (edited while Teobeanie was stopped). Nothing when it is the same.
 */
export async function recordBootRevision(store: RevisionStore, record: (change: ConfigChange) => Promise<void>, at = Date.now()): Promise<Revision | undefined> {
  const next = store.next();
  const last = store.last();
  if (last !== undefined && next.changed.length === 0) return undefined;
  const change: ConfigChange = {
    at,
    file: next.changed.join(", ") || "config",
    by: "boot",
    summary: last === undefined ? "the working set at start" : "changed while Teobeanie was stopped",
    revision: next.revision,
    ...(next.parent !== undefined ? { parent: next.parent } : {}),
    files: next.files,
  };
  await record(change);
  store.add(change);
  return store.last();
}

// ---- diffs ----

/** One file's change between two revisions, as unified diff text ("" when equal). */
export interface FileDiff {
  path: string;
  status: "added" | "removed" | "changed";
  /** Unified diff text; "Binary files differ" for a file that is not text. */
  diff: string;
}

const CONTEXT = 3;
/** Above this many line pairs a file is shown replaced whole, not diffed line by line. */
const MAX_CELLS = 4_000_000;

/** Unified diff of two texts (no ---/+++ header), three lines of context. */
export function unifiedDiff(a: string, b: string): string {
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  // Common head and tail first; the rest by longest common subsequence.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  type Op = { op: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ op: " ", line: x[i]!, ai: i, bi: i });
  if (xs.length * ys.length > MAX_CELLS) {
    xs.forEach((line, i) => ops.push({ op: "-", line, ai: head + i, bi: head }));
    ys.forEach((line, j) => ops.push({ op: "+", line, ai: head + xs.length, bi: head + j }));
  } else {
    const n = xs.length;
    const m = ys.length;
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = xs[i] === ys[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) {
        ops.push({ op: " ", line: xs[i]!, ai: head + i, bi: head + j });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
        ops.push({ op: "-", line: xs[i]!, ai: head + i, bi: head + j });
        i++;
      } else {
        ops.push({ op: "+", line: ys[j]!, ai: head + i, bi: head + j });
        j++;
      }
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ op: " ", line: x[x.length - tail + k]!, ai: x.length - tail + k, bi: y.length - tail + k });

  // Hunks: each change with CONTEXT lines around it, close ones merged.
  const changed = ops.map((o, k) => (o.op !== " " ? k : -1)).filter((k) => k >= 0);
  if (changed.length === 0) return "";
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const from = Math.max(0, k - CONTEXT);
    const to = Math.min(ops.length - 1, k + CONTEXT);
    const last = hunks.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out: string[] = [];
  for (const [from, to] of hunks) {
    const part = ops.slice(from, to + 1);
    const aLines = part.filter((o) => o.op !== "+").length;
    const bLines = part.filter((o) => o.op !== "-").length;
    const aStart = aLines === 0 ? part[0]!.ai : part.find((o) => o.op !== "+")!.ai + 1;
    const bStart = bLines === 0 ? part[0]!.bi : part.find((o) => o.op !== "-")!.bi + 1;
    out.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@`);
    for (const o of part) out.push(`${o.op}${o.line}`);
  }
  return `${out.join("\n")}\n`;
}

const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

// ---- what the API and the agent's tools call ----

/** Every revision, newest first, without its file list. */
export function listRevisions(store: RevisionStore): Array<Omit<Revision, "files"> & { fileCount: number }> {
  return store
    .list()
    .reverse()
    .map(({ files, ...r }) => ({ ...r, fileCount: Object.keys(files).length }));
}

/** One revision: who, what, and its files with their size. */
export function revisionDetail(store: RevisionStore, n: number): (Omit<Revision, "files"> & { files: Array<{ path: string; hash: string; bytes: number }> }) | undefined {
  const r = store.get(n);
  if (r === undefined) return undefined;
  const { files, ...rest } = r;
  return { ...rest, files: Object.entries(files).map(([path, hash]) => ({ path, hash, bytes: store.objects.get(hash)?.length ?? 0 })) };
}

/** A file's text as revision n had it; undefined when n has no such file. */
export function revisionFile(store: RevisionStore, n: number, path: string): string | undefined {
  const hash = store.get(n)?.files[path];
  return hash === undefined ? undefined : store.objects.get(hash)?.toString("utf8");
}

/** The files that differ from revision a to revision b, each with its unified diff. */
export function diffRevisions(store: RevisionStore, a: number, b: number): FileDiff[] {
  const ra = store.get(a);
  const rb = store.get(b);
  if (ra === undefined) throw new Error(`no revision ${a}`);
  if (rb === undefined) throw new Error(`no revision ${b}`);
  return changedPaths(ra.files, rb.files).map((path) => {
    const before = ra.files[path] !== undefined ? store.objects.get(ra.files[path]!) : undefined;
    const after = rb.files[path] !== undefined ? store.objects.get(rb.files[path]!) : undefined;
    const status = before === undefined ? "added" : after === undefined ? "removed" : "changed";
    const diff =
      (before !== undefined && isBinary(before)) || (after !== undefined && isBinary(after))
        ? "Binary files differ\n"
        : `--- ${before === undefined ? "/dev/null" : `a/${path}`}\n+++ ${after === undefined ? "/dev/null" : `b/${path}`}\n` +
          unifiedDiff(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "");
    return { path, status, diff };
  });
}

/** Remove the folders a removal emptied, up to (not including) heuristics/ or packages/. */
function pruneEmpty(configDir: string, path: string): void {
  for (let dir = dirname(path); dir.includes("/"); dir = dirname(dir)) {
    const abs = join(configDir, dir);
    if (!existsSync(abs) || readdirSync(abs).length > 0) return;
    rmdirSync(abs);
  }
}

/**
 * Put revision n's files back and apply them through the reload path, as `by`. Writes
 * only the files that differ, removes the working-set files n did not have, and leaves
 * everything else alone. A rejected reload puts every file back as it was. Applied, it
 * is a new revision: "rollback to n".
 */
export async function rollback(deps: { store: RevisionStore; reloader: Reloader }, n: number, by: string): Promise<ReloadOutcome> {
  const { store } = deps;
  const target = store.get(n);
  if (target === undefined) throw new Error(`no revision ${n}`);
  const missing = Object.entries(target.files).filter(([, hash]) => !store.objects.has(hash));
  if (missing.length > 0) throw new Error(`revision ${n}: the stored copy of ${missing.map(([p]) => p).join(", ")} is missing`);
  return deps.reloader.write({
    by,
    summary: `rollback to ${n}`,
    always: true,
    apply: () => {
      const dir = store.configDir;
      const before = new Map<string, Buffer | undefined>();
      const keep = (p: string): void => {
        if (!before.has(p)) before.set(p, existsSync(join(dir, p)) ? readFileSync(join(dir, p)) : undefined);
      };
      const restore = (): void => {
        for (const [p, bytes] of before) {
          const abs = join(dir, p);
          if (bytes === undefined) {
            if (existsSync(abs)) unlinkSync(abs);
            pruneEmpty(dir, p);
          } else {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, bytes);
          }
        }
      };
      try {
        for (const p of workingSetPaths(dir)) {
          if (target.files[p] !== undefined) continue;
          keep(p);
          unlinkSync(join(dir, p));
          pruneEmpty(dir, p);
        }
        for (const [p, hash] of Object.entries(target.files)) {
          const abs = join(dir, p);
          if (existsSync(abs) && hashOf(readFileSync(abs)) === hash) continue;
          keep(p);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, store.objects.get(hash)!);
        }
      } catch (err) {
        // A write that failed half way (a full disk): what was written is put back.
        restore();
        throw err;
      }
      return restore;
    },
  });
}

// ---- the panel's API ----

const peerOf = (c: unknown): string | undefined => (c as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;

/**
 * GET api/revisions, GET api/revisions/<n> (its files; ?path= one file's text),
 * GET api/revisions/<a>/diff/<b>, and POST api/revisions/<n>/rollback through Home
 * Assistant ingress only.
 */
export function mountRevisions(app: Hono, deps: { mode: "addon" | "standalone"; store: RevisionStore; reloader: Reloader }): void {
  const num = (s: string | undefined): number | undefined => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);

  app.get("/api/revisions", (c) => c.json({ revisions: listRevisions(deps.store) }));

  app.get("/api/revisions/:n", (c) => {
    const n = num(c.req.param("n"));
    const path = c.req.query("path");
    if (n !== undefined && path !== undefined) {
      const text = revisionFile(deps.store, n, path);
      return text === undefined ? c.json({ error: "NotFound", reason: `revision ${n} has no ${path}` }, 404) : c.text(text);
    }
    const detail = n === undefined ? undefined : revisionDetail(deps.store, n);
    return detail === undefined ? c.json({ error: "NotFound", reason: `no revision ${c.req.param("n")}` }, 404) : c.json(detail);
  });

  app.get("/api/revisions/:a/diff/:b", (c) => {
    const a = num(c.req.param("a"));
    const b = num(c.req.param("b"));
    try {
      if (a === undefined || b === undefined) throw new Error("no revision");
      return c.json({ from: a, to: b, files: diffRevisions(deps.store, a, b) });
    } catch (err) {
      return c.json({ error: "NotFound", reason: (err as Error).message }, 404);
    }
  });

  app.post("/api/revisions/:n/rollback", async (c) => {
    if (!mayWrite(deps.mode, peerOf(c))) return c.json({ error: "Forbidden", reason: "roll back through the Home Assistant panel only" }, 403);
    const n = num(c.req.param("n"));
    if (n === undefined || deps.store.get(n) === undefined) return c.json({ error: "NotFound", reason: `no revision ${c.req.param("n")}` }, 404);
    try {
      const outcome = await rollback(deps, n, requestUser((h) => c.req.header(h)));
      return c.json(outcome, outcome.ok ? 200 : 422);
    } catch (err) {
      return c.json({ error: "BadRequest", reason: (err as Error).message }, 400);
    }
  });
}
