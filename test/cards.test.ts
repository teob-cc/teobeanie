// Cards: what an instance shows on the House page (HeuristicDef.view). The kernel
// checks a card's buttons, the host serves every running instance's card, the House
// service pushes them when they change, and the panel renders any card the same way.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import type { HaEntityState, HaStateChangedEvent } from "@lambda-house/teob-ts/ha";
import { defineHeuristic, minutes, type Card, type Observed } from "../src/kernel/heuristic.js";
import { instanceCard } from "../src/kernel/card.js";
import { simulate } from "../src/kernel/simulate.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import { rule } from "../src/kernel/rule.js";
import { createHouseService } from "../src/house/service.js";
import type { HouseFrame, InstanceCard } from "../src/house/view.js";
import { cardModel, valueText } from "../panel/src/cards.js";

/** A counter with a card: its count, a button per command, one it does not answer to. */
const counter = defineHeuristic<{ door: string; command: string; card?: Card | "throw" }, { n: number }, { tag: "Counted" }>({
  id: "counter",
  title: "Counter",
  description: "Counts its command.",
  watch: (p) => [p.door],
  actuates: () => [],
  commands: (p) => [p.command],
  initial: () => ({ n: 0 }),
  view(state, ctx) {
    if (ctx.params.card === "throw") throw new Error("no card today");
    return (
      ctx.params.card ?? {
        title: "Counter",
        fields: [
          { label: "Count", value: state.n },
          { label: "Door", value: ctx.get(ctx.params.door)?.state ?? null },
          { label: "Elsewhere", value: ctx.get("sensor.not_declared")?.state ?? null },
        ],
        buttons: [{ label: "Count", command: ctx.params.command }],
      }
    );
  },
  decide: (_s, input) => (input.kind === "command" ? { why: "counted", events: [{ tag: "Counted" }] } : undefined),
  evolve: (s) => ({ n: s.n + 1 }),
});

const obs = (state: string, since = 1000): Observed => ({ value: state === "on" ? true : state === "off" ? false : state, state, since, attributes: {} });
const inst = { key: "counter/a", id: "a", mode: "active" as const, entities: ["binary_sensor.door"], commands: ["count"] };

describe("instanceCard", () => {
  it("view() over the state, its params and only the entities it declares", () => {
    const params = { door: "binary_sensor.door", command: "count" };
    const c = instanceCard(counter, { ...inst, params }, { n: 2 }, (e) => obs(e === "binary_sensor.door" ? "on" : "x"));
    expect(c).toEqual({
      key: "counter/a",
      heuristic: "counter",
      id: "a",
      mode: "active",
      card: {
        title: "Counter",
        fields: [
          { label: "Count", value: 2 },
          { label: "Door", value: "on" },
          { label: "Elsewhere", value: null },
        ],
        buttons: [{ label: "Count", command: "count" }],
      },
    });
    // No state yet: the initial one.
    expect(instanceCard(counter, { ...inst, params }, undefined, () => undefined).card?.fields[0]).toEqual({ label: "Count", value: 0 });
  });

  it("a button for a command it does not answer to, or with unfit arguments, is left out and said", () => {
    const card: Card = {
      title: "T",
      fields: [],
      buttons: [
        { label: "Mine", command: "COUNT", args: ["x"] },
        { label: "Theirs", command: "garage_open" },
        { label: "Long", command: "count", args: ["x".repeat(65)] },
        { label: "Empty", command: "count", args: [""] },
      ],
    };
    const c = instanceCard(counter, { ...inst, params: { door: "binary_sensor.door", command: "count", card } }, undefined, () => undefined);
    expect(c.card?.buttons).toEqual([{ label: "Mine", command: "COUNT", args: ["x"] }]);
    expect(c.error).toBe(
      'button "Theirs" left out: /garage_open is not one of its commands; button "Long" left out: /count: at most 8 arguments of 1 to 64 characters; button "Empty" left out: /count: at most 8 arguments of 1 to 64 characters',
    );
  });

  it("a view that throws is an error on the card, not a crash; none is no card", () => {
    expect(instanceCard(counter, { ...inst, params: { door: "d", command: "count", card: "throw" } }, undefined, () => undefined)).toEqual({
      key: "counter/a",
      heuristic: "counter",
      id: "a",
      mode: "active",
      error: "view: no card today",
    });
    const { view: _, ...noView } = counter;
    expect(instanceCard(noView, { ...inst, params: {} }, undefined, () => undefined).card).toBeUndefined();
  });

  it("a rule's view sees what it wants, by entity", () => {
    const r = rule<void>("porch", ({ ha }) => ha.light.porch.to(ha.binary_sensor.dark.is("on") ? "on" : "off"), {
      view: (s) => ({ title: "Porch", fields: [{ label: "Wants", value: String(s.desired["light.porch"] ?? "nothing yet") }] }),
    });
    const sim = simulate(r, undefined, { "binary_sensor.dark": "on", "light.porch": "off" }).start();
    expect(sim.card().card?.fields).toEqual([{ label: "Wants", value: "on" }]);
  });
});

