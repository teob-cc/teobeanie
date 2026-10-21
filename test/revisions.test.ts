// The working set's revisions: a snapshot per applied change with its files stored once
// each, a rollback that writes a revision's files back through the reload path (and is a
// revision itself), across a restart, put back when the reload rejects it; the API; and
// the file watch covering heuristics/ and packages/.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { houseScope } from "../src/allowlist.js";
import { defineHeuristic, type AnyHeuristic } from "../src/kernel/heuristic.js";
import { createHeuristicHost, loadInstances } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { STARTER_DIR } from "../src/packages/library.js";
import { applyConfig, createReloader, watchConfig } from "../src/reload.js";
import { configAggregate, configEventCodec, configStateCodec, createConfigJournal, CONFIG_CATEGORY, type ConfigChanged } from "../src/working-set.js";
import {
  createRevisionStore,
  diffRevisions,
  listRevisions,
  mountRevisions,
  recordBootRevision,
  revisionFile,
  rollback,
  unifiedDiff,
  workingSetPaths,
} from "../src/revisions.js";

const noLog = (): void => {};

const probe = (id: string): AnyHeuristic =>
  defineHeuristic<{ sensor: string; light: string; delayMin?: number }, Record<string, never>, never>({
    id,
    title: id,
    description: "",
    watch: (p) => [p.sensor],
    actuates: (p) => [p.light],
    initial: () => ({}),
    decide: () => undefined,
    evolve: (s) => s,
  });

