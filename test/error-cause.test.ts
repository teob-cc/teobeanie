// A failed fetch says only "fetch failed": the log has to say why.

import { describe, expect, it } from "vitest";
import { createTelegramNotifier, retriable } from "../src/kernel/actuator.js";
import { causeOf } from "../src/kernel/error-cause.js";

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
const fetchFailed = (cause: unknown) => new TypeError("fetch failed", { cause });

describe("causeOf", () => {
  it("nothing to add without a cause", () => {
    expect(causeOf(new Error("timeout"))).toBe("");
    expect(causeOf("a string")).toBe("");
    expect(causeOf(undefined)).toBe("");
    expect(causeOf(fetchFailed("just text"))).toBe("");
  });

  it("the code and message of the cause", () => {
    expect(causeOf(fetchFailed(coded("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT")))).toBe(" (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)");
  });

  it("the code once when the message already has it", () => {
    expect(causeOf(fetchFailed(coded("getaddrinfo EAI_AGAIN api.telegram.org", "EAI_AGAIN")))).toBe(" (getaddrinfo EAI_AGAIN api.telegram.org)");
  });

  it("each address of a connection tried on several", () => {
    const tried = Object.assign(new AggregateError([coded("connect ETIMEDOUT 149.154.166.110:443", "ETIMEDOUT"), coded("connect ENETUNREACH 2001:db8::9:443", "ENETUNREACH")], ""), {
      code: "ETIMEDOUT",
    });
    expect(causeOf(fetchFailed(tried))).toBe(" (connect ETIMEDOUT 149.154.166.110:443; connect ENETUNREACH 2001:db8::9:443)");
  });

  it("follows a cause of a cause, and stops", () => {
    const deep = fetchFailed(new Error("a", { cause: new Error("b", { cause: new Error("c", { cause: new Error("d", { cause: new Error("e") }) }) }) }));
    expect(causeOf(deep)).toBe(" (a; b; c)");
  });

  it("a cause that loops ends", () => {
    const a = new Error("a");
    a.cause = a;
    expect(causeOf(fetchFailed(a))).toBe(" (a)");
  });

  it("never the bot token", () => {
    const text = causeOf(fetchFailed(new Error("bad url https://api.telegram.org/bot123456:AA-b_c/sendMessage")));
    expect(text).toBe(" (bad url https://api.telegram.org/bot<token>/sendMessage)");
  });

  it("stays short", () => {
    expect(causeOf(fetchFailed(new Error("x".repeat(1000)))).length).toBeLessThan(310);
  });
});

describe("a notice that cannot be sent says why", () => {
  it("the error names the reason, and which attempt", async () => {
    const n = createTelegramNotifier({
      token: "123:abc",
      chatId: "1",
      retryAfterMs: 1,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        throw fetchFailed(coded("read ECONNRESET", "ECONNRESET"));
      }) as typeof fetch,
    });
    await expect(n.send("hello")).rejects.toThrow("fetch failed (read ECONNRESET) (also after a retry)");
  });

  it("the reason doesn't decide the retry: only the error's own message does", async () => {
    // Its cause reads like an error another try cannot fix; the send is still tried twice.
    let tries = 0;
    const n = createTelegramNotifier({
      token: "123:abc",
      chatId: "1",
      retryAfterMs: 1,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        tries++;
        throw fetchFailed(new Error("host not found"));
      }) as typeof fetch,
    });
    await expect(n.send("hello")).rejects.toThrow("fetch failed (host not found) (also after a retry)");
    expect(tries).toBe(2);
    expect(retriable("fetch failed")).toBe(true);
  });
});
