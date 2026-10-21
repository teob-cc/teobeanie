// Facts (fact.ts): derived state with a value and a since, read by rules and deciders,
// on the simulator and planned as the host plans them.

import { describe, expect, it } from "vitest";
import { defineHeuristic, minutes, notify } from "../src/kernel/heuristic.js";
import { simulate } from "../src/kernel/simulate.js";
import { keep, rule } from "../src/kernel/rule.js";
import { camelOf, fact, factNames, planFacts, snakeOf } from "../src/kernel/fact.js";

const nobodyNear = fact("nobody-near-garage", ({ ha, held }) => held(() => ha.binary_sensor.garage_occupancy.is("off"), minutes(10)), {
  title: "Nobody near the garage",
});

const facts = (journal: Array<{ event: { tag: string } }>) => journal.filter((j) => j.event.tag === "FactChanged").map((j) => j.event as unknown as { value: unknown; since: number; input: unknown });

describe("fact()", () => {
  it("finds what it reads from its source and a first evaluation", () => {
    expect(nobodyNear.watch()).toEqual(["binary_sensor.garage_occupancy"]);
    expect(nobodyNear.facts()).toEqual([]);
    const both = fact("both", ({ ha }) => ha.facts.nobodyNearGarage.value === true && ha.facts["other-fact"].is(true));
    expect(both.facts()).toEqual(["nobodyNearGarage", "other-fact"]);
    expect(both.watch()).toEqual([]);
  });

  it("has a value and a since, journaled only when the value changes", () => {
    const sim = simulate(nobodyNear, undefined, { "binary_sensor.garage_occupancy": "on" });
    const t0 = sim.now;
    expect(sim.fact("nobody-near-garage")).toEqual({ value: false, since: t0 });
    sim.set("binary_sensor.garage_occupancy", "off").advance(minutes(5)).set("binary_sensor.garage_occupancy", "on");
    sim.set("binary_sensor.garage_occupancy", "off").advance(minutes(9));
    expect(sim.fact("nobody-near-garage")?.value).toBe(false);
    const off = sim.now - minutes(9);
    sim.advance(minutes(1));
    expect(sim.fact("nobodyNearGarage")).toEqual({ value: true, since: off + minutes(10) });
    expect(sim.fact("nobody_near_garage")?.value).toBe(true);
    sim.set("binary_sensor.garage_occupancy", "on");
    expect(facts(sim.journal).map((e) => [e.value, e.input])).toEqual([
      [false, { kind: "start" }],
      [true, { kind: "time" }],
      [false, { kind: "signal", entity: "binary_sensor.garage_occupancy" }],
    ]);
    const changed = sim.journal.find((j) => j.event.tag === "FactChanged" && (j.event as { value?: unknown }).value === true)!.event;
    expect(changed).toMatchObject({ fact: "nobody-near-garage", inputs: { "binary_sensor.garage_occupancy": false }, why: "garage_occupancy is off for 10 min" });
  });

  it("reads other facts, and is re-evaluated when one changes", () => {
    const quiet = fact("garage-quiet", ({ ha, between }) => ha.facts.nobodyNearGarage.is(true) && !between("07:00", "08:00"), { title: "Garage quiet" });
    const sim = simulate(quiet, undefined, { "binary_sensor.garage_occupancy": "off" }, { facts: [nobodyNear] });
    expect(sim.fact("garage-quiet")?.value).toBe(false);
    sim.advance(minutes(10));
    expect(sim.fact("garage-quiet")).toEqual({ value: true, since: sim.now });
    const last = sim.journal.at(-1)!.event;
    expect(last).toMatchObject({ tag: "FactChanged", fact: "garage-quiet", input: { kind: "fact", fact: "nobody-near-garage" }, inputs: { "fact:nobody-near-garage": true } });
  });
});

