// Moving an install: an export written while the journal is open, copied into a new
// install's config folder and taken in at its start (events, revisions, tokens, config
// files, views folded again), once; the refusals (a journal that is not empty, two
// exports, a file that differs from the manifest); a failure put back; an interrupted
// import put back at the next start; and the panel's API, ingress only.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { categoryTypes } from "@lambda-house/teob-ts/core";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { createProjectionRunner, createSqliteProjectionStore } from "@lambda-house/teob-ts/projection";
import { createSignalStore } from "@lambda-house/teob-ts/ha";
import { AUDIT_CATEGORY, AUDIT_ENTITY, auditAggregate, auditEventCodec, auditStateCodec, type AuditCommand, type AuditReply } from "../src/audit.js";
import { accessAggregate, accessEventCodec, accessStateCodec, createAccessJournal, createAgentTokens } from "../src/mcp/agents.js";
import { configAggregate, configEventCodec, configStateCodec, createConfigJournal } from "../src/working-set.js";
import { createRevisionStore, recordBootRevision, revisionFile } from "../src/revisions.js";
import { noderedTimeline, type TimelineView } from "../src/projections.js";
import {
  IMPORTED,
  MOVE_CATEGORY,
  MOVE_DIR,
  createMoveJournal,
  exportInstall,
  importAtStart,
  importedEvent,
  listExports,
  mountMove,
  moveAggregate,
  moveEventCodec,
  moveStateCodec,
  verifyExport,
  type ImportOutcome,
  type MoveInfo,
} from "../src/move.js";

const INGRESS = "172.30.32.2";
const env = (peer: string) => ({ incoming: { socket: { remoteAddress: peer } } });

const open = (dataDir: string) =>
  createSqliteRuntime({ path: join(dataDir, "journal.db") }, [
    registration(auditAggregate, auditEventCodec, auditStateCodec),
    registration(configAggregate, configEventCodec, configStateCodec),
    registration(accessAggregate, accessEventCodec, accessStateCodec),
    registration(moveAggregate, moveEventCodec, moveStateCodec),
  ]);

const count = (dataDir: string): number => {
  const db = new Database(join(dataDir, "journal.db"), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

function tempDirs(prefix: string): { data: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), `teob-move-${prefix}-`));
  const data = join(root, "data");
  const config = join(root, "config");
  mkdirSync(data);
  mkdirSync(config);
  return { data, config };
}

/** A running install with a history: a call observed, two revisions, an agent token, signals. */
async function oldInstall() {
  const dirs = tempDirs("old");
  writeFileSync(join(dirs.config, "heuristics.json"), `${JSON.stringify({ instances: [] }, null, 2)}\n`);
  writeFileSync(join(dirs.config, "allowlist.json"), `${JSON.stringify({ observe: ["light.hall"] }, null, 2)}\n`);
  mkdirSync(join(dirs.config, "heuristics"));
  writeFileSync(join(dirs.config, "heuristics", "my-rule.ts"), "export default {};\n");
  const { runtime, journal } = open(dirs.data);
  await runtime.tell(
    AUDIT_ENTITY,
    { tag: "RecordCallService", domain: "light", service: "turn_on", entityIds: ["light.hall"], serviceData: {}, at: 1_000, haContextId: "c1", haParentId: null, haUserId: null, by: "device" },
    categoryTypes<AuditCommand, AuditReply>(AUDIT_CATEGORY),
  );
  const record = createConfigJournal(runtime);
  const revisions = createRevisionStore({ dir: join(dirs.data, "revisions"), configDir: dirs.config, journal });
  await recordBootRevision(revisions, record);
  writeFileSync(join(dirs.config, "allowlist.json"), `${JSON.stringify({ observe: ["light.hall", "light.porch"] }, null, 2)}\n`);
  await recordBootRevision(revisions, record);
  const tokens = createAgentTokens({ path: join(dirs.data, "agent-tokens.json"), record: createAccessJournal(runtime) });
  const { token } = await tokens.mint("an agent", "person:Alex");
  const signals = createSignalStore({ path: join(dirs.data, "signals.db") });
  signals.append({ obsId: "o1", entityId: "light.hall", at: 2_000, haTimeFired: 2_000, raw: { state: "on" }, normalized: { value: true, unit: null }, origin: "ha", haVersion: null, policyVersion: 1 } as never);
  return { ...dirs, runtime, journal, signals, token, revisionCount: revisions.list().length };
}

