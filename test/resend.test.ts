// Notices cut off by a restart, on the real sqlite runtime: the add-on is stopped while
// a send is in flight and booted again on the same journal. A recent notice is sent
// once more, marked; an old one, a call, or a shadow instance's is not.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteJournal } from "@lambda-house/teob-ts/sqlite";
import { call, defineHeuristic, minutes, notify } from "../src/kernel/heuristic.js";
import { createHeuristicHost } from "../src/kernel/host.js";
import { createSafeActuator } from "../src/kernel/actuator.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

/** Open: a notice. Closed: a call. */
const shedDoor = defineHeuristic<unknown, object, { tag: string }>({
  id: "shed-door",
  title: "shed door",
  description: "",
  pattern: "notice",
  watch: () => ["binary_sensor.shed_door"],
  actuates: () => ["light.hall_upper"],
  initial: () => ({}),
  decide(_s, input) {
    if (input.kind !== "signal") return undefined;
    return input.value === true
      ? { why: "open", actions: [notify("Shed door still open")] }
      : { why: "closed", actions: [call("light.turn_off", "light.hall_upper")] };
  },
  evolve: (s) => s,
});

interface Boot {
  /** Hang every send and call: the restart comes before they complete. */
  hang?: boolean;
  forceShadow?: boolean;
}

function house() {
  const path = join(mkdtempSync(join(tmpdir(), "teobeanie-resend-")), "journal.db");
  const sent: string[] = [];
  const called: string[] = [];

  async function boot(opts: Boot = {}) {
    const actuator = createSafeActuator({
      ha: {
        callService: async (req) => {
          called.push(`${req.domain}.${req.service}`);
          return opts.hang ? never() : { context: { id: "ctx" } };
        },
      },
      notifier: {
        send: async (text) => {
          sent.push(text);
          if (opts.hang) await never();
        },
      },
    });
    const host = createHeuristicHost({
      library: [shedDoor],
      instances: [{ heuristic: "shed-door", id: "i", mode: "active", params: {} }],
      actuator,
      liveState: () => undefined,
      forceShadow: opts.forceShadow ?? false,
      log: () => {},
    });
    const journal = createSqliteJournal({ path });
    host.attach(journal);
    await host.start({ subscribeTrigger: async () => async () => {} });
    const events = () => journal.queryEvents({ category: "shed-door", limit: 1000 }).map((r) => r.payload as { tag: string; [k: string]: unknown });
    const tagged = (tag: string) => events().filter((e) => e.tag === tag);
    const signal = (open: boolean, at = Date.now()) =>
      host.onSignal({
        obsId: `obs-${at}-${open}`, entityId: "binary_sensor.shed_door", at, haTimeFired: at,
        raw: { state: open ? "on" : "off" }, normalized: { value: open, unit: null }, origin: "ha", haVersion: null, policyVersion: 1,
      });
    const stop = async () => {
      await host.stop();
      journal.close();
    };
    return { signal, tagged, stop };
  }

  return { boot, sent, called };
}

/** Boot, decide one action whose send hangs, and stop before it completes. */
async function interrupted(h: ReturnType<typeof house>, open: boolean, at?: number) {
  const b = await h.boot({ hang: true });
  b.signal(open, at);
  await vi.waitFor(() => expect(b.tagged("ActionRequested")).toHaveLength(1));
  await b.stop();
}

describe("a notice a restart cut off", () => {
  it("is sent once more after the restart, marked, and not again after a second one", async () => {
    const h = house();
    await interrupted(h, true);
    expect(h.sent).toEqual(["Shed door still open"]); // it left, but never came back as completed

    const b2 = await h.boot();
    await vi.waitFor(() => expect(b2.tagged("ActionCompleted")).toHaveLength(2));
    expect(h.sent).toEqual(["Shed door still open", "Shed door still open\n(resent after a restart)"]);
    expect(b2.tagged("ActionCompleted").map((e) => e["error"] ?? "ok").sort()).toEqual(["interrupted by restart", "ok"]);
    expect(b2.tagged("ActionResent")).toHaveLength(1);
    await b2.stop();

    const b3 = await h.boot();
    await sleep(200);
    expect(h.sent).toHaveLength(2);
    expect(b3.tagged("ActionResent")).toHaveLength(1);
    await b3.stop();
  });

  it("is not sent again when the resend itself is cut off", async () => {
    const h = house();
    await interrupted(h, true);
    const b2 = await h.boot({ hang: true });
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    await b2.stop();

    const b3 = await h.boot();
    await vi.waitFor(() => expect(b3.tagged("ResendDropped")).toHaveLength(1));
    expect(b3.tagged("ResendDropped")[0]).toMatchObject({ reason: "already resent once" });
    expect(h.sent).toHaveLength(2);
    await b3.stop();
  });

  it("is dropped with a journaled reason when decided longer ago than the window", async () => {
    const h = house();
    await interrupted(h, true, Date.now() - minutes(11));
    const b2 = await h.boot();
    await vi.waitFor(() => expect(b2.tagged("ResendDropped")).toHaveLength(1));
    expect(b2.tagged("ResendDropped")[0]!["reason"]).toBe("requested 11 min ago, older than 10 min");
    expect(b2.tagged("ActionCompleted")[0]).toMatchObject({ ok: false, error: "interrupted by restart" });
    expect(h.sent).toHaveLength(1);
    await b2.stop();
  });

  it("is never sent by an instance that comes back in shadow mode", async () => {
    const h = house();
    await interrupted(h, true);
    const b2 = await h.boot({ forceShadow: true });
    await vi.waitFor(() => expect(b2.tagged("ResendDropped")).toHaveLength(1));
    expect(b2.tagged("ResendDropped")[0]).toMatchObject({ reason: "shadow mode: never sent" });
    expect(h.sent).toHaveLength(1);
    await b2.stop();
  });
});

describe("a call a restart cut off", () => {
  it("is settled as interrupted and never replayed", async () => {
    const h = house();
    await interrupted(h, false);
    expect(h.called).toEqual(["light.turn_off"]);
    const b2 = await h.boot();
    await vi.waitFor(() => expect(b2.tagged("ActionCompleted")).toHaveLength(1));
    expect(b2.tagged("ActionCompleted")[0]).toMatchObject({ ok: false, error: "interrupted by restart" });
    await sleep(100);
    expect(h.called).toEqual(["light.turn_off"]);
    expect(b2.tagged("ActionResent")).toHaveLength(0);
    expect(b2.tagged("ResendDropped")).toHaveLength(0);
    await b2.stop();
  });
});
