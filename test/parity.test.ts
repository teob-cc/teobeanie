// Shadow parity: matching Teobeanie's calls against the calls others made, and classifying
// those that have no Teobeanie call within the match window.

import { describe, expect, it } from "vitest";
import type { JournalRow } from "../panel/src/api.js";
import { classifyMiss, fmtDelta, foldDecisions, type Decision, type ObservedCall } from "../panel/src/decisions.js";
import { originChip, originLabel, originOf } from "../panel/src/origin.js";

const T = 1_000_000_000;
const nr = (service: string, at = T): ObservedCall => ({ at, domain: "switch", service, entityIds: ["switch.pump", "switch.unowned"], deviceIds: [], by: "nodered" });
const owned = new Set(["switch.pump"]);
const decision = (at: number, service: string): Decision =>
  ({
    eventId: `d${at}`, key: "follow/pump", at, input: { kind: "signal" }, why: "", events: [], timers: [],
    actions: [{ actionId: "a", disposition: "requested", action: { kind: "call", service, entities: ["switch.pump"] } }],
  }) as unknown as Decision;

describe("classifyMiss", () => {
  it("a turn_off to a device already off is a no-op re-send", () => {
    const history = { "switch.pump": [{ at: T - 3600e3, value: false }] };
    expect(classifyMiss(nr("turn_off"), owned, [], history)).toEqual({ kind: "no-op", value: false });
  });

  it("the state change the call itself causes does not count", () => {
    const history = { "switch.pump": [{ at: T - 60e3, value: true }, { at: T + 400, value: false }] };
    expect(classifyMiss(nr("turn_off"), owned, [], history).kind).toBe("unexplained");
  });

  it("without recorded history the call is not assumed to be a no-op", () => {
    expect(classifyMiss(nr("turn_off"), owned, [], {}).kind).toBe("unexplained");
  });

  it("the same Teobeanie call at another time is a timing difference, nearest wins", () => {
    const ds = [decision(T + 600e3, "switch.turn_off"), decision(T + 151e3, "switch.turn_off"), decision(T + 5e3, "switch.turn_on")];
    expect(classifyMiss(nr("turn_off"), owned, ds, {})).toEqual({ kind: "timing", deltaMs: 151e3, key: "follow/pump" });
  });

  it("a Teobeanie call further away than 30 min does not explain it", () => {
    expect(classifyMiss(nr("turn_off"), owned, [decision(T - 31 * 60e3, "switch.turn_off")], {}).kind).toBe("unexplained");
  });
});

describe("foldDecisions with attributed calls", () => {
  let seq = 0;
  const row = (category: string, manifest: string, payload: Record<string, unknown>, envelope: Record<string, unknown> = {}, origin?: string): JournalRow => ({
    globalSeq: ++seq,
    category,
    entityId: category === "ha-audit" ? "nodered" : "hall",
    sequenceNr: seq,
    manifest,
    payload: { tag: manifest, ...payload },
    ts: Math.floor(T / 1000),
    envelope: { eventId: `e${seq}`, v: 1, ...(origin !== undefined ? { origin } : {}), ...envelope } as JournalRow["envelope"],
  });
  // Envelope origin as the journal has it: the row's `by`, "nodered" on old rows.
  const audit = (at: number, extra: { by?: string }) =>
    row("ha-audit", "HaCallServiceObserved", { domain: "light", service: "turn_on", entityIds: ["light.hall_upper"], at, ...extra }, {}, extra.by ?? "nodered");
  const rows = (...calls: JournalRow[]): JournalRow[] => [
    row("follow", "Decided", { why: "motion", input: { kind: "signal" } }, { eventId: "d1" }),
    row("follow", "ActionRequested", { actionId: "a1", action: { kind: "call", service: "light.turn_on", entities: ["light.hall_upper"] } }, { eventId: "a1", causationId: "d1" }),
    ...calls,
  ];

  it("teob's own audited call is neither another's call nor a match for its decision", () => {
    const f = foldDecisions(rows(audit(T + 300, { by: "teob" })), new Set(["follow"]));
    expect(f.others).toEqual([]);
    expect(f.decisions[0]!.actions[0]!.seen).toBeUndefined();
  });

  it("a person's identical call matches, and says who made it", () => {
    const f = foldDecisions(rows(audit(T + 2000, { by: "person:alex" })), new Set(["follow"]));
    expect(f.others.map((n) => n.by)).toEqual(["person:alex"]);
    expect(f.decisions[0]!.actions[0]!.seen).toMatchObject({ by: "person:alex" });
    expect(f.matched.size).toBe(1);
  });

  it("an old row without `by` is Node-RED's, as it was labelled", () => {
    const f = foldDecisions(rows(audit(T + 2000, {})), new Set(["follow"]));
    expect(f.others.map((n) => n.by)).toEqual(["nodered"]);
    expect(f.decisions[0]!.actions[0]!.seen).toMatchObject({ by: "nodered" });
  });
});

describe("origin labels", () => {
  it("names each origin; old rows read as Node-RED", () => {
    expect(["teob", "person:alex", "system:Supervisor", "user:01234567", "device", "nodered"].map(originLabel)).toEqual([
      "Teobeanie",
      "alex",
      "Supervisor",
      "user 01234567",
      "device",
      "Node-RED",
    ]);
    expect(originOf({ domain: "light" })).toBe("nodered");
    expect(originOf({ by: "person:alex" })).toBe("person:alex");
    expect(originChip("system:Supervisor").className).toBe("chip chip-origin chip-origin-system");
  });
});

describe("fmtDelta", () => {
  it("formats seconds and minutes", () => {
    expect(fmtDelta(-42_000)).toBe("42 s");
    expect(fmtDelta(151_000)).toBe("2 min 31 s");
    expect(fmtDelta(300_000)).toBe("5 min");
  });
});