/** A new install that has never run: an empty data dir, the export copied into its config folder. */
function newInstall(from: string, name: string) {
  const dirs = tempDirs("new");
  cpSync(join(from, MOVE_DIR, name), join(dirs.config, MOVE_DIR, name), { recursive: true });
  return dirs;
}

const logs = () => {
  const lines: string[] = [];
  return { lines, log: (level: string, msg: string) => void lines.push(`${level}: ${msg}`) };
};

describe("export and import", () => {
  it("carries the journal, the revisions, the tokens and the config folder to a new install, once", async () => {
    const old = await oldInstall();
    const before = old.journal.lastGlobalSeq();
    const out = await exportInstall(
      { dataDir: old.data, configDir: old.config, journal: old.journal.db, signals: old.signals.db, version: "9.9.9", now: () => Date.UTC(2026, 9, 21, 14, 30, 5) },
      { by: "person:Alex", signals: true },
    );
    expect(out.name).toBe("20261021T143005Z");
    expect(out.folder).toBe(`${MOVE_DIR}/20261021T143005Z`);
    expect(out.manifest.journal.events).toBe(count(old.data));
    expect(out.manifest.journal.lastPosition).toBe(before);
    expect(out.manifest.signals).toBe(true);
    const paths = out.manifest.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["data/journal.db", "data/agent-tokens.json", "data/signals.db", "config/heuristics.json", "config/allowlist.json", "config/heuristics/my-rule.ts"]));
    expect(paths.some((p) => p.startsWith("data/revisions/objects/"))).toBe(true);
    expect(paths.some((p) => p.startsWith(`config/${MOVE_DIR}`))).toBe(false);
    // One plain file: no -wal beside the copy, nothing left half written.
    expect(readdirSync(join(old.config, MOVE_DIR))).toEqual(["20261021T143005Z"]);
    expect(existsSync(join(old.config, MOVE_DIR, out.name, "data", "journal.db-wal"))).toBe(false);
    expect("manifest" in verifyExport(join(old.config, MOVE_DIR, out.name))).toBe(true);

    // The old install keeps running; its own export is not one to import.
    await old.runtime.tell(
      AUDIT_ENTITY,
      { tag: "RecordCallService", domain: "light", service: "turn_off", entityIds: ["light.hall"], serviceData: {}, at: 3_000, haContextId: "c2", haParentId: null, haUserId: null, by: "device" },
      categoryTypes<AuditCommand, AuditReply>(AUDIT_CATEGORY),
    );
    old.signals.close();
    old.journal.close();
    const self = logs();
    expect(importAtStart({ dataDir: old.data, configDir: old.config, log: self.log }).status).toBe("own");
    expect(self.lines[0]).toMatch(/^info: .*export of this install/);

    // The new install: a file of the owner's, and a config file the export replaces.
    const fresh = newInstall(old.config, out.name);
    writeFileSync(join(fresh.config, "notes.txt"), "mine\n");
    writeFileSync(join(fresh.config, "heuristics.json"), `${JSON.stringify({ instances: [{ heuristic: "x", id: "y" }] })}\n`);
    writeFileSync(join(fresh.data, "views.db"), "offsets into another journal");
    const seen = logs();
    const outcome = importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: seen.log });
    expect(outcome.status, seen.lines.join("\n")).toBe("imported");
    expect(outcome.replaced).toEqual(["heuristics.json"]);
    expect(seen.lines[0]).toMatch(/^info: move: imported teobeanie-move\/20261021T143005Z \(Teobeanie 9\.9\.9/);

    // The folder is marked, the config folder is the export's, the owner's file stays.
    expect(existsSync(join(fresh.config, MOVE_DIR, out.name))).toBe(false);
    expect(existsSync(join(fresh.config, MOVE_DIR, `${out.name}${IMPORTED}`))).toBe(true);
    expect(readFileSync(join(fresh.config, MOVE_DIR, `${out.name}${IMPORTED}`, "replaced", "heuristics.json"), "utf8")).toContain('"heuristic":"x"');
    for (const f of ["heuristics.json", "allowlist.json", "heuristics/my-rule.ts"]) expect(readFileSync(join(fresh.config, f), "utf8")).toBe(readFileSync(join(old.config, f), "utf8"));
    expect(readFileSync(join(fresh.config, "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(fresh.data, "views.db"))).toBe(false);
    expect(readdirSync(fresh.data).sort()).toEqual(["agent-tokens.json", "journal.db", "revisions", "signals.db"]);

    // The history: every event up to the export, the revisions with their files, the token, the signals.
    const { runtime, journal } = open(fresh.data);
    expect(journal.lastGlobalSeq()).toBe(before);
    const revisions = createRevisionStore({ dir: join(fresh.data, "revisions"), configDir: fresh.config, journal });
    expect(revisions.list()).toHaveLength(old.revisionCount);
    expect(revisionFile(revisions, 1, "allowlist.json")).toContain('"light.hall"');
    expect(revisionFile(revisions, 2, "allowlist.json")).toContain('"light.porch"');
    expect(await recordBootRevision(revisions, createConfigJournal(runtime))).toBeUndefined();
    const tokens = createAgentTokens({ path: join(fresh.data, "agent-tokens.json"), record: async () => {} });
    expect(tokens.verify(old.token)?.name).toBe("an agent");
    const signals = createSignalStore({ path: join(fresh.data, "signals.db") });
    expect(signals.latest("light.hall")?.obsId).toBe("o1");
    signals.close();

    // The views: no offsets, so the projection folds the whole journal again.
    const viewsDb = new Database(join(fresh.data, "views.db"));
    const store = createSqliteProjectionStore(viewsDb);
    createProjectionRunner({ entries: [{ projection: noderedTimeline, eventCodec: auditEventCodec }], journal, store }).runOnce();
    expect(store.get<TimelineView>("nodered-timeline", AUDIT_ENTITY)?.view.total).toBe(1);
    viewsDb.close();

    // Journaled once the runtime is up; the next start finds nothing to import.
    await createMoveJournal(runtime)(importedEvent(outcome)!);
    const rows = journal.queryEvents({ category: MOVE_CATEGORY, order: "desc", limit: 5 });
    expect(rows[0]?.manifest).toBe("InstallImported");
    expect(rows[0]?.payload).toMatchObject({ folder: `${MOVE_DIR}/${out.name}`, version: "9.9.9", events: out.manifest.journal.events, createdAt: out.manifest.createdAt });
    journal.close();
    const again = logs();
    expect(importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: again.log }).status).toBe("none");
    expect(again.lines).toEqual([]);
    expect(listExports(fresh.config)).toMatchObject([{ name: out.name, imported: true, version: "9.9.9", signals: true }]);
  });

  it("leaves the signals out unless asked", async () => {
    const old = await oldInstall();
    const out = await exportInstall({ dataDir: old.data, configDir: old.config, journal: old.journal.db, version: "9.9.9" }, { by: "local" });
    expect(out.manifest.signals).toBe(false);
    expect(out.manifest.files.some((f) => f.path === "data/signals.db")).toBe(false);
    old.signals.close();
    old.journal.close();
  });
});

