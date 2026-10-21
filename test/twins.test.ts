// Shadow twins: a twin may watch, read and claim what its active original owns (it vets
// as the original, without spending its rate budget), is never active while its
// original is; its decisions are compared with the original's per input signal; and
// promote swaps them in one revision, which a rollback undoes.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalRow } from "@lambda-house/teob-ts/ha";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { houseScope } from "../src/allowlist.js";
import { call, defineHeuristic } from "../src/kernel/heuristic.js";
import { createHeuristicHost, loadInstances, type InstanceConfig } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { fact } from "../src/kernel/fact.js";
import { applyConfig, createReloader } from "../src/reload.js";
import { configAggregate, configEventCodec, configStateCodec, createConfigJournal, promoteTwinText } from "../src/working-set.js";
import { createRevisionStore, recordBootRevision, rollback } from "../src/revisions.js";
import { compareTwin, mountTwins, promoteTwin } from "../src/twins.js";

const noLog = (): void => {};

/** Motion: switches the light on, with the service its params say. */
const follow = defineHeuristic<{ sensor: string; light: string; service?: string }, Record<string, never>, never>({
  id: "follow",
  title: "follow",
  description: "",
  watch: (p) => [p.sensor],
  actuates: (p) => [p.light],
  initial: () => ({}),
  decide(_s, input, ctx) {
    if (input.kind !== "signal" || input.state !== "on") return undefined;
    return { why: "motion", actions: [call(ctx.params.service ?? "light.turn_on", ctx.params.light)] };
  },
  evolve: (s) => s,
});

const P = { sensor: "binary_sensor.a_motion", light: "light.a" };
const original: InstanceConfig = { heuristic: "follow", id: "a", mode: "active", params: P };
const twin = (extra: Partial<InstanceConfig> = {}): InstanceConfig => ({ heuristic: "follow", id: "a-next", mode: "shadow", params: { ...P, service: "light.turn_off" }, twinOf: "follow/a", ...extra });
const scope = houseScope(["binary_sensor.a_motion", "binary_sensor.b_motion"], ["light.a", "light.b"]);

const sig = (n: number, state = "on"): SignalRow =>
  ({ obsId: `obs-${n}`, entityId: "binary_sensor.a_motion", at: Date.now(), haTimeFired: Date.now(), raw: { state }, normalized: { value: state === "on", unit: null }, origin: "ha", haVersion: null, policyVersion: 1 }) as unknown as SignalRow;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function setup(instances: InstanceConfig[], configDir?: string) {
  const dir = configDir ?? mkdtempSync(join(tmpdir(), "teobeanie-twins-"));
  const calls: string[] = [];
  const actuator = createSafeActuator({
    ha: {
      callService: async (r) => {
        calls.push(`${r.domain}.${r.service}`);
        return { context: { id: "x" } };
      },
    },
    policy: { callsPerEntityPerHour: 2 },
  });
  const { runtime, journal } = createSqliteRuntime({ path: join(dir, "journal.db") }, [registration(configAggregate, configEventCodec, configStateCodec)]);
  const host = createHeuristicHost({ library: [follow], instances, actuator, liveState: () => undefined, scope, forceShadow: false, log: noLog });
  host.attach(journal);
  closers.push(async () => {
    await host.stop();
    await runtime.shutdown();
    journal.close();
  });
  const rows = (id: string) => journal.queryEvents({ category: "follow", entityId: id, order: "asc", limit: 1000 });
  return { dir, host, actuator, journal, runtime, calls, rows };
}

