import { describe, expect, it, vi } from "vitest";
import { EntityId, extractEvents, ulid, type Effect } from "@lambda-house/teob-ts/core";
import { createMockControl } from "@lambda-house/teob-ts/testing";
import { call, defineHeuristic, minutes, notify, setTimer, type Observed } from "../src/kernel/heuristic.js";
import { compileHeuristic, decideStep, type KCommand, type KState } from "../src/kernel/kernel.js";
import { createSafeActuator, type SafeActuator } from "../src/kernel/actuator.js";
import { relayPulse } from "../packages/relay-pulse/relay-pulse.ts";
import { houseScope } from "../src/allowlist.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { houseZone } from "../src/kernel/clock.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";

const obs = (state: string): Observed => ({ value: state === "on" ? true : state === "off" ? false : state, state, since: 0, attributes: {} });

function harness(mode: "shadow" | "active" = "active", world: Record<string, string> = { "switch.r": "on" }) {
  const callService = vi.fn(async () => ({ context: { id: "ctx-1" } }));
  const actuator = createSafeActuator({ ha: { callService } });
  actuator.claim("relay-pulse/garage", ["switch.r"]);
  const compiled = compileHeuristic(relayPulse, {
    instance: (id) => (id === "garage" ? { params: { relays: ["switch.r"], pressMs: 1000, recheckMs: 5000 }, mode } : undefined),
    observe: (e: string) => (world[e] === undefined ? undefined : obs(world[e])),
    actuator,
    log: () => {},
  });
  return { agg: compiled.aggregate, callService };
}

/** Run every Run side effect in an effect chain. */
async function runEffects(effect: Effect<unknown, unknown>): Promise<void> {
  let e: Effect<unknown, unknown> | undefined = effect;
  while (e) {
    if (e.tag === "Run") await e.sideEffect();
    e = "andThen" in e ? e.andThen : undefined;
  }
}

