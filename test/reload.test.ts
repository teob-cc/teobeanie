// Config reload without a restart: the host's diff (only changed instances restart, on
// their own stream), invalid config leaving the running set alone, the reloader over a
// real config folder, POST api/reload, and the file watch's debounce.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import { houseScope } from "../src/allowlist.js";
import { defineHeuristic, setTimer } from "../src/kernel/heuristic.js";
import { createHeuristicHost, type InstanceConfig } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { createHouseService } from "../src/house/service.js";
import { applyConfig, createReloader, mountReload, summarize, watchConfig, type Reloader, type ReloadOutcome } from "../src/reload.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noLog = (): void => {};

/** Decides on start (and sets a short timer), and when the timer fires. */
const probe = defineHeuristic<{ sensor: string; light: string; delayMs?: number }, Record<string, never>, never>({
  id: "probe",
  title: "probe",
  description: "",
  watch: (p) => [p.sensor],
  actuates: (p) => [p.light],
  initial: () => ({}),
  decide(_s, input, ctx) {
    if (input.kind === "start") return { why: "start", timers: [setTimer("t", ctx.now + 250)] };
    if (input.kind === "timer") return { why: "fired" };
    return undefined;
  },
  evolve: (s) => s,
});

const inst = (id: string, extra: Partial<InstanceConfig> = {}): InstanceConfig => ({
  heuristic: "probe",
  id,
  mode: "shadow",
  params: { sensor: `binary_sensor.${id}_motion`, light: `light.${id}` },
  ...extra,
});

const ids = ["a", "b", "c", "d", "e"];
const everything = houseScope(
  ids.map((i) => `binary_sensor.${i}_motion`),
  ids.map((i) => `light.${i}`),
);

function setup(instances: InstanceConfig[]) {
  const actuator = createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } });
  const host = createHeuristicHost({
    library: [probe],
    instances,
    actuator,
    liveState: () => undefined,
    scope: everything,
    forceShadow: false,
    log: noLog,
  });
  const journal = createSqliteJournal({ path: join(mkdtempSync(join(tmpdir(), "teobeanie-reload-")), "journal.db") });
  host.attach(journal);
  /** Decisions per instance with this why. */
  const decided = (why: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of journal.queryEvents({ category: "probe", limit: 1000 })) {
      if (r.manifest === "Decided" && (r.payload as { why?: string }).why === why) out[r.entityId] = (out[r.entityId] ?? 0) + 1;
    }
    return out;
  };
  const close = async () => {
    await host.stop();
    journal.close();
  };
  return { host, actuator, decided, close };
}

describe("reloading the heuristic host", () => {
  it("restarts only what changed, on its own stream, and stops what was removed", async () => {
    const t = setup([inst("a"), inst("b"), inst("c"), inst("e")]);
    await t.host.start({ subscribeTrigger: async () => async () => {} });
    await vi.waitFor(() => expect(t.decided("start")).toEqual({ a: 1, b: 1, c: 1, e: 1 }));

    const next = [inst("a"), inst("b", { mode: "active" }), inst("c", { params: { sensor: "binary_sensor.c_motion", light: "light.c", delayMs: 5 } }), inst("d")];
    const prepared = t.host.prepare({ library: [probe], instances: next, scope: everything });
    expect(prepared.changes).toEqual({
      added: ["probe/d"],
      removed: ["probe/e"],
      changed: [
        { key: "probe/b", why: "mode" },
        { key: "probe/c", why: "params" },
      ],
      unchanged: 1,
    });
    expect(summarize(prepared.changes)).toBe("+1 −1 ~2 (mode, params) unchanged 1");
    await prepared.commit();

    // a kept running; b and c started again, d for the first time; e is gone.
    await vi.waitFor(() => expect(t.decided("start")).toEqual({ a: 1, b: 2, c: 2, d: 1, e: 1 }));
    expect(t.host.instances().map((i) => `${i.key}=${i.mode}`)).toEqual(["probe/a=shadow", "probe/b=active", "probe/c=shadow", "probe/d=shadow"]);
    expect([...t.actuator.owners().entries()]).toEqual([
      ["light.a", "probe/a"],
      ["light.b", "probe/b"],
      ["light.c", "probe/c"],
      ["light.d", "probe/d"],
    ]);
    expect(t.host.watchedEntities()).not.toContain("binary_sensor.e_motion");

    // Timers: the restarted ones' replayed timer and their new one are the same id, so
    // each instance fires once; the removed instance's timer died with its runtime.
    await sleep(400);
    expect(t.decided("fired")).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    await t.close();
  });

  it("an unchanged config restarts nothing", async () => {
    const t = setup([inst("a"), inst("b")]);
    await t.host.start({ subscribeTrigger: async () => async () => {} });
    const prepared = t.host.prepare({ library: [probe], instances: [inst("a"), inst("b")], scope: everything });
    expect(prepared.changes).toEqual({ added: [], removed: [], changed: [], unchanged: 2 });
    await prepared.commit();
    await sleep(50);
    expect(t.decided("start")).toEqual({ a: 1, b: 1 });
    await t.close();
  });

  it("a new definition of the same heuristic (edited code) restarts its instances", () => {
    const t = setup([inst("a")]);
    const edited = { ...probe };
    const prepared = t.host.prepare({ library: [edited], instances: [inst("a")], scope: everything });
    expect(prepared.changes.changed).toEqual([{ key: "probe/a", why: "code" }]);
    void t.close();
  });

  it("rejects an invalid config with its reason, and changes nothing", () => {
    const t = setup([inst("a"), inst("b")]);
    const before = { instances: t.host.instances(), owners: [...t.actuator.owners()] };
    const reject = (instances: InstanceConfig[], scope = everything) => () => t.host.prepare({ library: [probe], instances, scope });
    expect(reject([inst("a"), { heuristic: "no-such", id: "x", params: {} }])).toThrow(/unknown heuristic "no-such"/);
    expect(reject([inst("a"), inst("b")], houseScope(["binary_sensor.a_motion", "binary_sensor.b_motion"], ["light.a"]))).toThrow(
      /probe\/b is outside the house scope .* not "operate": light\.b/,
    );
    expect(reject([inst("a"), inst("b", { params: { sensor: "binary_sensor.b_motion", light: "light.a" } })])).toThrow(/light\.a is claimed by both probe\/a and probe\/b/);
    expect(reject([inst("a"), inst("a")])).toThrow(/duplicate instance probe\/a/);
    expect({ instances: t.host.instances(), owners: [...t.actuator.owners()] }).toEqual(before);
    void t.close();
  });
});