const ALLOWLIST = JSON.stringify({ entities: ["a", "b"].flatMap((i) => [{ id: `binary_sensor.${i}_motion` }, { id: `light.${i}`, operate: true }]) });
const heuristicsJson = (instances: object[]): string => `${JSON.stringify({ instances }, null, 2)}\n`;
const A = { heuristic: "probe", id: "a", mode: "shadow", params: { sensor: "binary_sensor.a_motion", light: "light.a" } };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A config folder and a data folder; `boot()` starts Teobeanie on them (again, after a restart). */
function house() {
  const dir = mkdtempSync(join(tmpdir(), "teobeanie-revisions-"));
  const config = join(dir, "config");
  const data = join(dir, "data");
  mkdirSync(config);
  mkdirSync(data);
  writeFileSync(join(config, "allowlist.json"), ALLOWLIST);
  writeFileSync(join(config, "heuristics.json"), heuristicsJson([A]));
  writeFileSync(join(config, "tiles.json"), JSON.stringify({ tiles: [] }));
  /** The definitions the folder does not hold; a test takes one away to make a reload fail. */
  const extra: AnyHeuristic[] = [probe("probe"), probe("probe-b")];

  const boot = async () => {
    const { runtime, journal } = createSqliteRuntime({ path: join(data, "journal.db") }, [registration(configAggregate, configEventCodec, configStateCodec)]);
    const host = createHeuristicHost({
      library: extra,
      instances: loadInstances(config, noLog),
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
      liveState: () => undefined,
      scope: houseScope(["binary_sensor.a_motion", "binary_sensor.b_motion"], ["light.a", "light.b"]),
      forceShadow: false,
      log: noLog,
    });
    host.attach(journal);
    const record = createConfigJournal(runtime);
    const store = createRevisionStore({ dir: join(data, "revisions"), configDir: config, journal });
    await recordBootRevision(store, record);
    const reloader = createReloader({
      apply: () => applyConfig({ configDir: config, extra: [...extra], host, log: noLog }),
      log: noLog,
      configDir: config,
      instances: () => host.instances(),
      record,
      revisions: store,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await host.stop();
      await runtime.shutdown();
      journal.close();
    };
    closers.push(close);
    const changes = (): ConfigChanged[] => journal.queryEvents({ category: CONFIG_CATEGORY, order: "asc", limit: 100 }).map((r) => r.payload as ConfigChanged);
    return { host, journal, store, reloader, changes, close };
  };
  const read = (p: string): string => readFileSync(join(config, p), "utf8");
  const write = (p: string, text: string): void => {
    mkdirSync(join(config, p, ".."), { recursive: true });
    writeFileSync(join(config, p), text);
  };
  const objects = (): number => {
    const root = join(data, "revisions", "objects");
    return existsSync(root) ? readdirSync(root).flatMap((d) => readdirSync(join(root, d))).length : 0;
  };
  return { config, data, extra, boot, read, write, objects };
}

describe("revisions", () => {
  it("records the working set at start as revision 1, and each applied change as the next, its files stored once", async () => {
    const h = house();
    h.write("heuristics/ha.d.ts", "// generated"); // generated: not the house's
    h.write("heuristics/.my-rule.ts.swp", "x"); // an editor's
    h.write("notes.txt", "not part of the working set");
    const t = await h.boot();
    expect(listRevisions(t.store)).toMatchObject([{ revision: 1, by: "boot", summary: "the working set at start", fileCount: 3 }]);
    expect(Object.keys(t.store.get(1)!.files)).toEqual(["allowlist.json", "heuristics.json", "tiles.json"]);
    expect(h.objects()).toBe(3);

    h.write("heuristics.json", heuristicsJson([{ ...A, mode: "active" }]));
    const outcome = await t.reloader.reload("file");
    expect(outcome.journaled).toMatchObject({ revision: 2, parent: 1, file: "heuristics.json", by: "file", summary: "probe/a: mode shadow → active", instances: ["probe/a"] });
    // One new object: the other two files are the same as in revision 1.
    expect(h.objects()).toBe(4);
    expect(t.changes().map((c) => [c.revision, c.parent])).toEqual([
      [1, undefined],
      [2, 1],
    ]);

    // A spec under heuristics/ changes no instance, but is a change of the working set.
    h.write("heuristics/my-rule.test.ts", "it('works', () => {});\n");
    expect((await t.reloader.reload("file")).journaled).toMatchObject({ revision: 3, file: "heuristics/my-rule.test.ts", summary: "no instance changed" });
    // Nothing changed: no revision.
    expect((await t.reloader.reload("file")).journaled).toBeUndefined();
    expect(t.store.last()?.revision).toBe(3);
  });

  it("at start, records files edited while it was stopped as a new revision, and nothing when they are the same", async () => {
    const h = house();
    let t = await h.boot();
    await t.close();
    t = await h.boot();
    expect(t.store.list().map((r) => r.revision)).toEqual([1]);
    await t.close();
    h.write("tiles.json", JSON.stringify({ tiles: [{ entity: "binary_sensor.a_motion" }] }));
    t = await h.boot();
    expect(listRevisions(t.store)[0]).toMatchObject({ revision: 2, parent: 1, by: "boot", file: "tiles.json", summary: "changed while Teobeanie was stopped" });
  });

  it("diffs two revisions file by file", async () => {
    const h = house();
    const t = await h.boot();
    h.write("heuristics.json", heuristicsJson([{ ...A, params: { ...A.params, delayMin: 10 } }]));
    h.write("heuristics/notes.md", "Door reminders.\n");
    await t.reloader.reload("file");
    const diff = diffRevisions(t.store, 1, 2);
    expect(diff.map((d) => [d.path, d.status])).toEqual([
      ["heuristics.json", "changed"],
      ["heuristics/notes.md", "added"],
    ]);
    expect(diff[0]!.diff).toBe(
      [
        "--- a/heuristics.json",
        "+++ b/heuristics.json",
        "@@ -6,7 +6,8 @@",
        '       "mode": "shadow",',
        '       "params": {',
        '         "sensor": "binary_sensor.a_motion",',
        '-        "light": "light.a"',
        '+        "light": "light.a",',
        '+        "delayMin": 10',
        "       }",
        "     }",
        "   ]",
        "",
      ].join("\n"),
    );
    expect(diff[1]!.diff).toBe("--- /dev/null\n+++ b/heuristics/notes.md\n@@ -0,0 +1,1 @@\n+Door reminders.\n");
    expect(diffRevisions(t.store, 2, 1)[1]).toMatchObject({ status: "removed" });
    expect(revisionFile(t.store, 2, "heuristics/notes.md")).toBe("Door reminders.\n");
    expect(() => diffRevisions(t.store, 1, 9)).toThrow(/no revision 9/);
  });

  it("a unified diff keeps three lines of context and merges close changes", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const b = a.replace("line 2\n", "line two\n").replace("line 5\n", "").replace("line 18", "line eighteen");
    expect(unifiedDiff(a, b)).toBe(
      [
        "@@ -1,8 +1,7 @@",
        " line 1",
        "-line 2",
        "+line two",
        " line 3",
        " line 4",
        "-line 5",
        " line 6",
        " line 7",
        " line 8",
        "@@ -15,6 +14,6 @@",
        " line 15",
        " line 16",
        " line 17",
        "-line 18",
        "+line eighteen",
        " line 19",
        " line 20",
        "",
      ].join("\n"),
    );
    expect(unifiedDiff(a, a)).toBe("");
  });
});