describe("compiled heuristic aggregate", () => {
  it("persists the decision batch, then arms the timer as a side effect", async () => {
    const { agg } = harness();
    const { ctx, record } = createMockControl<KCommand, void>(EntityId("garage"), agg.category);
    const ks = agg.initial(EntityId("garage"));
    const effect = await agg.decide(
      ks,
      { tag: "Input", input: { kind: "signal", at: 1_000, obsId: "obs-1", entity: "switch.r", value: true, state: "on", origin: "ha" } },
      ctx,
    );
    expect(extractEvents(effect).map((e) => e.tag)).toEqual(["Decided", "TimerSet"]);
    expect(record.scheduledTimers).toHaveLength(0); // nothing before persist
    await runEffects(effect as Effect<unknown, unknown>);
    expect(record.scheduledTimers[0]).toMatchObject({ timerId: "release:switch.r", command: { tag: "Fire", timer: "release:switch.r", at: 2_000 } });
  });

  it("re-arms durable timers on recovery and settles actions interrupted by a restart", async () => {
    const { agg } = harness();
    const { ctx, record } = createMockControl<KCommand, void>(EntityId("garage"), agg.category);
    const ks: KState<unknown> = {
      s: {},
      timers: { "release:switch.r": { at: Date.now() + minutes(1), eid: "e1", data: "switch.r" } },
      pending: { a1: { action: call("switch.turn_off", "switch.r") } },
    };
    await agg.onRecoveryComplete!(ks, ctx);
    expect(record.scheduledTimers.map((t) => t.timerId)).toEqual(["release:switch.r"]);
    expect(record.selfCommands).toEqual([expect.objectContaining({ tag: "Interrupted", actionId: "a1" })]);
    // The call is settled, never re-fired.
    const settled = await agg.decide(ks, record.selfCommands[0] as KCommand, ctx);
    expect(extractEvents(settled)).toEqual([expect.objectContaining({ tag: "ActionCompleted", actionId: "a1", ok: false, error: "interrupted by restart" })]);
  });

  it("ignores a stale timer firing (re-set or cancelled since)", async () => {
    const { agg } = harness();
    const { ctx } = createMockControl<KCommand, void>(EntityId("garage"), agg.category);
    const ks: KState<unknown> = { s: {}, timers: { "release:switch.r": { at: 5_000, eid: "e1", data: "switch.r" } }, pending: {} };
    const effect = await agg.decide(ks, { tag: "Fire", timer: "release:switch.r", at: 2_000 }, ctx);
    expect(effect.tag).toBe("Done");
  });

  it("active mode calls HA and feeds the outcome back with the HA context id", async () => {
    const { agg, callService } = harness("active");
    const { ctx, record } = createMockControl<KCommand, void>(EntityId("garage"), agg.category);
    const ks: KState<unknown> = { s: {}, timers: { "release:switch.r": { at: 2_000, eid: "e1", data: "switch.r" } }, pending: {} };
    const effect = await agg.decide(ks, { tag: "Fire", timer: "release:switch.r", at: 2_000 }, ctx);
    expect(extractEvents(effect).map((e) => e.tag)).toEqual(["Decided", "Released", "TimerSet", "ActionRequested"]);
    await runEffects(effect as Effect<unknown, unknown>);
    await vi.waitFor(() => expect(record.selfCommands).toHaveLength(1));
    expect(callService).toHaveBeenCalledWith({ domain: "switch", service: "turn_off", target: { entity_id: ["switch.r"] } });
    expect(record.selfCommands[0]).toMatchObject({ tag: "Outcome", ok: true, haContextId: "ctx-1" });
    // The journaled outcome keeps the context id: it is how Teobeanie's own calls are told apart from other add-ons calling HA as the same user.
    const requested = extractEvents(effect).find((e) => e.tag === "ActionRequested") as { actionId: string; action: unknown };
    const after: KState<unknown> = { ...ks, pending: { [requested.actionId]: { action: requested.action } } as KState<unknown>["pending"] };
    const done = await agg.decide(after, record.selfCommands[0] as KCommand, ctx);
    expect(extractEvents(done)[0]).toMatchObject({ tag: "ActionCompleted", ok: true, haContextId: "ctx-1" });
  });

  it("shadow mode never calls HA", async () => {
    const { agg, callService } = harness("shadow");
    const { ctx } = createMockControl<KCommand, void>(EntityId("garage"), agg.category);
    const ks: KState<unknown> = { s: {}, timers: { "release:switch.r": { at: 2_000, eid: "e1", data: "switch.r" } }, pending: {} };
    const effect = await agg.decide(ks, { tag: "Fire", timer: "release:switch.r", at: 2_000 }, ctx);
    expect(extractEvents(effect).map((e) => e.tag)).toContain("ActionSuppressed");
    await runEffects(effect as Effect<unknown, unknown>);
    expect(callService).not.toHaveBeenCalled();
  });
});