describe("refusals", () => {
  async function exported() {
    const old = await oldInstall();
    const out = await exportInstall({ dataDir: old.data, configDir: old.config, journal: old.journal.db, version: "9.9.9" }, { by: "local" });
    old.signals.close();
    old.journal.close();
    return { old, name: out.name };
  }

  it("does not import into an install whose journal has events, and says so at every start", async () => {
    const { old, name } = await exported();
    const fresh = newInstall(old.config, name);
    const { runtime, journal } = open(fresh.data);
    await createMoveJournal(runtime)({ tag: "InstallExported", at: 1, by: "local", folder: "x", events: 0, lastPosition: 0, signals: false });
    journal.close();
    for (let i = 0; i < 2; i++) {
      const seen = logs();
      const outcome = importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: seen.log });
      expect(outcome.status).toBe("not-empty");
      expect(seen.lines[0]).toMatch(new RegExp(`^warning: move: ${MOVE_DIR}/${name} not imported: this install's journal already has 1 events`));
    }
    expect(count(fresh.data)).toBe(1);
    expect(existsSync(join(fresh.config, MOVE_DIR, name))).toBe(true);
    expect(existsSync(join(fresh.config, "allowlist.json"))).toBe(false);
  });

  it("refuses two exports and names the newest", async () => {
    const { old, name } = await exported();
    const fresh = newInstall(old.config, name);
    cpSync(join(fresh.config, MOVE_DIR, name), join(fresh.config, MOVE_DIR, "20991231T235959Z"), { recursive: true });
    const seen = logs();
    const outcome = importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: seen.log });
    expect(outcome.status).toBe("refused");
    expect(outcome.folders).toEqual([name, "20991231T235959Z"]);
    expect(seen.lines[0]).toMatch(/^error: move: 2 exports wait .*the newest is 20991231T235959Z/);
    expect(readdirSync(fresh.data)).toEqual([]);
  });

  it("refuses an export whose files differ from the manifest", async () => {
    const { old, name } = await exported();
    const fresh = newInstall(old.config, name);
    writeFileSync(join(fresh.config, MOVE_DIR, name, "config", "allowlist.json"), "{}\n");
    const seen = logs();
    const outcome = importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: seen.log });
    expect(outcome.status).toBe("refused");
    expect(seen.lines[0]).toMatch(/config\/allowlist\.json differs from the manifest: copy the folder again/);
    expect(readdirSync(fresh.data)).toEqual([]);
    expect(existsSync(join(fresh.config, "allowlist.json"))).toBe(false);
  });

  it("refuses a folder without a manifest (copied in part)", async () => {
    const { old, name } = await exported();
    const fresh = newInstall(old.config, name);
    writeFileSync(join(fresh.config, MOVE_DIR, name, "manifest.json"), "");
    expect(importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: () => {} }).status).toBe("refused");
  });
});