describe("rollback", () => {
  it("puts a revision's files back across a restart, through the reload, as a new revision", async () => {
    const h = house();
    let t = await h.boot();
    const original = h.read("heuristics.json");
    h.write("heuristics.json", heuristicsJson([{ ...A, mode: "active" }]));
    h.write("heuristics/my-rule.test.ts", "it('works', () => {});\n");
    cpSync(join(STARTER_DIR, "hold"), join(h.config, "packages", "hold"), { recursive: true });
    expect((await t.reloader.reload("file")).ok).toBe(true);
    expect(t.host.instances()[0]?.mode).toBe("active");
    await t.close();

    // A restart: the revisions are read back from the journal, the files from /data.
    h.write("notes.txt", "mine");
    h.write("heuristics/ha.d.ts", "// generated");
    t = await h.boot();
    expect(t.store.list().map((r) => r.revision)).toEqual([1, 2]);
    const outcome = await rollback(t, 1, "person:Alex");
    expect(outcome).toMatchObject({ ok: true, by: "person:Alex", journaled: { revision: 3, parent: 2, summary: "rollback to 1", by: "person:Alex" } });
    expect(outcome.journaled?.file).toMatch(/^heuristics\.json, heuristics\/my-rule\.test\.ts, packages\/hold\/.*README\.md/);
    expect(h.read("heuristics.json")).toBe(original);
    // Added since 1 and part of the working set: removed, with the folder it emptied.
    expect(existsSync(join(h.config, "heuristics/my-rule.test.ts"))).toBe(false);
    expect(existsSync(join(h.config, "packages/hold"))).toBe(false);
    expect(existsSync(join(h.config, "packages"))).toBe(true);
    // Not part of the working set: untouched.
    expect(h.read("notes.txt")).toBe("mine");
    expect(h.read("heuristics/ha.d.ts")).toBe("// generated");
    expect(t.host.instances()[0]?.mode).toBe("shadow");
    expect(t.store.get(3)!.files).toEqual(t.store.get(1)!.files);

    // The rollback is undone like any change.
    expect((await rollback(t, 2, "person:Alex")).journaled).toMatchObject({ revision: 4, summary: "rollback to 2" });
    expect(t.host.instances()[0]?.mode).toBe("active");
    expect(h.read("packages/hold/README.md")).toBe(readFileSync(join(STARTER_DIR, "hold", "README.md"), "utf8"));
  });

  it("a rejected rollback puts every file back and journals nothing", async () => {
    const h = house();
    const t = await h.boot();
    h.write("heuristics.json", heuristicsJson([{ ...A, heuristic: "probe-b" }]));
    h.write("heuristics/my-rule.test.ts", "it('works', () => {});\n");
    await t.reloader.reload("file");
    const before = { heuristics: h.read("heuristics.json"), spec: h.read("heuristics/my-rule.test.ts") };
    // The heuristic revision 1 runs is gone: going back to it cannot load.
    h.extra.splice(0, 1);
    const outcome = await rollback(t, 1, "person:Alex");
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/unknown heuristic "probe"/) });
    expect({ heuristics: h.read("heuristics.json"), spec: h.read("heuristics/my-rule.test.ts") }).toEqual(before);
    expect(t.store.last()?.revision).toBe(2);
    expect(t.host.instances().map((i) => i.key)).toEqual(["probe-b/a"]);
    await expect(rollback(t, 7, "cli")).rejects.toThrow(/no revision 7/);
  });
});

