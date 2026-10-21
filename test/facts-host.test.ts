// Facts in the host: evaluated on signals and on time, journaled only when the value
// changes (teob-fact/<id>, caused by the signal), delivered to the instances that read
// them, recovered from the journal, and refused at a reload when they cannot run.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import type { HaEntityState, SignalRow } from "@lambda-house/teob-ts/ha";
import { houseScope } from "../src/allowlist.js";
import { defineHeuristic } from "../src/kernel/heuristic.js";
import { createHeuristicHost, type InstanceConfig } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { FACT_CATEGORY, fact } from "../src/kernel/fact.js";
import { loadLibrary } from "../src/packages/library.js";
import { createHouseService } from "../src/house/service.js";
import type { FactInfo, HouseFrame } from "../src/house/view.js";

const MOTION = "binary_sensor.shed_occupancy";
const someone = fact("someone-in-shed", ({ ha }) => ha.binary_sensor.shed_occupancy.is("on"), { title: "Someone in the shed" });
const quiet = fact("shed-quiet", ({ ha }) => ha.facts.someoneInShed.is(false));

const reader = defineHeuristic<{ fact: string }, Record<string, never>, never>({
  id: "reader",
  title: "Reader",
  description: "",
  watch: () => [],
  facts: (p) => [p.fact],
  actuates: () => [],
  initial: () => ({}),
  decide: (_s, input, ctx) => (input.kind === "fact" ? { why: `${input.fact} → ${String(ctx.fact(input.fact)?.value)}` } : undefined),
  evolve: (s) => s,
});

const scope = houseScope([MOTION], []);
const instances: InstanceConfig[] = [{ heuristic: "reader", id: "r", mode: "shadow", params: { fact: "shed-quiet" } }];

function setup(path = join(mkdtempSync(join(tmpdir(), "teobeanie-facts-")), "journal.db"), motion = "off") {
  const states = new Map<string, HaEntityState>([[MOTION, { entity_id: MOTION, state: motion, attributes: {}, last_changed: "2026-01-01T00:00:00Z", last_updated: "2026-01-01T00:00:00Z" }]]);
  const changed = vi.fn();
  const host = createHeuristicHost({
    library: [reader],
    facts: [quiet, someone],
    instances,
    actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
    liveState: (id) => states.get(id),
    scope,
    forceShadow: true,
    log: () => {},
    onFactChange: changed,
  });
  const journal = createSqliteJournal({ path });
  host.attach(journal);
  const set = (state: string, obsId: string): void => {
    states.set(MOTION, { ...states.get(MOTION)!, state, last_changed: new Date().toISOString() });
    const row: SignalRow = {
      obsId, entityId: MOTION, at: Date.now(), haTimeFired: Date.now(), raw: { state }, normalized: { value: state === "on", unit: null }, origin: "ha", haVersion: null, policyVersion: 1,
    };
    host.onSignal(row);
  };
  const rows = (category: string) => journal.queryEvents({ category, limit: 1000, order: "asc" });
  const close = async () => {
    await host.stop();
    journal.close();
  };
  return { host, set, rows, close, path, changed };
}

const start = { subscribeTrigger: async () => async () => {} };

