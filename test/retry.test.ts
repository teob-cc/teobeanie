// SafeActuator: a call or notice that fails is tried once more, unless another try cannot help.

import { describe, expect, it } from "vitest";
import { createSafeActuator, retriable } from "../src/kernel/actuator.js";
import { houseScope } from "../src/allowlist.js";

const call = { kind: "call" as const, service: "light.turn_on", entities: ["light.porch"] };

function harness(errors: Array<string | undefined>, opts: { retryAfterMs?: number } = {}) {
  const tries: string[] = [];
  const slept: number[] = [];
  const actuator = createSafeActuator({
    ha: {
      callService: async () => {
        const e = errors[tries.length];
        tries.push(e ?? "ok");
        if (e !== undefined) throw new Error(e);
        return { context: { id: `ctx-${tries.length}` } };
      },
    },
    scope: houseScope(["light.porch"], ["light.porch"]),
    notifier: {
      send: async () => {
        const e = errors[tries.length];
        tries.push(e ?? "ok");
        if (e !== undefined) throw new Error(e);
      },
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...opts,
  });
  return { actuator, tries, slept };
}

describe("one retry", () => {
  it("a cloud rejection is tried again after 5 s, and the second answer counts", async () => {
    const h = harness(["The cloud rejected the command", undefined]);
    expect(await h.actuator.execute(call)).toEqual({ ok: true, haContextId: "ctx-2" });
    expect(h.slept).toEqual([5000]);
  });

  it("failing twice reports both", async () => {
    const h = harness(["timeout", "timeout"]);
    expect(await h.actuator.execute(call)).toEqual({ ok: false, error: "timeout (also after a retry)" });
    expect(h.tries).toHaveLength(2);
  });

  it("an error another try cannot fix is not retried", async () => {
    const h = harness(["Service light.turn_onn not found"]);
    expect(await h.actuator.execute(call)).toMatchObject({ ok: false, error: "Service light.turn_onn not found" });
    expect(h.tries).toHaveLength(1);
  });

  it("paused while waiting: not retried", async () => {
    const h = harness(["timeout", undefined]);
    const pending = h.actuator.execute(call);
    h.actuator.setPaused(true);
    expect(await pending).toEqual({ ok: false, error: "timeout (not retried: paused)" });
    expect(h.tries).toHaveLength(1);
  });

  it("a notice the chat rejects for a moment is sent again; a bad request is not", async () => {
    const h = harness(["fetch failed", undefined]);
    expect(await h.actuator.execute({ kind: "notify", channel: "telegram", text: "Door open" })).toEqual({ ok: true });
    expect(retriable("telegram sendMessage 400: chat not found")).toBe(false);
    expect(retriable("telegram sendMessage 502: Bad Gateway")).toBe(true);
  });

  it("retryAfterMs 0 turns it off", async () => {
    const h = harness(["timeout", undefined], { retryAfterMs: 0 });
    expect(await h.actuator.execute(call)).toMatchObject({ ok: false });
    expect(h.tries).toHaveLength(1);
  });
});
