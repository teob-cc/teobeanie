// move.ts — moving the house to another Teobeanie install. Home Assistant restores an
// add-on's backup only into the same slug, so a house that moves (the local add-on to
// the store's, or to a new Home Assistant box) takes its history along this way.
//
// Export: a person's action in the panel's Connect page, through ingress only, never an
// agent's. A consistent copy of the journal taken while running (SQLite's online backup
// on the journal's own connection: every committed row, none half written, the rowids
// that are the global positions kept), the revisions' objects, the agent tokens'
// hashes, the signals when asked, and the config folder, under
// <config>/teobeanie-move/<UTC time>/ with a manifest of every file's sha256. The folder
// is written as .<name>.partial and renamed when whole, so a half export is never one.
//
// Import: at start, before anything reads the data dir or the config folder. When
// teobeanie-move/ holds exactly one export that is not yet imported and verifies, and
// this install's journal is empty, its data replaces the data dir's and its config
// files the config folder's; the export becomes <name>.imported. Everything is staged
// next to where it goes (the data dir and the config folder are separate mounts) and
// put back on a failure, and on the next start after a crash. views.db is not moved:
// with no offsets the projections fold the whole journal again.

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  CategoryId,
  EntityId,
  categoryTypes,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  type Aggregate,
  type Codec,
  type EntityRuntime,
  type JournalReader,
} from "@lambda-house/teob-ts/core";
import type { Hono } from "hono";
import { requestUser } from "./pause.js";
import { workingSetPaths } from "./revisions.js";
import { mayWrite } from "./studio/files.js";

/** The folder of the exports, in the config folder (addon_configs/<slug>/ over Samba or SSH). */
export const MOVE_DIR = "teobeanie-move";
/** The manifest's format; an import refuses a newer one. */
export const MOVE_FORMAT = 1;
export const MANIFEST = "manifest.json";
export const IMPORTED = ".imported";
/** 20261021T143005Z, a second export in the same second -2. */
const EXPORT_NAME = /^\d{8}T\d{6}Z(-\d+)?$/;

/** What moves from the data dir; options.json is the Supervisor's, views.db is folded again. */
const DATA_ITEMS = ["journal.db", "revisions", "agent-tokens.json", "signals.db"];
/** In the data dir during an import: the incoming files, and what they replaced. */
const DATA_STAGE = ".move-staging";
const DATA_ASIDE = ".move-previous";
const PLAN = ".plan.json";

export interface MoveFile {
  /** data/… or config/…, slash-separated. */
  path: string;
  bytes: number;
  sha256: string;
}

/** Where the journal stood: its row count and its last row (the global position is its rowid). */
export interface JournalMark {
  events: number;
  lastPosition: number;
  last: { stream: string; sequenceNr: number; eventId: string | null } | null;
}

export interface MoveManifest {
  format: number;
  /** Teobeanie's version that wrote it. */
  version: string;
  createdAt: number;
  by: string;
  journal: JournalMark;
  signals: boolean;
  files: MoveFile[];
}

// ---- the journal stream ----

export const MOVE_CATEGORY: CategoryId = CategoryId("teob-move");
export const MOVE_ENTITY: EntityId = EntityId("install");

export interface InstallExported {
  tag: "InstallExported";
  at: number;
  /** person:<name> or user:<id prefix> (the panel's HA user), or "local" (standalone). */
  by: string;
  /** teobeanie-move/<name> in the config folder. */
  folder: string;
  events: number;
  lastPosition: number;
  signals: boolean;
}

export interface InstallImported {
  tag: "InstallImported";
  at: number;
  by: "boot";
  folder: string;
  /** The version that wrote the export, and when. */
  version: string;
  createdAt: number;
  events: number;
  lastPosition: number;
}

export type MoveEvent = InstallExported | InstallImported;
export type MoveCommand = { tag: "Record"; event: MoveEvent };

export const moveAggregate: Aggregate<MoveCommand, void, MoveEvent, { events: number }> = {
  category: MOVE_CATEGORY,
  initial: () => ({ events: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag !== "Record") return done();
    return persist(stampEnvelope(cmd.event, { origin: cmd.event.by }));
  },
  apply: (state) => ({ events: state.events + 1 }),
};

export const moveEventCodec: Codec<MoveEvent> = tagCodec<MoveEvent>("InstallExported", "InstallImported");
export const moveStateCodec: Codec<{ events: number }> = objectCodec<{ events: number }>("MoveState");