describe("failures", () => {
  it("puts the data dir and the config folder back when the import fails half way", async () => {
    const old = await oldInstall();
    const out = await exportInstall({ dataDir: old.data, configDir: old.config, journal: old.journal.db, version: "9.9.9" }, { by: "local" });
    old.signals.close();
    old.journal.close();
    const fresh = newInstall(old.config, out.name);
    writeFileSync(join(fresh.data, "agent-tokens.json"), "theirs\n");
    writeFileSync(join(fresh.data, "views.db"), "views\n");
    writeFileSync(join(fresh.config, "heuristics.json"), "the new install's\n");
    // The commit (renaming the export) cannot happen: everything before it is undone.
    mkdirSync(join(fresh.config, MOVE_DIR, `${out.name}${IMPORTED}`, "in-the-way"), { recursive: true });
    const seen = logs();
    const outcome: ImportOutcome = importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: seen.log });
    expect(outcome.status).toBe("failed");
    expect(seen.lines[0]).toMatch(/^error: move: the import failed and the install is as it was/);
    expect(readdirSync(fresh.data).sort()).toEqual(["agent-tokens.json", "views.db"]);
    expect(readFileSync(join(fresh.data, "agent-tokens.json"), "utf8")).toBe("theirs\n");
    expect(readFileSync(join(fresh.data, "views.db"), "utf8")).toBe("views\n");
    expect(readFileSync(join(fresh.config, "heuristics.json"), "utf8")).toBe("the new install's\n");
    expect(existsSync(join(fresh.config, "allowlist.json"))).toBe(false);
    expect(existsSync(join(fresh.config, "heuristics", "my-rule.ts"))).toBe(false);
    expect(readdirSync(join(fresh.config, MOVE_DIR)).sort()).toEqual([out.name, `${out.name}${IMPORTED}`]);
  });

  it("puts back an import a crash interrupted, then imports again", async () => {
    const old = await oldInstall();
    const out = await exportInstall({ dataDir: old.data, configDir: old.config, journal: old.journal.db, version: "9.9.9" }, { by: "local" });
    old.signals.close();
    old.journal.close();
    const fresh = newInstall(old.config, out.name);
    // As a crash leaves it: the old tokens set aside, the new journal placed.
    mkdirSync(join(fresh.data, ".move-previous"));
    writeFileSync(join(fresh.data, ".move-previous", "agent-tokens.json"), "theirs\n");
    writeFileSync(join(fresh.data, ".move-previous", ".plan.json"), JSON.stringify({ export: out.name, placed: ["journal.db"] }));
    writeFileSync(join(fresh.data, "journal.db"), "half");
    const seen = logs();
    const outcome = importAtStart({ dataDir: fresh.data, configDir: fresh.config, log: seen.log });
    expect(seen.lines[0]).toMatch(/^warning: move: an import was interrupted/);
    expect(outcome.status).toBe("imported");
    expect(count(fresh.data)).toBe(out.manifest.journal.events);
    expect(existsSync(join(fresh.data, ".move-previous"))).toBe(false);
  });
});

