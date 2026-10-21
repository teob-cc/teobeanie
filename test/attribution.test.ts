// Attribution of observed call_service events: Teobeanie's own (by context id or by a
// pending request, whichever arrives first), a person, a system user, the device,
// and a user whose name HA would not tell.

import { describe, expect, it } from "vitest";
import {
  REQUEST_WINDOW_MS,
  createAttributor,
  createOwnCalls,
  createUserDirectory,
  userOrigin,
  type HaUser,
  type OwnCalls,
} from "../src/attribution.js";
import { createSafeActuator } from "../src/kernel/actuator.js";
import type { Action } from "../src/kernel/heuristic.js";

const USERS: HaUser[] = [
  { id: "a1b2c3d4e5f6a7b8", name: "alex", system_generated: false },
  { id: "5up3rv150r000000", name: "Supervisor", system_generated: true },
];

function directory(opts: { fail?: boolean; list?: HaUser[] } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const users = createUserDirectory({
    send: async <T,>(m: Record<string, unknown>): Promise<T> => {
      sent.push(m);
      if (opts.fail) throw new Error("Unauthorized");
      return (opts.list ?? USERS) as T;
    },
    log: (level, msg) => logs.push(`${level} ${msg}`),
    now: () => t,
  });
  return { users, sent, logs, advance: (ms: number) => (t += ms) };
}

const call = (over: Partial<{ domain: string; service: string; entityIds: string[]; contextId: string | null; userId: string | null }> = {}) => ({
  domain: "light",
  service: "turn_on",
  entityIds: ["light.hall_upper"],
  contextId: "ctx-1",
  userId: null as string | null,
  ...over,
});

describe("own calls", () => {
  it("an event arriving before HA answers matches the pending request (same service and entities)", () => {
    const own = createOwnCalls();
    own.requested("light", "turn_on", ["light.hall_upper", "light.hall_lower"]);
    expect(own.claim(call({ entityIds: ["light.hall_lower", "light.hall_upper"] }))).toBe(true);
  });

  it("a request is consumed by its event: an identical call right after is not Teobeanie's", () => {
    const own = createOwnCalls();
    own.requested("light", "turn_on", ["light.hall_upper"]);
    expect(own.claim(call({ contextId: "ctx-teob" }))).toBe(true);
    expect(own.claim(call({ contextId: "ctx-alex" }))).toBe(false);
  });

  it("another service or other entities do not match", () => {
    const own = createOwnCalls();
    own.requested("light", "turn_on", ["light.hall_upper"]);
    expect(own.claim(call({ service: "turn_off" }))).toBe(false);
    expect(own.claim(call({ entityIds: ["light.hall_upper", "light.porch"] }))).toBe(false);
    expect(own.claim(call({ domain: "switch" }))).toBe(false);
  });

  it("an event arriving after HA answered matches by context id", () => {
    const own = createOwnCalls();
    const settle = own.requested("light", "turn_on", ["light.hall_upper"]);
    settle("ctx-teob");
    expect(own.claim(call({ contextId: "ctx-teob" }))).toBe(true);
    // Settling dropped the request: a person's identical call is theirs.
    expect(own.claim(call({ contextId: "ctx-alex" }))).toBe(false);
  });

  it("calls HA makes on Teobeanie's behalf share its context id (homeassistant.turn_on, a script)", () => {
    const own = createOwnCalls();
    own.requested("homeassistant", "turn_on", ["light.hall_upper"]);
    expect(own.claim(call({ domain: "homeassistant", contextId: "ctx-teob" }))).toBe(true);
    // The child call arrives before HA answered the parent: the context id was taken from the match.
    expect(own.claim(call({ contextId: "ctx-teob" }))).toBe(true);
  });

  it("a request older than the window no longer matches", () => {
    let t = 0;
    const own = createOwnCalls(() => t);
    own.requested("light", "turn_on", ["light.hall_upper"]);
    t = REQUEST_WINDOW_MS + 1;
    expect(own.claim(call())).toBe(false);
  });

  it("a failed call leaves nothing behind", () => {
    const own = createOwnCalls();
    own.requested("light", "turn_on", ["light.hall_upper"])();
    expect(own.claim(call())).toBe(false);
  });
});

