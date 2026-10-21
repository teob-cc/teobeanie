// command.ts — a named command from the panel, as Telegram sends one: POST api/command
// { name, args } through Home Assistant ingress only, run as the HA user of the
// ingress session. The host routes it to the instances that answer to it; their
// replies are notify actions, journaled like any other (the panel follows them on the
// journal frame). Any command: the buttons of the instances' cards on the House page
// (src/kernel/card.ts) run theirs through it.

import type { Hono } from "hono";
import type { CommandSource } from "./kernel/heuristic.js";
import { requestUser } from "./pause.js";
import { mayWrite } from "./studio/files.js";

/** A command name as Telegram takes them; a few arguments of a few words. */
const NAME = /^[A-Za-z0-9_]{1,32}$/;
const MAX_ARGS = 8;
const MAX_ARG = 64;

/** The HA user of the ingress session, by name ("alex", "user 01234567"); none standalone. */
export function commandUser(header: (name: string) => string | undefined): string | undefined {
  const by = requestUser(header);
  if (by === "local") return undefined;
  return by.startsWith("person:") ? by.slice("person:".length) : `user ${by.slice("user:".length)}`;
}

/**
 * POST api/command { name, args? }: 200 { reached } with the instances it reached,
 * 400 on a bad body, 403 outside ingress, 404 when no instance answers to it.
 */
export function mountCommand(
  app: Hono,
  deps: { mode: "addon" | "standalone"; command: (name: string, args: string[], from: CommandSource) => string[]; log?: (level: "info", msg: string) => void },
): void {
  app.post("/api/command", async (c) => {
    const peer = (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;
    if (!mayWrite(deps.mode, peer)) return c.json({ error: "Forbidden", reason: "commands through the Home Assistant panel only" }, 403);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; args?: unknown } | null;
    const args = body?.args ?? [];
    if (typeof body?.name !== "string" || !NAME.test(body.name) || !Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length > 0 && a.length <= MAX_ARG)) {
      return c.json({ error: "BadRequest", reason: 'body: { "name": "a_command", "args"?: ["word", ...] }' }, 400);
    }
    const name = body.name.toLowerCase();
    const user = commandUser((n) => c.req.header(n));
    const from: CommandSource = { channel: "panel", ...(user !== undefined ? { user } : {}) };
    const reached = deps.command(name, args as string[], from);
    deps.log?.("info", `panel: /${name}${args.length ? " " + args.join(" ") : ""} by ${user ?? "?"} → ${reached.length ? reached.join(", ") : "nobody"}`);
    if (reached.length === 0) return c.json({ error: "NotFound", reason: `no running instance answers /${name}` }, 404);
    return c.json({ reached });
  });
}