describe("the host's cards", () => {
  it("every active and shadow instance with a view; a card change is told", async () => {
    const changed = vi.fn();
    const host = createHeuristicHost({
      library: [counter],
      instances: [
        { heuristic: "counter", id: "a", mode: "active", params: { door: "binary_sensor.door", command: "count" } },
        { heuristic: "counter", id: "b", mode: "shadow", params: { door: "binary_sensor.door", command: "tally" } },
        { heuristic: "counter", id: "c", mode: "off", params: { door: "binary_sensor.door", command: "other" } },
      ],
      actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } }),
      liveState: (id): HaEntityState | undefined => (id === "binary_sensor.door" ? { entity_id: id, state: "on", attributes: {}, last_changed: "2026-01-01T10:00:00Z", last_updated: "2026-01-01T10:00:00Z" } : undefined),
      forceShadow: false,
      log: () => {},
      onCardChange: changed,
    });
    expect(host.cards().map((c) => [c.key, c.mode, c.card?.fields[0]?.value, c.card?.fields[1]?.value])).toEqual([
      ["counter/a", "active", 0, "on"],
      ["counter/b", "shadow", 0, "on"],
    ]);
    const journal = createSqliteJournal({ path: join(mkdtempSync(join(tmpdir(), "teobeanie-cards-")), "journal.db") });
    host.attach(journal);
    await host.start({ subscribeTrigger: async () => async () => {} });
    host.command("count", [], { channel: "panel", user: "alex" });
    await vi.waitFor(() => expect(host.cards()[0]?.card?.fields[0]?.value).toBe(1));
    expect(changed).toHaveBeenCalled();
    await host.stop();
    journal.close();
  });
});

describe("the House service's cards", () => {
  const ha = () => {
    let handler: ((e: HaStateChangedEvent) => void) | undefined;
    return {
      client: {
        send: async <T>(): Promise<T> => {
          throw new Error("offline");
        },
        onStateChanged: (h: (e: HaStateChangedEvent) => void) => {
          handler = h;
          return () => (handler = undefined);
        },
        statisticsDuringPeriod: async () => ({}),
      },
      fire: (e: HaStateChangedEvent) => handler?.(e),
    };
  };

  it("GET api/house carries them; a frame carries them again only when one changed", async () => {
    vi.useFakeTimers();
    try {
      let cards: InstanceCard[] = [{ key: "counter/a", heuristic: "counter", id: "a", mode: "active", card: { title: "Counter", fields: [{ label: "Count", value: 0 }] } }];
      const frames: HouseFrame[] = [];
      const { client } = ha();
      const svc = createHouseService({ ha: client, live: () => new Map(), groups: {}, tiles: [], cards: () => cards, publish: (f) => frames.push(f), listening: () => true, log: () => {} });
      expect((await svc.view()).cards).toEqual(cards);
      svc.cardsChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames).toEqual([{ type: "house", at: expect.any(Number), states: {}, cards }]);
      // Told again with nothing different: no frame.
      svc.cardsChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames).toHaveLength(1);
      cards = [{ ...cards[0]!, card: { title: "Counter", fields: [{ label: "Count", value: 1 }] } }];
      svc.cardsChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(frames.at(-1)?.cards).toEqual(cards);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a card on the House page", () => {
  const now = Date.UTC(2026, 0, 5, 12, 0, 0);
  it("any card the same way: mode chip, values with unit and how long, tones, buttons", () => {
    const m = cardModel(
      {
        key: "tank/garden",
        heuristic: "tank",
        id: "garden",
        mode: "shadow",
        card: {
          title: "Rain tank",
          fields: [
            { label: "Level", value: 72.456, unit: "%", tone: "ok" },
            { label: "Pump", value: true, since: now - minutes(12) },
            { label: "Last fill", value: null },
          ],
          buttons: [{ label: "Pump now", command: "tank_pump", args: ["garden"], confirm: "Run the pump?" }, { label: "Stop", command: "tank_stop", disabled: true }],
        },
        error: 'button "x" left out: /y is not one of its commands',
      },
      now,
    );
    expect(m).toMatchObject({
      key: "tank/garden",
      title: "Rain tank",
      mode: { text: "shadow", className: "chip chip-off" },
      fields: [
        { label: "Level", text: "72.5", unit: "%", className: "stat-value ok-text" },
        { label: "Pump", text: "yes", sub: "for 12m", className: "stat-value" },
        { label: "Last fill", text: "—", className: "stat-value" },
      ],
      buttons: [
        { label: "Pump now", command: "tank_pump", args: ["garden"], confirm: "Run the pump?", disabled: false },
        { label: "Stop", command: "tank_stop", args: [], disabled: true },
      ],
      error: 'button "x" left out: /y is not one of its commands',
    });
    expect(m.fields[0]?.sub).toBeUndefined();
    expect(m.fields[1]?.subTitle).toMatch(/^since /);
  });

  it("a card that failed: its key, the active chip and why", () => {
    expect(cardModel({ key: "counter/a", heuristic: "counter", id: "a", mode: "active", error: "view: no card today" }, now)).toEqual({
      key: "counter/a",
      title: "counter/a",
      mode: { text: "active", className: "chip chip-ok", title: "It acts" },
      fields: [],
      buttons: [],
      error: "view: no card today",
    });
    expect([valueText(0), valueText(false), valueText("open")]).toEqual(["0", "no", "open"]);
  });
});