describe("users", () => {
  it("a person, a system user, and an id HA does not know", () => {
    expect(userOrigin("a1b2c3d4e5f6a7b8", USERS[0])).toBe("person:alex");
    expect(userOrigin("5up3rv150r000000", USERS[1])).toBe("system:Supervisor");
    expect(userOrigin("0123456789abcdef", undefined)).toBe("user:01234567");
  });

  it("reads config/auth/list once and caches it", async () => {
    const d = directory();
    expect(await d.users.originOf("a1b2c3d4e5f6a7b8")).toBe("person:alex");
    expect(await d.users.originOf("5up3rv150r000000")).toBe("system:Supervisor");
    expect(d.sent).toEqual([{ type: "config/auth/list" }]);
  });

  it("concurrent lookups share one read", async () => {
    const d = directory();
    const both = await Promise.all([d.users.originOf("a1b2c3d4e5f6a7b8"), d.users.originOf("5up3rv150r000000")]);
    expect(both).toEqual(["person:alex", "system:Supervisor"]);
    expect(d.sent).toHaveLength(1);
  });

  it("refresh (on reconnect) re-reads the list", async () => {
    const list = [...USERS];
    const d = directory({ list });
    await d.users.originOf("a1b2c3d4e5f6a7b8");
    list[0] = { ...list[0]!, name: "alexandra" };
    await d.users.refresh();
    expect(await d.users.originOf("a1b2c3d4e5f6a7b8")).toBe("person:alexandra");
    expect(d.sent).toHaveLength(2);
  });

  it("an unknown id falls back to user:<id prefix>, and re-reads at most once a minute", async () => {
    const d = directory();
    expect(await d.users.originOf("0123456789abcdef")).toBe("user:01234567");
    expect(await d.users.originOf("0123456789abcdef")).toBe("user:01234567");
    expect(d.sent).toHaveLength(1);
    d.advance(60_000);
    await d.users.originOf("0123456789abcdef");
    expect(d.sent).toHaveLength(2);
  });

  it("when the command fails (no admin rights) every user is user:<id prefix>, logged once", async () => {
    const d = directory({ fail: true });
    expect(await d.users.originOf("a1b2c3d4e5f6a7b8")).toBe("user:a1b2c3d4");
    await d.users.refresh();
    expect(await d.users.originOf("5up3rv150r000000")).toBe("user:5up3rv15");
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).toMatch(/^warn config\/auth\/list failed \(Unauthorized\)/);
  });
});

describe("attributor", () => {
  const attributor = (own: OwnCalls = createOwnCalls()) => createAttributor({ own, users: directory().users });

  it("a person's call", async () => {
    expect(await attributor()(call({ userId: "a1b2c3d4e5f6a7b8" }))).toBe("person:alex");
  });

  it("another add-on's call, made as the Supervisor", async () => {
    expect(await attributor()(call({ userId: "5up3rv150r000000" }))).toBe("system:Supervisor");
  });

  it("a call without a user id is the device's", async () => {
    expect(await attributor()(call({ userId: null }))).toBe("device");
  });

  it("Teobeanie calls as the Supervisor too, and is still its own (\"teob\")", async () => {
    const own = createOwnCalls();
    own.requested("light", "turn_on", ["light.hall_upper"]);
    expect(await attributor(own)(call({ userId: "5up3rv150r000000" }))).toBe("teob");
  });

  it("the own-call check happens when the event arrives, not after the name lookup", async () => {
    const own = createOwnCalls();
    const settle = own.requested("light", "turn_on", ["light.hall_upper"]);
    const by = attributor(own)(call({ contextId: "ctx-teob", userId: "5up3rv150r000000" }));
    settle("ctx-teob");
    expect(await by).toBe("teob");
  });
});

describe("the actuator registers Teobeanie's calls", () => {
  const action: Action = { kind: "call", service: "light.turn_on", entities: ["light.hall_upper"] };

  /** A fake HA that fires call_service before answering (as HA does), or after. */
  function house(eventFirst: boolean) {
    const own = createOwnCalls();
    const attribute = createAttributor({ own, users: directory().users });
    const seen: Array<Promise<string>> = [];
    const fire = (contextId: string) =>
      seen.push(attribute({ domain: "light", service: "turn_on", entityIds: ["light.hall_upper"], contextId, userId: "5up3rv150r000000" }));
    const actuator = createSafeActuator({
      ha: {
        callService: async () => {
          if (eventFirst) fire("ctx-teob");
          else setTimeout(() => fire("ctx-teob"), 0);
          return { context: { id: "ctx-teob" } };
        },
      },
      ownCalls: own,
    });
    return { actuator, seen, fire };
  }

  it("event before the answer: matched by the pending request", async () => {
    const h = house(true);
    expect(await h.actuator.execute(action)).toEqual({ ok: true, haContextId: "ctx-teob" });
    expect(await Promise.all(h.seen)).toEqual(["teob"]);
  });

  it("event after the answer: matched by the context id ActionCompleted will carry", async () => {
    const h = house(false);
    expect(await h.actuator.execute(action)).toEqual({ ok: true, haContextId: "ctx-teob" });
    expect(h.seen).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(await Promise.all(h.seen)).toEqual(["teob"]);
  });

  it("someone else's identical call afterwards is theirs", async () => {
    const h = house(true);
    await h.actuator.execute(action);
    h.fire("ctx-other");
    expect(await Promise.all(h.seen)).toEqual(["teob", "system:Supervisor"]);
  });
});
