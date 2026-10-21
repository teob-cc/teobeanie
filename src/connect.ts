// connect.ts — the panel's Connect page: the agent tokens (list, mint, revoke) and the
// agent port's host port, so the page can show the exact line to paste into an agent.
// All of it through Home Assistant ingress only (an HA admin's session), or loopback
// standalone: a token is minted and revoked by a person in the panel, never by an agent.

import type { Hono } from "hono";
import { AGENT_PORT, tokenName, type AgentTokenInfo, type AgentTokens } from "./mcp/agents.js";
import { requestUser } from "./pause.js";
import { mayWrite } from "./studio/files.js";

/** Where the agent port is reachable on the host, as far as the add-on knows. */
export interface AgentPortInfo {
  /** The host port; null: the owner disabled it in the add-on's Network section. */
  port: number | null;
  /** "supervisor": the add-on's network info; "default": the info was not available; "standalone": the port listened on. */
  source: "supervisor" | "default" | "standalone";
}

/** GET api/connect's answer. */
export interface ConnectInfo extends AgentPortInfo {
  defaultPort: number;
  tokens: AgentTokenInfo[];
}

/**
 * The host port mapped to the agent port, from the Supervisor's `addons/self/info`
 * (`network["8199/tcp"]`), cached for a minute; the default when it cannot be read.
 */
export function supervisorPort(deps: { token: string; fetch?: typeof fetch; log?: (level: "warning", msg: string) => void; now?: () => number }): () => Promise<AgentPortInfo> {
  const get = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let cached: { at: number; info: AgentPortInfo } | undefined;
  return async () => {
    if (cached !== undefined && now() - cached.at < 60_000) return cached.info;
    let info: AgentPortInfo;
    try {
      const res = await get("http://supervisor/addons/self/info", { headers: { authorization: `Bearer ${deps.token}` }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { network?: Record<string, number | null> | null } };
      const network = body.data?.network ?? {};
      const mapped = network[`${AGENT_PORT}/tcp`];
      info = { port: typeof mapped === "number" ? mapped : null, source: "supervisor" };
    } catch (err) {
      deps.log?.("warning", `connect: could not read the add-on's network info (${String(err)}); assuming port ${AGENT_PORT}`);
      info = { port: AGENT_PORT, source: "default" };
    }
    cached = { at: now(), info };
    return info;
  };
}

type Peer = { env?: { incoming?: { socket?: { remoteAddress?: string } } } };

export interface ConnectDeps {
  mode: "addon" | "standalone";
  tokens: AgentTokens;
  port: () => Promise<AgentPortInfo>;
  log?: (level: "info", msg: string) => void;
}

/** GET api/connect, POST api/agent-tokens { name }, DELETE api/agent-tokens/:id — ingress only. */
export function mountConnect(app: Hono, deps: ConnectDeps): void {
  const refused = (c: { env: unknown }) => !mayWrite(deps.mode, (c as unknown as Peer).env?.incoming?.socket?.remoteAddress);
  const FORBIDDEN = { error: "Forbidden", reason: "agent tokens are managed through the Home Assistant panel only" };

  app.get("/api/connect", async (c) => {
    if (refused(c)) return c.json(FORBIDDEN, 403);
    const port = await deps.port();
    return c.json({ ...port, defaultPort: AGENT_PORT, tokens: deps.tokens.list() } satisfies ConnectInfo);
  });

  app.post("/api/agent-tokens", async (c) => {
    if (refused(c)) return c.json(FORBIDDEN, 403);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = tokenName(body?.name);
    if (typeof name !== "string") return c.json({ error: "BadRequest", reason: name.error }, 400);
    const by = requestUser((n) => c.req.header(n));
    try {
      const minted = await deps.tokens.mint(name, by);
      deps.log?.("info", `connect: agent token "${name}" (${minted.info.id}) minted by ${by}`);
      return c.json(minted, 201);
    } catch (err) {
      return c.json({ error: "NotMinted", reason: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.delete("/api/agent-tokens/:id", async (c) => {
    if (refused(c)) return c.json(FORBIDDEN, 403);
    const id = c.req.param("id");
    const by = requestUser((n) => c.req.header(n));
    try {
      if (!(await deps.tokens.revoke(id, by))) return c.json({ error: "NotFound", reason: `no agent token ${id}` }, 404);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    deps.log?.("info", `connect: agent token ${id} revoked by ${by}`);
    return c.json({ revoked: id });
  });
}