describe("the revisions API", () => {
  it("lists, shows, diffs, and rolls back through ingress only", async () => {
    const h = house();
    const t = await h.boot();
    h.write("heuristics.json", heuristicsJson([{ ...A, mode: "active" }]));
    await t.reloader.reload("file");
    const app = new Hono();
    mountRevisions(app, { mode: "addon", store: t.store, reloader: t.reloader });
    const get = (url: string) => app.request(url);
    const post = (url: string, ip = "172.30.32.2") =>
      app.request(url, { method: "POST", headers: { "x-remote-user-display-name": "Alex" } }, { incoming: { socket: { remoteAddress: ip } } });

    expect(await (await get("/api/revisions")).json()).toMatchObject({ revisions: [{ revision: 2, parent: 1, by: "file" }, { revision: 1, by: "boot" }] });
    expect(await (await get("/api/revisions/1")).json()).toMatchObject({ revision: 1, files: [{ path: "allowlist.json" }, { path: "heuristics.json" }, { path: "tiles.json" }] });
    expect(await (await get("/api/revisions/1?path=heuristics.json")).text()).toBe(heuristicsJson([A]));
    expect((await get("/api/revisions/9")).status).toBe(404);
    const diff = (await (await get("/api/revisions/1/diff/2")).json()) as { files: Array<{ path: string; diff: string }> };
    expect(diff.files.map((f) => f.path)).toEqual(["heuristics.json"]);
    expect(diff.files[0]!.diff).toContain('-      "mode": "shadow",\n+      "mode": "active",');

    expect((await post("/api/revisions/1/rollback", "172.30.33.5")).status).toBe(403);
    expect((await post("/api/revisions/9/rollback")).status).toBe(404);
    const res = await post("/api/revisions/1/rollback");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, journaled: { revision: 3, by: "person:Alex", summary: "rollback to 1" } });
    expect(h.read("heuristics.json")).toBe(heuristicsJson([A]));
  });
});

describe("the working set's files", () => {
  it("are the three JSON files, the lock, heuristics/ and packages/, without dot files and generated typings", () => {
    const h = house();
    h.write("teobeanie.lock.json", "{}");
    h.write("heuristics/my-rule.ts", "");
    h.write("heuristics/ha.d.ts", "");
    h.write("packages/hold/src/hold.ts", "");
    h.write("packages/hold/.DS_Store", "");
    h.write("packages/hold/node_modules/x/index.js", "");
    h.write(".teob/toolkit.d.ts", "");
    h.write("README.md", "");
    expect(workingSetPaths(h.config)).toEqual(["allowlist.json", "heuristics.json", "heuristics/my-rule.ts", "packages/hold/src/hold.ts", "teobeanie.lock.json", "tiles.json"]);
  });
});

describe("watching the working set", () => {
  it("reloads on a change under packages/ and heuristics/ too, debounced, and not for other files", () => {
    vi.useFakeTimers();
    try {
      let emit: (event: string, filename: string | null) => void = () => {};
      const onChange = vi.fn();
      const w = watchConfig({
        dir: "/config",
        log: noLog,
        onChange,
        watch: (_dir, listener) => {
          emit = listener;
          return { close() {} };
        },
      });
      emit("change", "packages/door-watch/door-nag.ts");
      emit("rename", "packages/door-watch/README.md");
      vi.advanceTimersByTime(500);
      emit("change", "heuristics/my-rule.ts");
      vi.advanceTimersByTime(999);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith(["heuristics/my-rule.ts", "packages/door-watch/README.md", "packages/door-watch/door-nag.ts"]);

      for (const f of ["notes.txt", "heuristics/ha.d.ts", ".teob/toolkit.d.ts", "packages/door-watch/.door-nag.ts.swp", ".git/index", "packages/x/node_modules/y.js"]) emit("change", f);
      vi.advanceTimersByTime(2000);
      expect(onChange).toHaveBeenCalledTimes(1);

      emit("rename", "packages\\hold"); // a package folder removed, on Windows
      emit("change", "teobeanie.lock.json");
      vi.advanceTimersByTime(1000);
      expect(onChange).toHaveBeenLastCalledWith(["packages\\hold", "teobeanie.lock.json"]);
      w.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