describe("decideStep", () => {
  const boom = defineHeuristic<unknown, object, { tag: string }>({
    id: "boom",
    title: "boom",
    description: "",
    watch: () => ["sensor.x"],
    actuates: () => [],
    initial: () => ({}),
    decide: () => {
      throw new Error("bug in decide");
    },
    evolve: (s) => s,
  });

  it("journals a throwing decide as DecideFailed instead of crashing the entity", () => {
    const ks: KState<object> = { s: {}, timers: {}, pending: {} };
    const step = decideStep(boom, {}, "i", ks, { kind: "start", at: 0 }, () => undefined, { mode: "active", vet: () => ({ ok: true }) }, ulid);
    expect(step.events.map((e) => e.event)).toEqual([{ tag: "DecideFailed", input: { kind: "start" }, error: "bug in decide" }]);
  });

  it("a reply to a command and a report (info) are sent without the instance, so never to the alerts chat", async () => {
    const asker = defineHeuristic<unknown, object, { tag: string }>({
      id: "asker",
      initial: () => ({}),
      decide: (_s, input) => ({ why: "told", actions: input.kind === "command" ? [notify("Marked")] : [notify("Noticed"), notify("Reported", { info: true })] }),
      evolve: (s) => s,
    });
    const ks: KState<object> = { s: {}, timers: {}, pending: {} };
    const gate = { mode: "active" as const, vet: () => ({ ok: true as const }) };
    const command = decideStep(asker, {}, "asker/i", ks, { kind: "command", at: 0, command: "mark", args: [], from: { channel: "telegram", user: "alex" } }, () => undefined, gate, ulid);
    const signal = decideStep(asker, {}, "asker/i", ks, { kind: "start", at: 0 }, () => undefined, gate, ulid);
    expect(command.fire.map((f) => f.action)).toEqual([{ kind: "notify", channel: "telegram", text: "Marked", reply: true }]);
    expect(signal.fire.map((f) => f.action)).toEqual([
      { kind: "notify", channel: "telegram", text: "Noticed" },
      { kind: "notify", channel: "telegram", text: "Reported", info: true },
    ]);

    const sent: Array<[string, string | undefined]> = [];
    const actuator = createSafeActuator({ ha: { callService: vi.fn() }, notifier: { send: async (text, from) => void sent.push([text, from]) } });
    for (const f of [...command.fire, ...signal.fire]) await actuator.execute(f.action, "asker/i");
    expect(sent).toEqual([["Marked", undefined], ["Noticed", "asker/i"], ["Reported", undefined]]);
  });

  it("refuses reserved kernel tags as domain events", () => {
    const sneaky = { ...boom, decide: () => ({ events: [{ tag: "ActionCompleted" }] }) };
    const ks: KState<object> = { s: {}, timers: {}, pending: {} };
    expect(() => decideStep(sneaky, {}, "i", ks, { kind: "start", at: 0 }, () => undefined, { mode: "active", vet: () => ({ ok: true }) }, ulid)).toThrow(/reserved/);
  });

  it("causation: TimerSet → Decided(timer) chains back to the setting decision", () => {
    const h = defineHeuristic<unknown, object, { tag: string }>({
      ...boom,
      decide: (_s, input, ctx) => (input.kind === "start" ? { timers: [setTimer("t", ctx.now + 10)] } : { why: "fired" }),
    });
    const ks0: KState<object> = { s: {}, timers: {}, pending: {} };
    let n = 0;
    const id = () => `id${++n}`;
    const gate = { mode: "active" as const, vet: () => ({ ok: true as const }) };
    const s1 = decideStep(h, {}, "i", ks0, { kind: "start", at: 0 }, () => undefined, gate, id);
    const timerSet = s1.events.find((e) => e.event.tag === "TimerSet")!;
    const ks1: KState<object> = { ...ks0, timers: { t: { at: 10, eid: timerSet.eventId } } };
    const s2 = decideStep(h, {}, "i", ks1, { kind: "timer", at: 10, timer: "t" }, () => undefined, gate, id);
    expect(s2.events[0]).toMatchObject({ event: { tag: "Decided", why: "fired" }, causationId: timerSet.eventId });
    expect(timerSet.causationId).toBe(s1.events[0]!.eventId);
  });
});