describe("the reloader over a config folder", () => {
  const allowlist = (ids: string[]) =>
    JSON.stringify({ entities: ids.flatMap((i) => [{ id: `binary_sensor.${i}_motion` }, { id: `light.${i}`, operate: true }]) });

  function folder() {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-reload-cfg-"));
    writeFileSync(join(dir, "allowlist.json"), allowlist(["a", "b"]));
    writeFileSync(join(dir, "heuristics.json"), JSON.stringify({ instances: [inst("a")] }));
    writeFileSync(join(dir, "tiles.json"), JSON.stringify({ tiles: [] }));
    return dir;
  }

  function reloaderFor(dir: string) {
    const t = setup([inst("a")]);
    const logged: string[] = [];
    const swapped: string[][] = [];
    const reloader = createReloader({
      apply: () =>
        applyConfig({
          configDir: dir,
          extra: [probe],
          host: t.host,
          log: noLog,
          swap: (next, prepared) => swapped.push([...next.allowlist.scope.observed, ...prepared.watchedEntities]),
        }),
      log: (level, msg) => logged.push(`${level} ${msg}`),
    });
    return { ...t, reloader, logged, swapped };
  }

  it("applies a valid change and logs a one-line summary", async () => {
    const dir = folder();
    const r = reloaderFor(dir);
    writeFileSync(join(dir, "heuristics.json"), JSON.stringify({ instances: [inst("a", { mode: "active" }), inst("b")] }));
    const outcome = await r.reloader.reload("api");
    expect(outcome).toMatchObject({ ok: true, source: "api", summary: "+1 −0 ~1 (mode) unchanged 0" });
    expect(r.logged).toEqual(["info reload (api): +1 −0 ~1 (mode) unchanged 0 — +probe/b, ~probe/a (mode)"]);
    expect(r.host.instances().map((i) => i.key)).toEqual(["probe/a", "probe/b"]);
    expect(r.swapped).toHaveLength(1);
    expect(r.reloader.last()).toBe(outcome);
    await r.close();
  });

  it("rejects broken JSON, an out-of-scope entity and a broken custom heuristic, keeping the running set", async () => {
    const dir = folder();
    const r = reloaderFor(dir);
    const before = r.host.instances();
    const rejected = async (): Promise<string> => {
      const o = await r.reloader.reload("file");
      expect(o.ok).toBe(false);
      expect(r.host.instances()).toEqual(before);
      return o.error!;
    };

    writeFileSync(join(dir, "heuristics.json"), `{ "instances": [ `);
    expect(await rejected()).toMatch(/heuristics\.json: unparseable JSON/);

    writeFileSync(join(dir, "heuristics.json"), JSON.stringify({ instances: [inst("a"), inst("c")] }));
    expect(await rejected()).toMatch(/probe\/c is outside the house scope .* not listed: binary_sensor\.c_motion/);

    writeFileSync(join(dir, "heuristics.json"), JSON.stringify({ instances: [inst("a")] }));
    writeFileSync(join(dir, "allowlist.json"), `{ "entities": [{ "id": "light.a", "debounce": "sometimes" }] }`);
    expect(await rejected()).toMatch(/unknown debounce class "sometimes"/);

    writeFileSync(join(dir, "allowlist.json"), allowlist(["a", "b"]));
    mkdirSync(join(dir, "heuristics"));
    writeFileSync(join(dir, "heuristics", "half-written.js"), "export default { id: 'half-written' };");
    expect(await rejected()).toMatch(/half-written\.js.*missing "title"/);

    expect(r.swapped).toEqual([]);
    expect(r.logged.every((l) => l.startsWith("warning reload (file) rejected, the running config stays: "))).toBe(true);
    await r.close();
  });

  it("runs reloads one at a time, in order", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const reloader = createReloader({
      apply: async () => {
        order.push("start");
        if (order.length === 1) await new Promise<void>((r) => (release = r));
        order.push("end");
        return { added: [], removed: [], changed: [], unchanged: 0 };
      },
      log: noLog,
    });
    const first = reloader.reload("file");
    const second = reloader.reload("api");
    await sleep(10);
    expect(order).toEqual(["start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });
});

describe("the House view after a reload", () => {
  it("shows the new scope and tiles", async () => {
    const st = (entity_id: string) => ({ entity_id, state: "on", attributes: {}, last_changed: "", last_updated: "" });
    const live = new Map([st("light.a"), st("light.b")].map((s) => [s.entity_id, s]));
    const svc = createHouseService({
      ha: { send: async () => Promise.reject(new Error("offline")), onStateChanged: () => () => {}, statisticsDuringPeriod: async () => ({}) },
      live: () => live,
      observes: (id) => id === "light.a",
      groups: {},
      tiles: [],
      publish: () => {},
      listening: () => false,
      log: noLog,
    });
    expect(Object.keys((await svc.view()).entities)).toEqual(["light.a"]);
    svc.configure({ observes: () => true, groups: {}, tiles: [{ entityId: "light.b", label: "B", kind: "binary" }] });
    const v = await svc.view();
    expect(Object.keys(v.entities).sort()).toEqual(["light.a", "light.b"]);
    expect(v.tiles.map((t) => t.entityId)).toEqual(["light.b"]);
    svc.stop();
  });
});

describe("POST api/reload", () => {
  function app(outcome: ReloadOutcome) {
    const calls: string[] = [];
    const reloader: Reloader = {
      reload: async (source) => {
        calls.push(source);
        return outcome;
      },
      edit: async () => outcome,
      last: () => outcome,
    };
    const a = new Hono();
    mountReload(a, { mode: "addon", reloader });
    const post = (ip: string) => a.request("/api/reload", { method: "POST" }, { incoming: { socket: { remoteAddress: ip } } });
    return { post, calls };
  }

  it("reloads through ingress only, and answers with the outcome", async () => {
    const ok = app({ ok: true, at: 1, source: "api", summary: "+0 −0 ~0 unchanged 3" });
    expect((await ok.post("172.30.33.5")).status).toBe(403); // another add-on
    expect(ok.calls).toEqual([]);
    const res = await ok.post("172.30.32.2");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, summary: "+0 −0 ~0 unchanged 3" });
    expect(ok.calls).toEqual(["api"]);

    const bad = app({ ok: false, at: 1, source: "api", error: "heuristics.json: unparseable JSON" });
    const rejected = await bad.post("172.30.32.2");
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ ok: false, error: "heuristics.json: unparseable JSON" });
  });
});

describe("watching the config folder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads once, 1 s after the last change to a config file", () => {
    vi.useFakeTimers();
    let emit: (event: string, filename: string | null) => void = () => {};
    let closed = false;
    const changes: string[][] = [];
    const w = watchConfig({
      dir: "/config",
      log: noLog,
      onChange: (files) => changes.push(files),
      watch: (_dir, listener) => {
        emit = listener;
        return { close: () => (closed = true) };
      },
    });

    emit("change", "heuristics.json");
    vi.advanceTimersByTime(600);
    emit("rename", "heuristics.json");
    emit("change", "notes.txt"); // not config
    vi.advanceTimersByTime(999);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([["heuristics.json"]]);

    emit("change", "tiles.json");
    emit("change", "allowlist.json");
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([["heuristics.json"], ["allowlist.json", "tiles.json"]]);

    emit("change", "notes.txt");
    vi.advanceTimersByTime(5000);
    expect(changes).toHaveLength(2);

    emit("change", "tiles.json");
    w.close();
    vi.advanceTimersByTime(5000);
    expect(changes).toHaveLength(2);
    expect(closed).toBe(true);
  });
});