describe("a shadow twin", () => {
  it("claims what its active original owns, vets as it without spending its budget, and never acts", async () => {
    const t = setup([original, twin()]);
    expect([...t.actuator.owners()]).toEqual([["light.a", "follow/a"]]);
    expect(t.host.instances().map((i) => [i.key, i.mode, i.twinOf])).toEqual([
      ["follow/a", "active", undefined],
      ["follow/a-next", "shadow", "follow/a"],
    ]);
    await t.host.start({ subscribeTrigger: async () => async () => {} });
    t.host.onSignal(sig(1));
    t.host.onSignal(sig(2));
    await vi.waitFor(() => expect(t.calls).toHaveLength(2));
    await vi.waitFor(() => expect(t.rows("a-next").filter((r) => r.manifest === "ActionSuppressed")).toHaveLength(2));
    // The original's two calls an hour were its own: the twin's decisions spent none of them.
    expect(t.calls).toEqual(["light.turn_on", "light.turn_on"]);
    expect(t.rows("a").filter((r) => r.manifest === "ActionRequested")).toHaveLength(2);
    expect(t.rows("a-next").filter((r) => r.manifest === "ActionRefused")).toEqual([]);
  });

  it("is never active while its original is, and names an instance that is not a twin itself", () => {
    const t = setup([original]);
    const prepare = (instances: InstanceConfig[]) => () => t.host.prepare({ library: [follow], instances, scope });
    expect(prepare([original, twin({ mode: "active" })])).toThrow(/follow\/a-next: a twin cannot be active while its original follow\/a is/);
    expect(prepare([original, twin({ twinOf: "follow/z" })])).toThrow(/twinOf "follow\/z": no such instance/);
    expect(prepare([original, twin(), twin({ id: "a-third", twinOf: "follow/a-next" })])).toThrow(/twinOf follow\/a-next, which is itself a twin/);
    expect(prepare([original, twin(), twin({ id: "a-third" })])).toThrow(/follow\/a already has a twin/);
    // Without twinOf the same instance is a second owner.
    const { twinOf: _, ...plain } = twin();
    expect(prepare([original, plain])).toThrow(/light\.a is claimed by both follow\/a and follow\/a-next/);
    // A twin that switches a third instance's light would fight it.
    const other: InstanceConfig = { heuristic: "follow", id: "b", mode: "active", params: { sensor: "binary_sensor.b_motion", light: "light.b" } };
    expect(prepare([original, other, twin({ params: { ...P, light: "light.b" } })])).toThrow(/follow\/a-next actuates light\.b \(owned by follow\/b\), which its twin does not own/);
  });

  it("an active twin of a shadow original owns, and the original vets as it", () => {
    const t = setup([{ ...original, mode: "shadow" }, twin({ mode: "active" })]);
    expect([...t.actuator.owners()]).toEqual([["light.a", "follow/a-next"]]);
  });

  it("shows where its decisions differ from the original's on the same signals", async () => {
    const t = setup([original, twin({ params: P })]);
    await t.host.start({ subscribeTrigger: async () => async () => {} });
    t.host.onSignal(sig(1));
    await vi.waitFor(() => expect(t.rows("a-next").filter((r) => r.manifest === "Decided")).toHaveLength(1));
    // Same params: the same action on the same input.
    const range = { fromMs: Date.now() - 60_000, toMs: Date.now() + 60_000 };
    expect(compareTwin(t.journal, "follow/a-next", "follow/a", range)).toMatchObject({ compared: 1, same: 1, differences: [] });

    // New params for the twin (a reload restarts it): now it would switch the light off.
    await t.host.prepare({ library: [follow], instances: [original, twin()], scope }).commit();
    t.host.onSignal(sig(2));
    t.host.onSignal(sig(3, "off"));
    await vi.waitFor(() => expect(t.rows("a-next").filter((r) => r.manifest === "Decided")).toHaveLength(2));
    const c = compareTwin(t.journal, "follow/a-next", "follow/a", { fromMs: Date.now() - 60_000, toMs: Date.now() + 60_000 });
    expect(c).toMatchObject({
      twin: "follow/a-next",
      original: "follow/a",
      compared: 2,
      same: 1,
      differences: [
        {
          obsId: "obs-2",
          input: { kind: "signal", entity: "binary_sensor.a_motion", state: "on" },
          original: { why: "motion", actions: [{ kind: "call", service: "light.turn_on", entities: ["light.a"] }] },
          twin: { why: "motion", actions: [{ kind: "call", service: "light.turn_off", entities: ["light.a"] }] },
        },
      ],
    });
  });
});

describe("a twin that reads facts", () => {
  // Switches the light with the service its params say when the fact turns true.
  const onBusy = defineHeuristic<{ light: string; service?: string }, Record<string, never>, never>({
    id: "on-busy",
    title: "on-busy",
    description: "",
    watch: () => [],
    facts: () => ["a-busy"],
    actuates: (p) => [p.light],
    initial: () => ({}),
    decide(_s, input, ctx) {
      if (input.kind !== "fact" || ctx.fact("a-busy")?.value !== true) return undefined;
      return { why: "busy", actions: [call(ctx.params.service ?? "light.turn_on", ctx.params.light)] };
    },
    evolve: (s) => s,
  });
  const busy = fact("a-busy", ({ ha }) => ha.binary_sensor.a_motion.is("on"));

  it("reads the same facts as its original, and the two are compared per fact change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-twins-facts-"));
    let motion = "off";
    const actuator = createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } });
    const { runtime, journal } = createSqliteRuntime({ path: join(dir, "journal.db") }, []);
    const instances: InstanceConfig[] = [
      { heuristic: "on-busy", id: "a", mode: "active", params: { light: "light.a" } },
      { heuristic: "on-busy", id: "a-next", mode: "shadow", params: { light: "light.a", service: "light.turn_off" }, twinOf: "on-busy/a" },
    ];
    const host = createHeuristicHost({
      library: [onBusy],
      facts: [busy],
      instances,
      actuator,
      liveState: (id) => (id === "binary_sensor.a_motion" ? { entity_id: id, state: motion, attributes: {}, last_changed: "", last_updated: "" } : undefined),
      scope,
      forceShadow: false,
      log: noLog,
    });
    host.attach(journal);
    closers.push(async () => {
      await host.stop();
      await runtime.shutdown();
      journal.close();
    });
    expect(host.facts()[0]?.readers).toEqual(["on-busy/a", "on-busy/a-next"]);
    await host.start({ subscribeTrigger: async () => async () => {} });
    motion = "on";
    host.onSignal(sig(1));
    const decided = (id: string) => journal.queryEvents({ category: "on-busy", entityId: id, order: "asc", limit: 100 }).filter((r) => r.manifest === "Decided");
    await vi.waitFor(() => expect(decided("a")).toHaveLength(1));
    await vi.waitFor(() => expect(decided("a-next")).toHaveLength(1));
    // Both heard the one FactChanged.
    const cause = decided("a")[0]!.envelope?.causationId;
    expect(decided("a-next")[0]!.envelope?.causationId).toBe(cause);
    const c = compareTwin(journal, "on-busy/a-next", "on-busy/a", { fromMs: Date.now() - 60_000, toMs: Date.now() + 60_000 });
    expect(c).toMatchObject({
      compared: 1,
      same: 0,
      differences: [
        {
          obsId: cause,
          input: { kind: "fact", fact: "a-busy", value: true },
          original: { why: "busy", actions: [{ service: "light.turn_on" }] },
          twin: { why: "busy", actions: [{ service: "light.turn_off" }] },
        },
      ],
    });
  });
});