/** Journal an export or an import; resolves once it is persisted. */
export function createMoveJournal(runtime: Pick<EntityRuntime, "ask">): (event: MoveEvent) => Promise<void> {
  const cat = categoryTypes<MoveCommand, void>(MOVE_CATEGORY);
  return async (event) => {
    const res = await runtime.ask(MOVE_ENTITY, { tag: "Record", event }, cat);
    if (!res.ok) throw new Error(`move journal: ${JSON.stringify(res.error)}`);
  };
}

// ---- files ----

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** The regular files under root/sub, slash-separated and relative to root, sorted; `skip` leaves a path out (and all under it). */
function filesUnder(root: string, sub = "", skip: (rel: string) => boolean = () => false): string[] {
  const dir = sub === "" ? root : join(root, sub);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const rel = sub === "" ? e.name : `${sub}/${e.name}`;
      if (skip(rel)) return [];
      return e.isDirectory() ? filesUnder(root, rel, skip) : e.isFile() ? [rel] : [];
    })
    .sort();
}

/** The config folder's files an export takes: all but the exports themselves and node_modules. */
export function configFiles(configDir: string): string[] {
  return filesUnder(configDir, "", (rel) => rel === MOVE_DIR || rel.split("/").at(-1) === "node_modules");
}

/** Where a journal stands; the table may not exist yet. */
function journalMark(db: Database.Database): JournalMark {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal'").get();
  if (table === undefined) return { events: 0, lastPosition: 0, last: null };
  const { n, last } = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last FROM journal").get() as { n: number; last: number };
  const row = db.prepare("SELECT persistence_id, sequence_nr, event_id FROM journal WHERE rowid = ?").get(last) as
    | { persistence_id: string; sequence_nr: number; event_id: string | null }
    | undefined;
  return { events: n, lastPosition: last, last: row === undefined ? null : { stream: row.persistence_id, sequenceNr: row.sequence_nr, eventId: row.event_id } };
}

/** Whether a journal holds a mark's last row at its position: the export was taken from it. */
function holds(db: Database.Database, mark: JournalMark): boolean {
  if (mark.last === null) return false;
  const row = db.prepare("SELECT persistence_id, sequence_nr, event_id FROM journal WHERE rowid = ?").get(mark.lastPosition) as
    | { persistence_id: string; sequence_nr: number; event_id: string | null }
    | undefined;
  return row !== undefined && row.persistence_id === mark.last.stream && row.sequence_nr === mark.last.sequenceNr && row.event_id === mark.last.eventId;
}