describe("rules and deciders read facts", () => {
  it("a rule reads ha.facts.<name> and re-evaluates when the fact changes", () => {
    const garageLight = rule("garage-light-off", ({ ha }) => ha.light.garage.to(ha.facts.nobodyNearGarage.is(true) ? "off" : keep));
    expect(garageLight.facts?.(undefined)).toEqual(["nobodyNearGarage"]);
    expect(garageLight.watch(undefined)).toEqual([]);
    const sim = simulate(garageLight, undefined, { "binary_sensor.garage_occupancy": "off", "light.garage": "on" }, { facts: [nobodyNear] }).start();
    expect(sim.calls()).toEqual([]);
    sim.advance(minutes(10));
    expect(sim.calls()).toEqual(["light.turn_off light.garage"]);
    expect(sim.whys().at(-1)).toBe("garage → off · nobody-near-garage is true");
    const decided = sim.journal.filter((j) => j.event.tag === "Decided").at(-1)!.event;
    expect(decided).toMatchObject({ input: { kind: "fact", fact: "nobody-near-garage", value: true }, facts: { nobodyNearGarage: true } });
  });

  it("a decider declares the facts it reads, gets a fact input on each change and reads ctx.fact", () => {
    const tell = defineHeuristic<{ fact: string }, Record<string, never>, never>({
      id: "tell",
      title: "Tell",
      description: "",
      watch: () => [],
      facts: (p) => [p.fact],
      actuates: () => [],
      initial: () => ({}),
      decide(_s, input, ctx) {
        if (input.kind !== "fact") return undefined;
        const f = ctx.fact(input.fact);
        return { why: `${input.fact} now ${String(f?.value)}`, actions: [notify(`${input.fact}: ${String(input.value)} since ${input.since}`)] };
      },
      evolve: (s) => s,
    });
    const sim = simulate(tell, { fact: "nobody-near-garage" }, { "binary_sensor.garage_occupancy": "off" }, { facts: [nobodyNear] });
    sim.advance(minutes(10));
    expect(sim.calls()).toEqual([`notify: nobody-near-garage: true since ${sim.now}`]);
    expect(() => simulate(tell, { fact: "missing" }, {}, { facts: [nobodyNear] })).toThrow(/reads fact missing/);
  });
});

describe("planFacts()", () => {
  const a = fact("a", ({ ha }) => ha.facts.b.value);
  const b = fact("b", ({ ha }) => ha.facts.a.value);
  const c = fact("c", ({ ha }) => ha.facts.b.value);
  const ok = fact("ok", ({ ha }) => ha.binary_sensor.x.is("on"));

  it("refuses a cycle, and what reads it", () => {
    const p = planFacts([a, b, c, ok]);
    expect(p.facts.map((f) => f.id)).toEqual(["ok"]);
    expect(p.problems).toEqual(expect.arrayContaining(["fact a reads facts in a cycle: a → b → a", "fact b reads facts in a cycle: b → a → b"]));
    expect(p.problems.some((x) => x.startsWith("fact c "))).toBe(true);
    expect(() => simulate(a, undefined, {}, { facts: [b] })).toThrow(/cycle/);
  });

  it("refuses a fact read that no fact defines, a name two facts share, and an entity outside the scope", () => {
    const reads = fact("reads", ({ ha }) => ha.facts.nothere.value);
    const twin1 = fact("room-2-motion", () => 1);
    const twin2 = fact("room2-motion", () => 2);
    const p = planFacts([reads, twin1, twin2, ok], { observes: (e) => e !== "binary_sensor.x" });
    expect(p.facts.map((f) => f.id)).toEqual(["room-2-motion"]);
    expect(p.problems).toEqual([
      "fact room2-motion: reads as ha.facts.room2Motion, as fact room-2-motion does",
      "fact reads reads ha.facts.nothere, which no fact defines",
      "fact ok is outside the house scope (allowlist.json): not listed: binary_sensor.x",
    ]);
  });

  it("orders a fact after the facts it reads, and knows each by its names", () => {
    const first = fact("first-one", ({ ha }) => ha.binary_sensor.x.is("on"));
    const second = fact("second", ({ ha }) => ha.facts.first_one.value);
    const p = planFacts([second, first]);
    expect(p.facts.map((f) => f.id)).toEqual(["first-one", "second"]);
    expect(p.aliases.get("firstOne")).toBe("first-one");
    expect(p.dependents.get("first-one")).toEqual(["second"]);
    expect([camelOf("nobody-near-2"), snakeOf("nobody-near-2"), factNames("x")]).toEqual(["nobodyNear2", "nobody_near_2", ["x"]]);
  });
});
