// The agent port and its tokens: hashing, revocation, the failed-attempt limit, the
// port that serves only /mcp, the audit's caller, and the Connect API (ingress only).

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_NETWORKS, callerLabel, supervisorListed } from "../src/mcp/access.js";
import { createAgentTokens, createFailureLimiter, tokenName, type AccessEvent } from "../src/mcp/agents.js";
import { createMcp, currentCaller } from "../src/mcp/index.js";
import type { ToolCalled } from "../src/mcp/journal.js";
import { mountConnect, supervisorPort, type ConnectInfo } from "../src/connect.js";
import { agentApp } from "../src/server.js";
import { claudeLine, jsonSnippet, mcpUrl } from "../panel/src/connectLines.js";

const LAN = ["192.168.0.0/16", "100.64.0.0/10"];
const INGRESS = "172.30.32.2";
const env = (peer: string) => ({ incoming: { socket: { remoteAddress: peer } } });

function tokensIn(dir?: string) {
  const journaled: AccessEvent[] = [];
  const tokens = createAgentTokens({ ...(dir !== undefined ? { path: join(dir, "agent-tokens.json") } : {}), record: async (e) => void journaled.push(e) });
  return { tokens, journaled };
}

describe("agent tokens", () => {
  it("are kept as a salted hash only, and verify in a fresh process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teob-agents-"));
    const { tokens, journaled } = tokensIn(dir);
    const { token, info } = await tokens.mint("Claude Code on my laptop", "person:alex");
    expect(token).toMatch(/^tbn_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(info).toMatchObject({ name: "Claude Code on my laptop", by: "person:alex", lastUsedAt: null });

    const path = join(dir, "agent-tokens.json");
    const file = readFileSync(path, "utf8");
    const secret = token.slice("tbn_".length + 13);
    expect(file).not.toContain(secret);
    expect(file).not.toContain(token);
    const stored = (JSON.parse(file) as { tokens: Array<Record<string, string>> }).tokens[0]!;
    expect(stored).toMatchObject({ id: info.id, name: info.name });
    expect(stored["salt"]).toMatch(/^[0-9a-f]{32}$/);
    expect(stored["hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(journaled).toEqual([{ tag: "AgentTokenMinted", at: info.createdAt, id: info.id, name: info.name, by: "person:alex" }]);

    // Two tokens of the same secret never hash alike: each has its own salt.
    const second = await tokens.mint("another", "person:alex");
    expect((JSON.parse(readFileSync(path, "utf8")) as { tokens: Array<{ salt: string }> }).tokens[1]!.salt).not.toBe(stored["salt"]);

    const again = tokensIn(dir).tokens;
    expect(again.verify(token)).toMatchObject({ id: info.id, name: "Claude Code on my laptop" });
    expect(again.verify(second.token)?.name).toBe("another");
  });

  it("refuse a wrong secret, a wrong id, and anything not shaped like a token", async () => {
    const { tokens } = tokensIn();
    const { token, info } = await tokens.mint("agent", "local");
    const flip = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(tokens.verify(flip)).toBeUndefined();
    expect(tokens.verify(token.replace(info.id, "000000000000"))).toBeUndefined();
    for (const bad of ["", "tbn_", "Bearer x", token + "x", token.toUpperCase()]) expect(tokens.verify(bad), bad).toBeUndefined();
    expect(tokens.verify(token)).toBeDefined();
  });

  it("start empty, without stopping the add-on, when the file cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teob-agents-"));
    writeFileSync(join(dir, "agent-tokens.json"), "{ not json");
    const logged: string[] = [];
    const tokens = createAgentTokens({ path: join(dir, "agent-tokens.json"), record: async () => {}, log: (_l, m) => logged.push(m) });
    expect(tokens.list()).toEqual([]);
    expect(existsSync(join(dir, "agent-tokens.json.unreadable"))).toBe(true);
    expect(logged).toHaveLength(1);
  });

  it("record when each was last used, in memory", async () => {
    let t = 1000;
    const tokens = createAgentTokens({ record: async () => {}, now: () => t });
    const { token, info } = await tokens.mint("agent", "local");
    expect(tokens.list()).toEqual([{ ...info, lastUsedAt: null }]);
    t = 5000;
    tokens.verify(token);
    expect(tokens.list()[0]!.lastUsedAt).toBe(5000);
  });

  it("are refused the moment they are revoked, and the revocation is journaled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teob-agents-"));
    const { tokens, journaled } = tokensIn(dir);
    const { token, info } = await tokens.mint("agent", "person:alex");
    expect(await tokens.revoke(info.id, "person:sam")).toBe(true);
    expect(tokens.verify(token)).toBeUndefined();
    expect(tokensIn(dir).tokens.verify(token)).toBeUndefined();
    expect(tokens.list()).toEqual([]);
    expect(journaled.at(-1)).toMatchObject({ tag: "AgentTokenRevoked", id: info.id, by: "person:sam" });
    expect(await tokens.revoke(info.id, "person:sam")).toBe(false);
  });

  it("are not kept when the mint cannot be journaled", async () => {
    const tokens = createAgentTokens({ record: async () => Promise.reject(new Error("journal down")) });
    await expect(tokens.mint("agent", "local")).rejects.toThrow("journal down");
    expect(tokens.list()).toEqual([]);
  });

  it("need a name", () => {
    expect(tokenName("  Claude Code on my laptop ")).toBe("Claude Code on my laptop");
    expect(tokenName("a\nb")).toBe("a b");
    expect(tokenName("")).toMatchObject({ error: expect.any(String) });
    expect(tokenName("x".repeat(81))).toMatchObject({ error: expect.any(String) });
    expect(tokenName(3)).toMatchObject({ error: expect.any(String) });
  });
});