describe("SafeActuator.vet", () => {
  const act = () => {
    const a = createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } });
    a.claim("h/a", ["light.a", "switch.water_valve", "climate.x"]);
    a.claim("h/b", ["light.b"]);
    a.forbid("switch.water_valve", "switch.turn_on", "reopening the water valve is human-only");
    return a;
  };

  it("enforces ownership", () => {
    expect(act().vet("h/a", call("light.turn_on", "light.b"), 0, 10)).toEqual({ ok: false, reason: "light.b is owned by h/b" });
    expect(act().vet("h/a", call("light.turn_on", "light.c"), 0, 10)).toMatchObject({ ok: false });
    expect(() => act().claim("h/b", ["light.a"])).toThrow(/claimed by both/);
  });

  it("bans toggle, bounds setpoints, and never reopens the water valve", () => {
    const a = act();
    expect(a.vet("h/a", call("light.toggle", "light.a"), 0, 10)).toMatchObject({ ok: false });
    expect(a.vet("h/a", call("climate.set_temperature", "climate.x", { temperature: 30 }), 0, 10)).toMatchObject({ ok: false });
    expect(a.vet("h/a", call("climate.set_temperature", "climate.x", { temperature: 21 }), 0, 10)).toEqual({ ok: true });
    expect(a.vet("h/a", call("switch.turn_on", "switch.water_valve"), 0, 10)).toMatchObject({ ok: false });
    expect(a.vet("h/a", call("switch.turn_off", "switch.water_valve"), 0, 10)).toEqual({ ok: true });
  });

  it("never calls outside the house's operation scope, whoever claims the entity", () => {
    const a = createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) }, scope: houseScope(["light.b"], ["light.a"]) });
    a.claim("h/a", ["light.a", "light.b"]);
    expect(a.vet("h/a", call("light.turn_on", "light.a"), 0, 10)).toEqual({ ok: true });
    expect(a.vet("h/a", call("light.turn_on", "light.b"), 0, 10)).toEqual({ ok: false, reason: "light.b is outside the house's operation scope" });
    expect(a.vet("h/a", call("light.turn_on", ["light.a", "camera.c"]), 0, 10)).toMatchObject({ ok: false });
  });

  it("rate-limits per entity per hour and honours pause", () => {
    const a = createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) }, policy: { callsPerEntityPerHour: 2 } });
    a.claim("h/a", ["light.a"]);
    const on = call("light.turn_on", "light.a");
    expect([0, 1, 2].map((t) => a.vet("h/a", on, t, 10).ok)).toEqual([true, true, false]);
    expect(a.vet("h/a", on, 3_600_001, 10).ok).toBe(true);
    a.setPaused(true);
    expect(a.vet("h/a", on, 7_200_002, 10)).toEqual({ ok: false, reason: "all heuristics paused" });
  });
});

describe("the notification cap per hour", () => {
  const noisy = (notifyPerHour?: number) =>
    defineHeuristic<unknown, object, { tag: string }>({
      id: "noisy",
      title: "noisy",
      description: "",
      watch: () => ["sensor.x"],
      actuates: () => [],
      ...(notifyPerHour !== undefined ? { notifyPerHour } : {}),
      initial: () => ({}),
      decide: () => ({ actions: [notify("hi")] }),
      evolve: (s) => s,
    });
  /** The cap the aggregate hands the actuator for one decision. */
  async function capSeen(def: ReturnType<typeof noisy>, own?: number): Promise<number | undefined> {
    const vet = vi.fn((): { ok: true } => ({ ok: true }));
    const compiled = compileHeuristic(def, {
      instance: () => ({ params: {}, mode: "active", ...(own !== undefined ? { notifyPerHour: own } : {}) }),
      observe: () => undefined,
      actuator: { vet } as unknown as SafeActuator,
      log: () => {},
    });
    const { ctx } = createMockControl<KCommand, void>(EntityId("i"), compiled.aggregate.category);
    const input = { kind: "signal" as const, at: 1_000, obsId: "o1", entity: "sensor.x", value: true, state: "on", origin: "ha" as const };
    await compiled.aggregate.decide(compiled.aggregate.initial(EntityId("i")), { tag: "Input", input }, ctx);
    return (vet.mock.calls[0] as unknown[] | undefined)?.[3] as number | undefined;
  }

  it("is the instance's when it sets one, else the heuristic's, else 12", async () => {
    expect(await capSeen(noisy(), 3)).toBe(3);
    expect(await capSeen(noisy(30), 3)).toBe(3);
    expect(await capSeen(noisy(30))).toBe(30);
    expect(await capSeen(noisy())).toBe(12);
  });

  it("is checked in heuristics.json: a positive whole number, shown in the instance list", () => {
    const logs: string[] = [];
    const base = (n: string) => ({ heuristic: "relay-pulse", params: { relays: [`switch.${n}`], pressMs: 1000, recheckMs: 5000 } });
    const host = createHeuristicHost({
      library: [relayPulse],
      instances: [
        { ...base("plain"), id: "plain" },
        { ...base("capped"), id: "capped", notifyPerHour: 5 },
        { ...base("zero"), id: "zero", notifyPerHour: 0 },
        { ...base("text"), id: "text", notifyPerHour: "many" as unknown as number },
      ],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } }),
      liveState: () => undefined,
      forceShadow: false,
      log: (_l, m) => logs.push(m),
    });
    expect(host.instances().map((i) => [i.id, i.notifyPerHour])).toEqual([["plain", 12], ["capped", 5]]);
    expect(logs.join("\n")).toMatch(/relay-pulse\/zero: notifyPerHour must be a positive whole number, got 0/);
    expect(logs.join("\n")).toMatch(/relay-pulse\/text: notifyPerHour must be a positive whole number, got "many"/);
  });
});