/** A copy of a live database through its own connection, left as one plain file (no -wal to carry). */
async function backupTo(db: Pick<Database.Database, "backup">, dest: string): Promise<void> {
  await db.backup(dest);
  const copy = new Database(dest);
  try {
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
}

// ---- export ----

export interface ExportDeps {
  dataDir: string;
  configDir: string;
  /** The journal's own connection (SqliteJournal.db): the backup sees every committed row through it. */
  journal: Pick<Database.Database, "backup">;
  /** The signals store's connection, for an export with the signals. */
  signals?: Pick<Database.Database, "backup">;
  version: string;
  now?: () => number;
}

export interface ExportResult {
  name: string;
  /** teobeanie-move/<name>, relative to the config folder. */
  folder: string;
  manifest: MoveManifest;
}

const stampName = (at: number): string => new Date(at).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");

/**
 * Write an export under <config>/teobeanie-move/<UTC time>/: data/ (journal.db,
 * revisions/, agent-tokens.json, signals.db when asked), config/ (the config folder but
 * the exports), and manifest.json. Whole or not at all.
 */
export async function exportInstall(deps: ExportDeps, opts: { by: string; signals?: boolean }): Promise<ExportResult> {
  const at = (deps.now ?? Date.now)();
  const moveDir = join(deps.configDir, MOVE_DIR);
  mkdirSync(moveDir, { recursive: true });
  let name = stampName(at);
  for (let k = 2; existsSync(join(moveDir, name)) || existsSync(join(moveDir, `${name}${IMPORTED}`)); k++) name = `${stampName(at)}-${k}`;
  const stage = join(moveDir, `.${name}.partial`);
  rmSync(stage, { recursive: true, force: true });
  try {
    mkdirSync(join(stage, "data"), { recursive: true });
    // The journal first: every revision it names has its objects stored before it is journaled.
    await backupTo(deps.journal, join(stage, "data", "journal.db"));
    const probe = new Database(join(stage, "data", "journal.db"), { readonly: true });
    let mark: JournalMark;
    try {
      mark = journalMark(probe);
    } finally {
      probe.close();
    }
    const revisions = join(deps.dataDir, "revisions");
    if (existsSync(revisions)) cpSync(revisions, join(stage, "data", "revisions"), { recursive: true, filter: (src) => !src.endsWith(".tmp") });
    const tokens = join(deps.dataDir, "agent-tokens.json");
    if (existsSync(tokens)) copyFileSync(tokens, join(stage, "data", "agent-tokens.json"));
    if (opts.signals === true) {
      if (deps.signals === undefined) throw new Error("the signals cannot be exported here");
      await backupTo(deps.signals, join(stage, "data", "signals.db"));
    }
    for (const p of configFiles(deps.configDir)) {
      const dest = join(stage, "config", p);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(deps.configDir, p), dest);
    }
    const files = filesUnder(stage).map((p) => ({ path: p, bytes: statSync(join(stage, p)).size, sha256: sha256File(join(stage, p)) }));
    const manifest: MoveManifest = { format: MOVE_FORMAT, version: deps.version, createdAt: at, by: opts.by, journal: mark, signals: opts.signals === true, files };
    writeFileSync(join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(stage, join(moveDir, name));
    return { name, folder: `${MOVE_DIR}/${name}`, manifest };
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

// ---- verify, list ----

/** A path a manifest may name: under data/ or config/, nothing that climbs out. */
const safePath = (p: unknown): p is string =>
  typeof p === "string" && /^(data|config)\/./.test(p) && !p.split("/").some((s) => s === "" || s === "." || s === "..") && !p.includes("\\");

/** An export's manifest when its files are all there with their hashes; else what is wrong. */
export function verifyExport(dir: string): { manifest: MoveManifest } | { problem: string } {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) return { problem: `no ${MANIFEST}: not a complete export` };
  let manifest: MoveManifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as MoveManifest;
  } catch (err) {
    return { problem: `${MANIFEST} cannot be read: ${(err as Error).message}` };
  }
  if (typeof manifest.format !== "number" || !Array.isArray(manifest.files) || typeof manifest.journal !== "object" || manifest.journal === null)
    return { problem: `${MANIFEST} is not an export's manifest` };
  if (manifest.format > MOVE_FORMAT) return { problem: `written by a newer Teobeanie (${manifest.version}, format ${manifest.format}): update this add-on first` };
  if (!manifest.files.some((f) => f.path === "data/journal.db")) return { problem: "the export has no journal (data/journal.db)" };
  const bad: string[] = [];
  for (const f of manifest.files) {
    if (!safePath(f.path)) return { problem: `${MANIFEST} names a path outside the export: ${String(f.path)}` };
    const abs = join(dir, f.path);
    if (!existsSync(abs)) bad.push(`${f.path} is missing`);
    else if (statSync(abs).size !== f.bytes || sha256File(abs) !== f.sha256) bad.push(`${f.path} differs from the manifest`);
  }
  return bad.length > 0 ? { problem: `${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}: copy the folder again` } : { manifest };
}

/** An export as the panel lists it. */
export interface ExportInfo {
  name: string;
  imported: boolean;
  /** Absent: no readable manifest (being written, or copied in part). */
  createdAt?: number;
  version?: string;
  by?: string;
  events?: number;
  signals?: boolean;
  files?: number;
  bytes?: number;
}

/** The exports in teobeanie-move/, newest first. */
export function listExports(configDir: string): ExportInfo[] {
  const moveDir = join(configDir, MOVE_DIR);
  if (!existsSync(moveDir)) return [];
  return readdirSync(moveDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && EXPORT_NAME.test(e.name.endsWith(IMPORTED) ? e.name.slice(0, -IMPORTED.length) : e.name))
    .map((e) => {
      const name = e.name.endsWith(IMPORTED) ? e.name.slice(0, -IMPORTED.length) : e.name;
      const info: ExportInfo = { name, imported: e.name.endsWith(IMPORTED) };
      try {
        const m = JSON.parse(readFileSync(join(moveDir, e.name, MANIFEST), "utf8")) as MoveManifest;
        Object.assign(info, {
          createdAt: m.createdAt,
          version: m.version,
          by: m.by,
          events: m.journal.events,
          signals: m.signals,
          files: m.files.length,
          bytes: m.files.reduce((s, f) => s + f.bytes, 0),
        });
      } catch {
        // no manifest yet: listed without its details
      }
      return info;
    })
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : Number(a.imported) - Number(b.imported)));
}