describe("failed attempts", () => {
  it("block an address after the limit, until the window has passed; other addresses go on", () => {
    let t = 0;
    const limiter = createFailureLimiter({ max: 3, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 3; i++) limiter.fail("192.168.1.20");
    expect(limiter.blocked("192.168.1.20")).toBe(true);
    expect(limiter.blocked("192.168.1.21")).toBe(false);
    t = 61_000;
    expect(limiter.blocked("192.168.1.20")).toBe(false);
  });
});

describe("the agent port", () => {
  async function setup(networks: readonly string[] = LAN) {
    const { tokens } = tokensIn();
    const recorded: Array<Omit<ToolCalled, "tag">> = [];
    const logged: Array<[string, string]> = [];
    const mcp = createMcp({
      mode: "addon",
      networks,
      tools: [
        {
          name: "whoami",
          description: "who",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ success: true, output: currentCaller() ?? null }),
        } as never,
      ],
      instructions: "test",
      version: "test",
      record: (c) => recorded.push(c),
      log: (level, msg) => logged.push([level, msg]),
    });
    const limiter = createFailureLimiter({ max: 8 });
    const app = agentApp((a) => mcp.mountAgents(a, { tokens, limiter }));
    const { token, info } = await tokens.mint("Claude Code on my laptop", "person:alex");
    const call = (body: unknown, peer: string, headers: Record<string, string> = {}, path = "/mcp", method = "POST") =>
      app.request(path, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}), headers: { "content-type": "application/json", ...headers } }, env(peer));
    return { tokens, token, info, recorded, logged, call, mcp };
  }
  const whoami = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } };
  const text = async (res: Response) => JSON.parse(((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as unknown;

  it("serves the tools to a valid token from an allowed network, journaling the agent as the caller", async () => {
    const { token, info, recorded, call } = await setup();
    const auth = { authorization: `Bearer ${token}` };
    const init = await call({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, "192.168.1.20", auth);
    expect(init.status).toBe(200);
    const res = await call(whoami, "::ffff:192.168.1.20", auth);
    expect(res.status).toBe(200);
    const caller = { via: "agent", agent: "Claude Code on my laptop", tokenId: info.id, address: "192.168.1.20" };
    expect(await text(res)).toEqual(caller);
    expect(recorded).toEqual([expect.objectContaining({ tool: "whoami", ok: true, caller })]);
    expect(callerLabel(recorded[0]!.caller)).toBe("agent:Claude Code on my laptop");
  });

  it("serves only /mcp: no panel, no read API, no writes, no health", async () => {
    const { token, call } = await setup();
    const auth = { authorization: `Bearer ${token}` };
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/index.html"],
      ["GET", "/health"],
      ["GET", "/api/house"],
      ["GET", "/api/journal"],
      ["GET", "/api/connect"],
      ["POST", "/api/agent-tokens"],
      ["POST", "/api/pause"],
      ["PUT", "/api/studio/files/x.ts"],
      ["GET", "/mcp/x"],
    ] as const) {
      const res = await call({}, "192.168.1.20", auth, path, method);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // /mcp itself has no GET stream.
    expect((await call({}, "192.168.1.20", auth, "/mcp", "GET")).status).toBe(405);
  });

  it("refuses a missing, malformed, wrong or revoked token with 401, and journals nothing", async () => {
    const { tokens, token, info, recorded, call } = await setup();
    const status = async (headers: Record<string, string>) => (await call(whoami, "192.168.1.20", headers)).status;
    expect(await status({})).toBe(401);
    expect(await status({ authorization: token })).toBe(401);
    expect(await status({ authorization: `Basic ${token}` })).toBe(401);
    expect(await status({ authorization: `Bearer ${token.slice(0, -2)}xx` })).toBe(401);
    const res = await call(whoami, "192.168.1.20", { authorization: "Bearer nope" });
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/unauthorized/);
    expect(await status({ authorization: `Bearer ${token}` })).toBe(200);
    await tokens.revoke(info.id, "person:alex");
    expect(await status({ authorization: `Bearer ${token}` })).toBe(401);
    expect(recorded).toHaveLength(1);
  });

  it("refuses a client outside the allowed networks, whatever the token, and ignores forwarded addresses", async () => {
    const { token, call } = await setup();
    const auth = { authorization: `Bearer ${token}` };
    expect((await call(whoami, "203.0.113.9", auth)).status).toBe(403);
    expect((await call(whoami, "203.0.113.9", { ...auth, "x-forwarded-for": "192.168.1.20" })).status).toBe(403);
    // The ingress gateway's address is no pass here: it is outside these networks.
    expect((await call(whoami, INGRESS, { ...auth, "x-forwarded-for": "192.168.1.20", "x-remote-user-name": "alex" })).status).toBe(403);
    const closed = await setup([]);
    expect((await closed.call(whoami, "192.168.1.20", { authorization: `Bearer ${closed.token}` })).status).toBe(403);
  });

  it("refuses the Supervisor network's gateway, which the port mapping may put in the client's place", async () => {
    // The default networks contain 172.30.32.1 (in 172.16.0.0/12): the token alone would guard the port.
    const { token, recorded, logged, call } = await setup(DEFAULT_MCP_NETWORKS);
    const auth = { authorization: `Bearer ${token}` };
    for (const peer of ["172.30.32.1", "::ffff:172.30.32.1", "172.30.33.200", "fd0c:ac1e:2100::1"]) {
      const res = await call(whoami, peer, auth);
      expect(res.status, peer).toBe(403);
      const message = ((await res.json()) as { error: { message: string } }).error.message;
      expect(message).toMatch(/^forbidden: client .* is in the Supervisor network/);
      expect(message).toContain("port mapping hides the client's real address");
      expect(message).toContain("ingress");
      expect(message).toContain("add 172.30.32.0/23 to mcp_networks deliberately");
      expect(message).toContain("only the agent token then protects the port");
    }
    expect(recorded).toEqual([]);
    // One warning in the log; the next refusals of the same kind only at debug.
    const hidden = logged.filter(([, m]) => m.includes("Supervisor network"));
    expect(hidden.map(([level]) => level)).toEqual(["warn", "debug", "debug", "debug"]);
    expect(hidden[0]![1]).toContain("port mapping hides the client's real address");
    // The rest of 172.16.0.0/12 is still a LAN.
    expect((await call(whoami, "172.16.0.5", auth)).status).toBe(200);
  });

  it("lets the Supervisor network in when the owner lists it, and only then", async () => {
    for (const listed of [["172.30.32.0/23"], ["172.30.32.1/32"], ["fd0c:ac1e:2100::/48"]]) {
      const { token, call } = await setup([...DEFAULT_MCP_NETWORKS, ...listed]);
      const auth = { authorization: `Bearer ${token}` };
      const peer = listed[0]!.includes(":") ? "fd0c:ac1e:2100::1" : "172.30.32.1";
      expect((await call(whoami, peer, auth)).status, listed[0]).toBe(200);
      expect((await call(whoami, peer, { authorization: "Bearer tbn_wrong" })).status, listed[0]).toBe(401);
    }
    // A wider range that merely contains it is not a listing.
    const wide = await setup(["172.30.32.0/22"]);
    expect((await wide.call(whoami, "172.30.32.1", { authorization: `Bearer ${wide.token}` })).status).toBe(403);
    expect(supervisorListed(["172.16.0.0/12", "10.0.0.0/8", "fc00::/7"]).check("172.30.32.1", "ipv4")).toBe(false);
  });

  it("refuses an address after too many failures, even with a valid token", async () => {
    const { token, call } = await setup();
    for (let i = 0; i < 8; i++) expect((await call(whoami, "192.168.1.30", { authorization: "Bearer tbn_wrong" })).status).toBe(401);
    expect((await call(whoami, "192.168.1.30", { authorization: `Bearer ${token}` })).status).toBe(429);
    expect((await call(whoami, "192.168.1.31", { authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it("over a real socket: the peer is the connection's own address", async () => {
    const { tokens } = tokensIn();
    const { token } = await tokens.mint("agent", "local");
    const recorded: Array<Omit<ToolCalled, "tag">> = [];
    const open = (networks: string[]) => {
      const mcp = createMcp({
        mode: "addon",
        networks,
        tools: [{ name: "whoami", description: "who", inputSchema: { type: "object", properties: {} }, execute: async () => ({ success: true, output: currentCaller() ?? null }) } as never],
        instructions: "test",
        version: "test",
        record: (c) => recorded.push(c),
        log: () => {},
      });
      const server = serve({ fetch: agentApp((a) => mcp.mountAgents(a, { tokens, limiter: createFailureLimiter() })).fetch, port: 0, hostname: "127.0.0.1" });
      return new Promise<{ url: string; close: () => void }>((resolve) =>
        server.once("listening", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })),
      );
    };
    const post = (url: string, auth?: string) =>
      fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(whoami) });
    const loopback = await open(["127.0.0.0/8"]);
    try {
      expect((await post(loopback.url)).status).toBe(401);
      const ok = await post(loopback.url, `Bearer ${token}`);
      expect(ok.status).toBe(200);
      expect(await text(ok)).toMatchObject({ via: "agent", agent: "agent", address: "127.0.0.1" });
      expect((await fetch(`${loopback.url}/health`)).status).toBe(404);
    } finally {
      loopback.close();
    }
    const lanOnly = await open(LAN);
    try {
      expect((await post(lanOnly.url, `Bearer ${token}`)).status).toBe(403);
    } finally {
      lanOnly.close();
    }
  });

  it("leaves the ingress door as it was", async () => {
    const { mcp } = await setup();
    const app = new Hono();
    mcp.mountIngress(app);
    const via = (peer: string, headers: Record<string, string>) =>
      app.request("/mcp", { method: "POST", body: JSON.stringify(whoami), headers: { "content-type": "application/json", ...headers } }, env(peer));
    const ok = await via(INGRESS, { "x-forwarded-for": "192.168.1.20", "x-remote-user-name": "alex" });
    expect(ok.status).toBe(200);
    expect(await text(ok)).toEqual({ via: "ingress", address: "192.168.1.20", user: "alex" });
    // An agent token is no way in through the main port from outside ingress.
    expect((await via("192.168.1.20", {})).status).toBe(403);
  });
});

describe("the Connect API", () => {
  async function setup(mode: "addon" | "standalone" = "addon") {
    const { tokens, journaled } = tokensIn();
    const app = new Hono();
    mountConnect(app, { mode, tokens, port: async () => ({ port: 8199, source: "supervisor" }) });
    const req = (method: string, path: string, peer: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { "content-type": "application/json", ...headers } }, env(peer));
    return { tokens, journaled, req };
  }

  it("mints, lists and revokes through ingress, with the HA user as who did it", async () => {
    const { tokens, journaled, req } = await setup();
    const minted = await req("POST", "/api/agent-tokens", INGRESS, { name: "Claude Code on my laptop" }, { "x-remote-user-name": "alex" });
    expect(minted.status).toBe(201);
    const { token, info } = (await minted.json()) as { token: string; info: { id: string; by: string } };
    expect(info.by).toBe("person:alex");
    expect(tokens.verify(token)).toBeDefined();

    const listed = (await (await req("GET", "/api/connect", INGRESS)).json()) as ConnectInfo;
    expect(listed).toMatchObject({ port: 8199, defaultPort: 8199, source: "supervisor", tokens: [{ id: info.id, name: "Claude Code on my laptop", by: "person:alex" }] });
    expect(JSON.stringify(listed)).not.toContain(token.slice("tbn_".length + 13));

    expect((await req("DELETE", `/api/agent-tokens/${info.id}`, INGRESS, undefined, { "x-remote-user-name": "sam" })).status).toBe(200);
    expect(tokens.verify(token)).toBeUndefined();
    expect(journaled.map((e) => [e.tag, e.by])).toEqual([
      ["AgentTokenMinted", "person:alex"],
      ["AgentTokenRevoked", "person:sam"],
    ]);
    expect((await req("DELETE", `/api/agent-tokens/${info.id}`, INGRESS)).status).toBe(404);
  });

  it("refuses everything that does not come through ingress", async () => {
    const { tokens, journaled, req } = await setup();
    for (const peer of ["192.168.1.20", "172.30.33.5", "127.0.0.1"]) {
      expect((await req("GET", "/api/connect", peer)).status, peer).toBe(403);
      expect((await req("POST", "/api/agent-tokens", peer, { name: "x" })).status, peer).toBe(403);
    }
    const { info } = await tokens.mint("kept", "local");
    expect((await req("DELETE", `/api/agent-tokens/${info.id}`, "192.168.1.20")).status).toBe(403);
    expect(tokens.list()).toHaveLength(1);
    expect(journaled).toHaveLength(1);
  });

  it("standalone: loopback only", async () => {
    const { req } = await setup("standalone");
    expect((await req("POST", "/api/agent-tokens", "127.0.0.1", { name: "dev" })).status).toBe(201);
    expect((await req("POST", "/api/agent-tokens", "192.168.1.20", { name: "dev" })).status).toBe(403);
  });

  it("wants a name", async () => {
    const { req } = await setup();
    expect((await req("POST", "/api/agent-tokens", INGRESS, { name: " " })).status).toBe(400);
    expect((await req("POST", "/api/agent-tokens", INGRESS, {})).status).toBe(400);
  });
});

describe("the agent port's host port", () => {
  const answer = (network: unknown, status = 200) =>
    (async () => new Response(JSON.stringify({ result: "ok", data: { network } }), { status })) as unknown as typeof fetch;

  it("comes from the add-on's network info", async () => {
    expect(await supervisorPort({ token: "t", fetch: answer({ "8199/tcp": 18199 }) })()).toEqual({ port: 18199, source: "supervisor" });
    // Cleared in the Network section: the port is closed.
    expect(await supervisorPort({ token: "t", fetch: answer({ "8199/tcp": null }) })()).toEqual({ port: null, source: "supervisor" });
  });

  it("is the default when the info cannot be read", async () => {
    const failing = (async () => {
      throw new Error("no supervisor");
    }) as unknown as typeof fetch;
    expect(await supervisorPort({ token: "t", fetch: failing })()).toEqual({ port: 8199, source: "default" });
    expect(await supervisorPort({ token: "t", fetch: answer({}, 403) })()).toEqual({ port: 8199, source: "default" });
  });
});

describe("the lines the Connect page shows", () => {

  it("point Claude Code and other clients at the agent port with the token", () => {
    const url = mcpUrl("homeassistant.local", 8199);
    expect(url).toBe("http://homeassistant.local:8199/mcp");
    expect(claudeLine(url, "tbn_x")).toBe('claude mcp add --transport http teobeanie http://homeassistant.local:8199/mcp --header "Authorization: Bearer tbn_x"');
    expect(JSON.parse(jsonSnippet(url, "tbn_x"))).toEqual({ mcpServers: { teobeanie: { type: "http", url, headers: { Authorization: "Bearer tbn_x" } } } });
    expect(mcpUrl("fd7a:115c:a1e0::1", 18199)).toBe("http://[fd7a:115c:a1e0::1]:18199/mcp");
    expect(mcpUrl("[fd7a:115c:a1e0::1]", 8199)).toBe("http://[fd7a:115c:a1e0::1]:8199/mcp");
  });
});