describe("facts in the host", () => {
  it("routes the facts' entities, evaluates on start and on signals, journals only changes, caused by the signal", async () => {
    const t = setup();
    expect(t.host.watchedEntities()).toEqual([MOTION]);
    expect(t.host.instances()[0]?.facts).toEqual(["shed-quiet"]);
    await t.host.start(start);
    expect(t.host.facts().map((f) => [f.id, f.value, f.known, f.readers])).toEqual([
      ["someone-in-shed", false, true, []],
      ["shed-quiet", true, true, ["reader/r"]],
    ]);
    t.set("on", "obs-1");
    t.set("on", "obs-2"); // the same value again: nothing journaled
    const changes = t.rows(FACT_CATEGORY).filter((r) => r.manifest === "FactChanged");
    expect(changes.map((r) => [r.entityId, (r.payload as { value: unknown }).value, r.envelope?.causationId ?? null])).toEqual([
      ["someone-in-shed", false, null],
      // Evaluated at start, and again because the fact it reads got its first value.
      ["shed-quiet", true, changes[0]!.envelope!.eventId],
      ["someone-in-shed", true, "obs-1"],
      ["shed-quiet", false, changes[2]!.envelope!.eventId],
    ]);
    expect(t.changed).toHaveBeenCalled();
    // The reader heard of the change, caused by the FactChanged.
    await vi.waitFor(() => expect(t.rows("reader").filter((r) => r.manifest === "Decided")).toHaveLength(1));
    const decided = t.rows("reader").find((r) => r.manifest === "Decided")!;
    expect(decided.payload).toMatchObject({ input: { kind: "fact", fact: "shed-quiet", value: false }, why: "shed-quiet → false", facts: { "shed-quiet": false } });
    expect(decided.envelope?.causationId).toBe(changes[3]!.envelope!.eventId);
    await t.close();
  });

  it("recovers each fact from its stream: the same value at start journals nothing new", async () => {
    const first = setup();
    await first.host.start(start);
    first.set("on", "obs-1");
    await first.close();
    const again = setup(first.path, "on");
    // Folded before start: the value and since as journaled.
    expect(again.host.facts().find((f) => f.id === "someone-in-shed")).toMatchObject({ value: true, known: true });
    await again.host.start(start);
    expect(again.rows(FACT_CATEGORY).filter((r) => r.manifest === "FactChanged")).toHaveLength(4);
    await again.close();
  });

  it("wakes a fact when its time condition can flip", async () => {
    const t = setup(undefined, "on");
    const empty = fact("shed-empty", ({ ha, held }) => held(() => ha.binary_sensor.shed_occupancy.is("off"), 80));
    await t.host.prepare({ library: [reader], facts: [someone, quiet, empty], instances, scope }).commit();
    await t.host.start(start);
    t.set("off", "obs-1"); // last_changed now: empty in 80 ms
    expect(t.host.facts().find((f) => f.id === "shed-empty")?.value).toBe(false);
    await vi.waitFor(() => expect(t.host.facts().find((f) => f.id === "shed-empty")?.value).toBe(true), { timeout: 2000 });
    const last = t.rows(FACT_CATEGORY).filter((r) => r.entityId === "shed-empty").at(-1)!;
    expect(last.payload).toMatchObject({ tag: "FactChanged", value: true, input: { kind: "time" } });
    // Caused by the event that began the hold.
    expect(last.envelope?.causationId).toBe(t.rows(FACT_CATEGORY).filter((r) => r.entityId === "shed-empty").at(-2)!.envelope!.eventId);
    await t.close();
  });

  it("a reload with a cycle, or an instance reading a fact nobody defines, is refused", async () => {
    const t = setup();
    await t.host.start(start);
    const a = fact("a", ({ ha }) => ha.facts.b.value);
    const b = fact("b", ({ ha }) => ha.facts.a.value);
    expect(() => t.host.prepare({ library: [reader], facts: [a, b], instances: [], scope })).toThrow(/cycle: a → b → a/);
    expect(() => t.host.prepare({ library: [reader], facts: [someone], instances, scope })).toThrow(/reader\/r reads fact shed-quiet, which no running fact defines/);
    // A fact outside the scope.
    const outside = fact("hall", ({ ha }) => ha.binary_sensor.hall.is("on"));
    expect(() => t.host.prepare({ library: [reader], facts: [outside], instances: [], scope })).toThrow(/fact hall is outside the house scope/);
    // A valid reload keeps the values.
    await t.host.prepare({ library: [reader], facts: [someone, quiet], instances, scope }).commit();
    expect(t.host.facts().map((f) => f.value)).toEqual([false, true]);
    expect(t.rows(FACT_CATEGORY).filter((r) => r.manifest === "FactChanged")).toHaveLength(2);
    await t.close();
  });
});

