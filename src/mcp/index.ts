// index.ts — the MCP endpoint: POST /mcp (Streamable HTTP, stateless), behind the
// access checks in access.ts. One server, two doors: Home Assistant ingress on the main
// port, and the agent port with an agent token (agents.ts). Every tool call is
// journaled with its caller.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Hono } from "hono";
import { createMCPToolRegistry, MCPToolResultFactory as Result, type MCPTool } from "@lambda-house/teob-ts/ai";
import { createMCPServer, mcpHono } from "@lambda-house/teob-ts/mcp-server";
import { checkAccess, checkAgentAccess, networks, type Caller } from "./access.js";
import type { AgentTokens, FailureLimiter } from "./agents.js";
import type { ToolCalled } from "./journal.js";

const callers = new AsyncLocalStorage<Caller>();
/** The caller of the MCP request being handled, if any. */
export const currentCaller = (): Caller | undefined => callers.getStore();

export interface McpDeps {
  mode: "addon" | "standalone";
  /** CIDRs a client may connect from (through ingress). */
  networks: readonly string[];
  tools: MCPTool[];
  instructions: string;
  version: string;
  record(call: Omit<ToolCalled, "tag">): void;
  log(level: "debug" | "info" | "warn" | "error", msg: string): void;
}

type Peer = { env?: { incoming?: { socket?: { remoteAddress?: string } } } };
type Ctx = Parameters<Parameters<Hono["use"]>[1]>[0];

/** The agent port's door: the tokens and the failed-attempt limit. */
export interface AgentDoor {
  tokens: Pick<AgentTokens, "verify">;
  limiter: FailureLimiter;
}

export interface Mcp {
  /** /mcp through Home Assistant ingress (standalone: loopback). */
  mountIngress(app: Hono): void;
  /** /mcp on the agent port: a valid agent token from an allowed network. */
  mountAgents(app: Hono, door: AgentDoor): void;
}

/** The ingress door alone (the main port's /mcp). */
export function mountMcp(app: Hono, deps: McpDeps): void {
  createMcp(deps).mountIngress(app);
}

export function createMcp(deps: McpDeps): Mcp {
  const allowed = networks(deps.networks);
  const registry = createMCPToolRegistry();
  for (const t of deps.tools) {
    registry.register({
      ...t,
      async execute(input) {
        const at = Date.now();
        let result;
        try {
          result = await t.execute(input);
        } catch (err) {
          result = Result.failure(err instanceof Error ? err.message : String(err));
        }
        deps.record({
          at,
          tool: t.name,
          args: JSON.stringify(input ?? {}).slice(0, 2048),
          caller: currentCaller() ?? { via: "local" },
          ok: result.success,
          ...(result.error !== undefined ? { error: result.error } : {}),
          ms: Date.now() - at,
        });
        return result;
      },
    });
  }
  const server = createMCPServer({
    registry,
    serverInfo: { name: "teobeanie", version: deps.version },
    instructions: deps.instructions,
    log: deps.log,
  });

  const peer = (c: Ctx): string | undefined => (c as unknown as Peer).env?.incoming?.socket?.remoteAddress;
  const mount = (app: Hono, guard: (c: Ctx, next: () => Promise<void>) => Promise<Response | void>): void => {
    app.use("/mcp", guard);
    app.use("/mcp/*", guard);
    app.route("/mcp", mcpHono(server));
  };

  return {
    mountIngress(app) {
      mount(app, async (c, next) => {
        const access = checkAccess(deps.mode, peer(c), (n) => c.req.header(n), allowed);
        if (!access.ok) {
          deps.log("warn", `mcp: refused ${c.req.method} ${c.req.path}: ${access.reason}`);
          return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `forbidden: ${access.reason}` } }, 403);
        }
        await callers.run(access.caller, next);
      });
    },
    mountAgents(app, door) {
      mount(app, async (c, next) => {
        const access = checkAgentAccess(peer(c), c.req.header("authorization"), allowed, door.tokens, door.limiter);
        if (!access.ok) {
          deps.log("warn", `mcp (agent port): refused ${c.req.method} ${c.req.path}: ${access.reason}`);
          const message = access.status === 401 ? `unauthorized: ${access.reason}` : access.status === 429 ? `too many attempts: ${access.reason}` : `forbidden: ${access.reason}`;
          const headers: Record<string, string> = access.status === 401 ? { "www-authenticate": 'Bearer realm="teobeanie"' } : {};
          return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, access.status, headers);
        }
        await callers.run(access.caller, next);
      });
    },
  };
}