// ---- import ----

/** What the start found in teobeanie-move/, for the log and the panel. */
export interface ImportOutcome {
  /**
   * none: nothing to import; own: only this install's own exports; not-empty: an export
   * waits but this install already has a journal; refused: several exports, or one that
   * does not verify; failed: the import failed and was put back; imported.
   */
  status: "none" | "own" | "not-empty" | "refused" | "failed" | "imported";
  message: string;
  /** The exports it is about. */
  folders: string[];
  at: number;
  manifest?: MoveManifest;
  /** Config folder files the import replaced or set aside (kept under <name>.imported/replaced/). */
  replaced?: string[];
}

type Log = (level: "info" | "warning" | "error", msg: string) => void;

/** The data dir as it was before an interrupted import; a finished one (its export renamed) is kept. */
function restoreData(dataDir: string, moveDir: string): "none" | "restored" | "finished" {
  const aside = join(dataDir, DATA_ASIDE);
  if (!existsSync(aside)) return "none";
  let plan: { export?: string; placed?: string[] } = {};
  try {
    plan = JSON.parse(readFileSync(join(aside, PLAN), "utf8")) as typeof plan;
  } catch {
    // no plan: nothing was placed yet, only set aside
  }
  // Renamed is the commit: the import is whole, only the set-aside is left to remove.
  if (plan.export !== undefined && !existsSync(join(moveDir, plan.export)) && existsSync(join(moveDir, `${plan.export}${IMPORTED}`))) {
    rmSync(aside, { recursive: true, force: true });
    return "finished";
  }
  // The plan is written once everything is aside: what it names in the data dir is the import's.
  for (const n of plan.placed ?? []) rmSync(join(dataDir, n), { recursive: true, force: true });
  for (const n of readdirSync(aside)) {
    if (n === PLAN) continue;
    rmSync(join(dataDir, n), { recursive: true, force: true });
    renameSync(join(aside, n), join(dataDir, n));
  }
  rmSync(aside, { recursive: true, force: true });
  return "restored";
}

function journalOf(dataDir: string): Database.Database | undefined {
  const path = join(dataDir, "journal.db");
  return existsSync(path) ? new Database(path, { fileMustExist: true }) : undefined;
}

/**
 * At start, before the config folder or the data dir is read: take in the one export
 * waiting in teobeanie-move/ when this install's journal is empty. Never throws: a
 * refusal or a failure is logged, and the start goes on with the install as it was.
 */
export function importAtStart(opts: { dataDir: string; configDir: string; log: Log; now?: () => number }): ImportOutcome {
  const at = (opts.now ?? Date.now)();
  const moveDir = join(opts.configDir, MOVE_DIR);
  const say = (status: ImportOutcome["status"], level: "info" | "warning" | "error" | undefined, message: string, folders: string[], extra: Partial<ImportOutcome> = {}): ImportOutcome => {
    if (level !== undefined) opts.log(level, message);
    return { status, message, folders, at, ...extra };
  };
  try {
    if (restoreData(opts.dataDir, moveDir) === "restored")
      opts.log("warning", `move: an import was interrupted; the data dir is back as it was before it (${opts.dataDir})`);
    rmSync(join(opts.dataDir, DATA_STAGE), { recursive: true, force: true });
    const waiting = existsSync(moveDir)
      ? readdirSync(moveDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && EXPORT_NAME.test(e.name))
          .map((e) => e.name)
          .sort()
      : [];
    if (waiting.length === 0) return say("none", undefined, "", []);
    const named = (names: string[]): string => names.map((n) => `${MOVE_DIR}/${n}`).join(", ");

    const db = journalOf(opts.dataDir);
    let events = 0;
    let own: string[] = [];
    try {
      if (db !== undefined) {
        events = journalMark(db).events;
        own = waiting.filter((n) => {
          try {
            const m = JSON.parse(readFileSync(join(moveDir, n, MANIFEST), "utf8")) as MoveManifest;
            return holds(db, m.journal);
          } catch {
            return false;
          }
        });
      }
    } finally {
      db?.close();
    }
    if (events > 0) {
      const others = waiting.filter((n) => !own.includes(n));
      if (others.length === 0)
        return say("own", "info", `move: ${named(own)} ${own.length === 1 ? "is an export" : "are exports"} of this install; copy one into the new install's config folder to move`, own);
      return say(
        "not-empty",
        "warning",
        `move: ${named(others)} not imported: this install's journal already has ${events} events, and an export is imported only into an install whose journal is empty (docs/moving.md)`,
        others,
      );
    }
    if (waiting.length > 1)
      return say(
        "refused",
        "error",
        `move: ${waiting.length} exports wait in ${MOVE_DIR}/ (${waiting.join(", ")}): keep only the one to import (the newest is ${waiting.at(-1)}), remove the others, and restart`,
        waiting,
      );
    const name = waiting[0]!;
    const checked = verifyExport(join(moveDir, name));
    if ("problem" in checked) return say("refused", "error", `move: ${MOVE_DIR}/${name} not imported: ${checked.problem}`, [name]);
    const replaced = takeIn(opts.dataDir, opts.configDir, name, checked.manifest);
    const m = checked.manifest;
    return say(
      "imported",
      "info",
      `move: imported ${MOVE_DIR}/${name} (Teobeanie ${m.version}, ${new Date(m.createdAt).toISOString()}, ${m.journal.events} events${m.signals ? ", with the signals" : ""}); now ${MOVE_DIR}/${name}${IMPORTED}`,
      [name],
      { manifest: m, replaced },
    );
  } catch (err) {
    return say("failed", "error", `move: the import failed and the install is as it was: ${err instanceof Error ? err.message : String(err)}`, []);
  }
}