describe("facts in the library", () => {
  const folder = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-facts-lib-"));
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    return dir;
  };
  const manifest = (facts?: Record<string, object>) =>
    JSON.stringify({ name: "shed", version: "1.0.0", platform: ">=0.2.0", title: "Shed", heuristics: {}, ...(facts !== undefined ? { facts } : {}) });
  const factFile = `import { fact } from "teobeanie";\nexport default fact("shed-busy", ({ ha }) => ha.binary_sensor.shed_occupancy.is("on"));\n`;

  it("a heuristics/ file may default-export facts next to rules", async () => {
    const dir = folder({
      "heuristics/shed.ts": `import { fact, rule, keep } from "teobeanie";
export default [
  fact("shed-empty", ({ ha }) => ha.binary_sensor.shed_occupancy.is("off"), { title: "Shed empty" }),
  rule("shed-light", ({ ha }) => ha.light.shed.to(ha.facts.shedEmpty.is(true) ? "off" : keep)),
];
`,
    });
    const lib = await loadLibrary(dir, () => {});
    expect(lib.facts.map((f) => [f.id, f.title])).toEqual([["shed-empty", "Shed empty"]]);
    expect(lib.heuristics.map((h) => [h.id, h.facts?.(undefined)])).toEqual([["shed-light", ["shedEmpty"]]]);
    // Only in the array: no binding to type it by.
    expect(lib.factSources.get("shed-empty")).toEqual({ file: join(dir, "heuristics", "shed.ts") });
  });

  it("a package names its facts in teobeanie.json; one it does not name is refused", async () => {
    const ok = folder({ "packages/shed/teobeanie.json": manifest({ "shed-busy": { title: "Shed busy" } }), "packages/shed/busy.ts": factFile });
    const lib = await loadLibrary(ok, () => {});
    expect(lib.facts.map((f) => f.id)).toEqual(["shed-busy"]);
    expect(lib.packages[0]).toMatchObject({ name: "shed", facts: ["shed-busy"], factSources: { "shed-busy": "busy.ts" } });
    expect(lib.factSources.get("shed-busy")).toMatchObject({ package: "shed", binding: "default" });
    const failures: string[] = [];
    await loadLibrary(folder({ "packages/shed/teobeanie.json": manifest({ "shed-idle": {} }), "packages/shed/busy.ts": factFile }), () => {}, failures);
    expect(failures).toEqual([
      `packages/shed: teobeanie.json names fact shed-idle, which the code does not define; the code defines fact shed-busy, which teobeanie.json does not name (under "facts")`,
    ]);
  });

  it("two files defining one fact id is an error", async () => {
    const failures: string[] = [];
    await loadLibrary(folder({ "heuristics/a.ts": factFile, "heuristics/b.ts": factFile }), () => {}, failures);
    expect(failures).toEqual(['b.ts: fact id "shed-busy" is already defined']);
  });
});

describe("facts on the House page and the read API", () => {
  const info = (value: boolean): FactInfo => ({ id: "shed-empty", title: "Shed empty", value, known: true, since: 1, watch: [MOTION], facts: [], readers: [] });

  it("api/house carries the facts; a frame carries them again when one changed", async () => {
    vi.useFakeTimers();
    try {
      let facts = [info(false)];
      const frames: HouseFrame[] = [];
      const client = { send: async <T>(): Promise<T> => Promise.reject(new Error("offline")), onStateChanged: () => () => {}, statisticsDuringPeriod: async () => ({}) };
      const svc = createHouseService({ ha: client, live: () => new Map(), groups: {}, tiles: [], facts: () => facts, publish: (f) => frames.push(f), listening: () => true, log: () => {} });
      expect((await svc.view()).facts).toEqual(facts);
      svc.factsChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames).toEqual([{ type: "house", at: expect.any(Number), states: {}, facts }]);
      svc.factsChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames).toHaveLength(1);
      facts = [info(true)];
      svc.factsChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames.at(-1)?.facts).toEqual(facts);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
