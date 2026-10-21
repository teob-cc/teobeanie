// Timer recovery on the real sqlite runtime. teob-ts keeps timers in memory, starts
// entities lazily and cancels a crashed entity's timers; the kernel journals timers
// and re-arms them on recovery, and the host's periodic wake makes recovery happen.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import { defineHeuristic, setTimer } from "../src/kernel/heuristic.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(wakeIntervalMs: number) {
  let glitchOnce = true;
  const h = defineHeuristic<unknown, { glitches: number }, { tag: "Glitch" }>({
    id: "crashy",
    title: "crashy",
    description: "",
    watch: () => ["binary_sensor.x"],
    actuates: () => [],
    initial: () => ({ glitches: 0 }),
    decide(_s, input, ctx) {
      if (input.kind === "start") return { why: "arm", timers: [setTimer("t", ctx.now + 250)] };
      if (input.kind === "signal") return { why: "glitch", events: [{ tag: "Glitch" }] };
      if (input.kind === "timer") return { why: "fired" };
      return undefined;
    },
    evolve(s) {
      // Throws the first time only: the live apply crashes the entity, the replay on recovery succeeds.
      if (glitchOnce) {
        glitchOnce = false;
        throw new Error("evolve bug");
      }
      return { glitches: s.glitches + 1 };
    },
  });
  const host = createHeuristicHost({
    library: [h],
    instances: [{ heuristic: "crashy", id: "i", mode: "shadow", params: {} }],
    actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "x" } }) } }),
    liveState: () => ({ entity_id: "binary_sensor.x", state: "on", attributes: {}, last_changed: "", last_updated: "" }),
    forceShadow: true,
    log: () => {},
    wakeIntervalMs,
  });
  const path = join(mkdtempSync(join(tmpdir(), "teobeanie-recovery-")), "journal.db");
  const journal = createSqliteJournal({ path });
  host.attach(journal);
  const fired = () =>
    journal
      .queryEvents({ category: "crashy", limit: 100 })
      .filter((r) => r.manifest === "Decided" && (r.payload as { why?: string }).why === "fired").length;
  const signal = () =>
    host.onSignal({
      obsId: "obs-1", entityId: "binary_sensor.x", at: Date.now(), haTimeFired: Date.now(),
      raw: { state: "on" }, normalized: { value: true, unit: null }, origin: "ha", haVersion: null, policyVersion: 1,
    });
  const close = async () => {
    await host.stop();
    journal.close();
  };
  return { host, signal, fired, close };
}

describe("timer recovery after an instance crash", () => {
  it("the periodic wake recreates the instance and its journaled timer still fires", async () => {
    const t = setup(50);
    await t.host.start({ subscribeTrigger: async () => async () => {} });
    await sleep(30);
    t.signal(); // evolve throws → entity crashes → its in-memory timer is cancelled
    await sleep(500);
    expect(t.fired()).toBe(1);
    await t.close();
  });

  it("without a wake the timer stays silent (the teob-ts behaviour the wake works around)", async () => {
    const t = setup(60_000);
    await t.host.start({ subscribeTrigger: async () => async () => {} });
    await sleep(30);
    t.signal();
    await sleep(500);
    expect(t.fired()).toBe(0);
    await t.close();
  });
});