/**
 * Put one verified export in place: the config folder's files first (the replaced ones
 * set aside), then the data dir's items (staged, the old ones set aside), then the
 * export renamed <name>.imported, which is the commit. A failure before it puts back
 * both and rethrows.
 */
function takeIn(dataDir: string, configDir: string, name: string, manifest: MoveManifest): string[] {
  const moveDir = join(configDir, MOVE_DIR);
  const src = join(moveDir, name);
  const stage = join(dataDir, DATA_STAGE);
  const aside = join(dataDir, DATA_ASIDE);
  // Next to the config folder's files, so a set-aside is a rename on the same mount. An
  // earlier attempt's is kept: what it holds are the originals.
  const configAside = join(moveDir, `.${name}.replaced`);
  const touched = new Set<string>();
  const written = new Set<string>();

  const putBackConfig = (): void => {
    for (const p of touched) {
      const abs = join(configDir, p);
      if (existsSync(join(configAside, p))) {
        rmSync(abs, { recursive: true, force: true });
        mkdirSync(dirname(abs), { recursive: true });
        renameSync(join(configAside, p), abs);
      } else if (written.has(p)) rmSync(abs, { force: true });
    }
    if (filesUnder(configAside).length === 0) rmSync(configAside, { recursive: true, force: true });
  };

  rmSync(stage, { recursive: true, force: true });
  try {
    // 1. The data, staged in the data dir.
    mkdirSync(stage, { recursive: true });
    const placed = DATA_ITEMS.filter((n) => existsSync(join(src, "data", n)));
    for (const n of placed) cpSync(join(src, "data", n), join(stage, n), { recursive: true });
    for (const f of manifest.files.filter((f) => f.path.startsWith("data/"))) {
      const p = f.path.slice("data/".length);
      if (placed.some((n) => p === n || p.startsWith(`${n}/`)) && sha256File(join(stage, p)) !== f.sha256) throw new Error(`${f.path} changed while being copied`);
    }

    // 2. The config folder: the export's files over the folder's, and the working-set
    // files the export does not have set aside (the working set is the export's, as its
    // revisions say). Anything else the owner keeps there stays.
    const incoming = manifest.files.filter((f) => f.path.startsWith("config/")).map((f) => f.path.slice("config/".length));
    const theirs = new Set(incoming);
    const gone = workingSetPaths(configDir).filter((p) => !theirs.has(p));
    for (const p of [...gone, ...incoming]) {
      const abs = join(configDir, p);
      touched.add(p);
      if (!existsSync(abs) || existsSync(join(configAside, p))) continue;
      mkdirSync(dirname(join(configAside, p)), { recursive: true });
      renameSync(abs, join(configAside, p));
    }
    for (const p of incoming) {
      const abs = join(configDir, p);
      mkdirSync(dirname(abs), { recursive: true });
      written.add(p);
      copyFileSync(join(src, "config", p), abs);
    }

    // 3. The data dir: what is there set aside (and the leftovers that must not meet the
    // new journal: its -wal/-shm, views.db with offsets into another journal), then the
    // staged items renamed in. The plan, once everything is aside, says what to undo.
    const stale = ["journal.db-wal", "journal.db-shm", "views.db", "views.db-wal", "views.db-shm", ...(placed.includes("signals.db") ? ["signals.db-wal", "signals.db-shm"] : [])];
    mkdirSync(aside, { recursive: true });
    for (const n of [...placed, ...stale]) if (existsSync(join(dataDir, n))) renameSync(join(dataDir, n), join(aside, n));
    writeFileSync(join(aside, PLAN), JSON.stringify({ export: name, placed }));
    for (const n of placed) renameSync(join(stage, n), join(dataDir, n));

    // 4. The commit.
    renameSync(src, `${src}${IMPORTED}`);
  } catch (err) {
    restoreData(dataDir, moveDir);
    putBackConfig();
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  rmSync(aside, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
  const replaced = filesUnder(configAside);
  if (existsSync(configAside)) renameSync(configAside, join(`${src}${IMPORTED}`, "replaced"));
  return replaced;
}

/** The InstallImported to journal once the runtime is up, for an import this start made. */
export function importedEvent(outcome: ImportOutcome): InstallImported | undefined {
  const m = outcome.manifest;
  if (outcome.status !== "imported" || m === undefined) return undefined;
  return {
    tag: "InstallImported",
    at: outcome.at,
    by: "boot",
    folder: `${MOVE_DIR}/${outcome.folders[0]}`,
    version: m.version,
    createdAt: m.createdAt,
    events: m.journal.events,
    lastPosition: m.journal.lastPosition,
  };
}

// ---- the panel's API ----

/** GET api/move's answer. */
export interface MoveInfo {
  folder: string;
  exports: ExportInfo[];
  /** What this start found in teobeanie-move/. */
  atStart: ImportOutcome | null;
  /** The last import journaled (this install's history began there). */
  lastImport: InstallImported | null;
}

export interface MoveDeps extends ExportDeps {
  mode: "addon" | "standalone";
  journalReader: Pick<JournalReader, "queryEvents">;
  record: (event: MoveEvent) => Promise<void>;
  atStart?: ImportOutcome;
  log?: (level: "info" | "error", msg: string) => void;
}

const peerOf = (c: unknown): string | undefined => (c as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;

/** The last InstallImported in the journal. */
function lastImport(journal: Pick<JournalReader, "queryEvents">): InstallImported | null {
  const rows = journal.queryEvents({ category: MOVE_CATEGORY, entityId: MOVE_ENTITY, order: "desc", limit: 100 });
  const row = rows.find((r) => r.manifest === "InstallImported");
  return row === undefined ? null : (row.payload as InstallImported);
}

/** GET api/move and POST api/move/export { signals? } — ingress only: a person moves the house, never an agent. */
export function mountMove(app: Hono, deps: MoveDeps): void {
  const refused = (c: unknown) => !mayWrite(deps.mode, peerOf(c));
  const FORBIDDEN = { error: "Forbidden", reason: "an install is moved through the Home Assistant panel only" };
  let busy = false;

  app.get("/api/move", (c) => {
    if (refused(c)) return c.json(FORBIDDEN, 403);
    return c.json({ folder: MOVE_DIR, exports: listExports(deps.configDir), atStart: deps.atStart ?? null, lastImport: lastImport(deps.journalReader) } satisfies MoveInfo);
  });

  app.post("/api/move/export", async (c) => {
    if (refused(c)) return c.json(FORBIDDEN, 403);
    if (busy) return c.json({ error: "Busy", reason: "an export is being written" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { signals?: unknown } | null;
    const by = requestUser((n) => c.req.header(n));
    busy = true;
    try {
      const out = await exportInstall(deps, { by, signals: body?.signals === true });
      const { journal: j, signals } = out.manifest;
      deps.log?.("info", `move: ${out.folder} exported by ${by} (${j.events} events${signals ? ", with the signals" : ""})`);
      try {
        await deps.record({ tag: "InstallExported", at: out.manifest.createdAt, by, folder: out.folder, events: j.events, lastPosition: j.lastPosition, signals });
      } catch (err) {
        deps.log?.("error", `move: the export is written, but not journaled: ${String(err)}`);
      }
      return c.json(out, 201);
    } catch (err) {
      deps.log?.("error", `move: export failed: ${String(err)}`);
      return c.json({ error: "NotExported", reason: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      busy = false;
    }
  });
}