describe("heuristic host and the house scope", () => {
  it("does not start an instance that watches or owns anything outside the scope", () => {
    const logs: string[] = [];
    const host = createHeuristicHost({
      library: [relayPulse],
      instances: [
        { heuristic: "relay-pulse", id: "in", params: { relays: ["switch.in"], pressMs: 1000, recheckMs: 5000 } },
        { heuristic: "relay-pulse", id: "seen-only", params: { relays: ["switch.seen"], pressMs: 1000, recheckMs: 5000 } },
        { heuristic: "relay-pulse", id: "unknown", params: { relays: ["switch.printer"], pressMs: 1000, recheckMs: 5000 } },
      ],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } }),
      liveState: () => undefined,
      scope: houseScope(["switch.seen"], ["switch.in"]),
      forceShadow: false,
      log: (_l, m) => logs.push(m),
    });
    expect(host.instances().map((i) => i.id)).toEqual(["in"]);
    expect(logs.join("\n")).toMatch(/relay-pulse\/seen-only is outside the house scope .* not "operate": switch\.seen/);
    expect(logs.join("\n")).toMatch(/relay-pulse\/unknown is outside the house scope .* not listed: switch\.printer;/);
  });
});

describe("heuristic host and the house's time zone", () => {
  it("decisions see the zone HA last gave, UTC before it has", async () => {
    const zoneProbe = defineHeuristic<Record<string, never>, Record<string, never>, never>({
      id: "zone-probe",
      title: "zone probe",
      description: "",
      watch: () => [],
      actuates: () => [],
      commands: () => ["zone"],
      initial: () => ({}),
      decide: (_s, input, ctx) => (input.kind === "start" || input.kind === "command" ? { why: `in ${houseZone(ctx.house)}` } : undefined),
      evolve: (s) => s,
    });
    let zone: string | undefined;
    const host = createHeuristicHost({
      library: [zoneProbe],
      instances: [{ heuristic: "zone-probe", id: "main", mode: "shadow", params: {} }],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } }),
      liveState: () => undefined,
      forceShadow: false,
      log: () => {},
      timeZone: () => zone,
    });
    const journal = createSqliteJournal({ path: join(mkdtempSync(join(tmpdir(), "teobeanie-zone-")), "journal.db") });
    host.attach(journal);
    const whys = () =>
      journal
        .queryEvents({ category: "zone-probe", limit: 100 })
        .filter((r) => r.manifest === "Decided")
        .map((r) => (r.payload as { why?: string }).why);
    await host.start({ subscribeTrigger: async () => async () => {} });
    await vi.waitFor(() => expect(whys()).toEqual(["in UTC"]));
    zone = "America/New_York";
    host.command("zone", [], { channel: "test" });
    await vi.waitFor(() => expect(whys().sort()).toEqual(["in America/New_York", "in UTC"]));
    await host.stop();
    journal.close();
  });
});