describe("promoting a twin", () => {
  const HEURISTICS = `{
  "instances": [
    { "heuristic": "follow", "id": "a", "mode": "active", "params": { "sensor": "binary_sensor.a_motion", "light": "light.a" } },
    { "heuristic": "follow", "id": "a-next", "mode": "shadow", "twinOf": "follow/a",
      "params": { "sensor": "binary_sensor.a_motion", "light": "light.a", "service": "light.turn_off" } }
  ]
}
`;

  it("swaps them in heuristics.json's text: the twin under the original's id and mode", () => {
    expect(promoteTwinText(HEURISTICS, "follow/a-next")).toEqual({
      original: "follow/a",
      promoted: "follow/a",
      text: `{
  "instances": [
    { "heuristic": "follow", "id": "a", "mode": "active",
      "params": { "sensor": "binary_sensor.a_motion", "light": "light.a", "service": "light.turn_off" } }
  ]
}
`,
    });
    expect(() => promoteTwinText(HEURISTICS, "follow/a")).toThrow(/follow\/a is not a twin/);
    expect(() => promoteTwinText(HEURISTICS, "follow/z")).toThrow(/no instance follow\/z/);
  });

  it("is one revision, through the API (ingress only), and a rollback undoes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teobeanie-twins-promote-"));
    const config = join(dir, "config");
    mkdirSync(config);
    writeFileSync(join(config, "heuristics.json"), HEURISTICS);
    writeFileSync(join(config, "allowlist.json"), JSON.stringify({ entities: [{ id: "binary_sensor.a_motion" }, { id: "light.a", operate: true }] }));
    const t = setup(loadInstances(config, noLog), dir);
    const record = createConfigJournal(t.runtime);
    const store = createRevisionStore({ dir: join(dir, "revisions"), configDir: config, journal: t.journal });
    await recordBootRevision(store, record);
    const reloader = createReloader({
      apply: () => applyConfig({ configDir: config, extra: [follow], host: t.host, log: noLog }),
      log: noLog,
      configDir: config,
      instances: () => t.host.instances(),
      record,
      revisions: store,
    });
    const app = new Hono();
    mountTwins(app, { mode: "addon", journal: t.journal, instances: () => t.host.instances(), reloader });
    const post = (key: string, ip = "172.30.32.2") =>
      app.request(`/api/twins/${key}/promote`, { method: "POST", headers: { "x-remote-user-display-name": "Alex" } }, { incoming: { socket: { remoteAddress: ip } } });

    expect(await (await app.request("/api/twins/follow/a-next")).json()).toMatchObject({ twin: "follow/a-next", original: "follow/a", compared: 0 });
    expect((await app.request("/api/twins/follow/a")).status).toBe(404);
    expect(await (await app.request("/api/twins")).json()).toMatchObject({ twins: [{ twin: "follow/a-next" }] });
    expect((await post("follow/a-next", "172.30.33.5")).status).toBe(403);
    expect((await post("follow/a")).status).toBe(404);

    const res = await post("follow/a-next");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, journaled: { revision: 2, parent: 1, by: "person:Alex", summary: "promote follow/a-next over follow/a, now follow/a" } });
    expect(t.host.instances().map((i) => [i.key, i.mode, (i.params as { service?: string }).service, i.twinOf])).toEqual([["follow/a", "active", "light.turn_off", undefined]]);
    expect([...t.actuator.owners()]).toEqual([["light.a", "follow/a"]]);

    const undone = await rollback({ store, reloader }, 1, "person:Alex");
    expect(undone.journaled).toMatchObject({ revision: 3, summary: "rollback to 1" });
    expect(readFileSync(join(config, "heuristics.json"), "utf8")).toBe(HEURISTICS);
    expect(t.host.instances().map((i) => [i.key, i.mode, i.twinOf])).toEqual([
      ["follow/a", "active", undefined],
      ["follow/a-next", "shadow", "follow/a"],
    ]);
    // promoteTwin is the same function for an agent's tools.
    expect((await promoteTwin({ reloader }, "follow/a-next", "cli")).journaled).toMatchObject({ revision: 4, by: "cli" });
  });
});