describe("api/move", () => {
  it("exports and lists through ingress only, and journals who exported", async () => {
    const old = await oldInstall();
    const app = new Hono();
    mountMove(app, {
      mode: "addon",
      dataDir: old.data,
      configDir: old.config,
      journal: old.journal.db,
      signals: old.signals.db,
      version: "9.9.9",
      journalReader: old.journal,
      record: createMoveJournal(old.runtime),
    });
    const req = (method: string, path: string, peer: string, body?: unknown) =>
      app.request(
        path,
        { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { "content-type": "application/json", "x-remote-user-display-name": "Alex" } },
        env(peer),
      );
    for (const peer of ["172.30.32.1", "203.0.113.9", "127.0.0.1"]) {
      expect((await req("GET", "/api/move", peer)).status).toBe(403);
      expect((await req("POST", "/api/move/export", peer, {})).status).toBe(403);
    }
    expect(existsSync(join(old.config, MOVE_DIR))).toBe(false);

    const res = await req("POST", "/api/move/export", INGRESS, { signals: true });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { name: string; folder: string; manifest: { by: string; signals: boolean } };
    expect(out.manifest).toMatchObject({ by: "person:Alex", signals: true });
    const exported = old.journal.queryEvents({ category: MOVE_CATEGORY, order: "desc", limit: 1 })[0];
    expect(exported?.manifest).toBe("InstallExported");
    expect(exported?.payload).toMatchObject({ by: "person:Alex", folder: out.folder, signals: true });

    const info = (await (await req("GET", "/api/move", INGRESS)).json()) as MoveInfo;
    expect(info.folder).toBe(MOVE_DIR);
    expect(info.exports).toMatchObject([{ name: out.name, imported: false, by: "person:Alex" }]);
    expect(info.lastImport).toBeNull();
    old.signals.close();
    old.journal.close();
  });
});
