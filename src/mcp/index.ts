// index.ts — the MCP endpoint: POST /mcp (Streamable HTTP, stateless), behind the
// access check in access.ts. Every tool call is journaled with its caller.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Hono } from "hono";
import { createMCPToolRegistry, MCPToolResultFactory as Result, type MCPTool } from "@lambda-house/teob-ts/ai";
import { createMCPServer, mcpHono } from "@lambda-house/teob-ts/mcp-server";
import { checkAccess, networks, type Caller } from "./access.js";
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

export function mountMcp(app: Hono, deps: McpDeps): void {
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

  const guard = async (c: Parameters<Parameters<Hono["use"]>[1]>[0], next: () => Promise<void>) => {
    const access = checkAccess(deps.mode, (c as unknown as Peer).env?.incoming?.socket?.remoteAddress, (n) => c.req.header(n), allowed);
    if (!access.ok) {
      deps.log("warn", `mcp: refused ${c.req.method} ${c.req.path}: ${access.reason}`);
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `forbidden: ${access.reason}` } }, 403);
    }
    await callers.run(access.caller, next);
  };
  app.use("/mcp", guard);
  app.use("/mcp/*", guard);
  app.route("/mcp", mcpHono(server));
}
