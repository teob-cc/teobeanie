// pause.ts — the global pause: a command from the panel that stops every heuristic
// acting, and the command that lets them act again. Each is journaled with who gave it
// (the HA user of the ingress session), in a stream of its own, and the pause is folded
// from that stream at boot, so a restart keeps the house paused.
//
// While paused the SafeActuator refuses every call and every notice ("all heuristics
// paused"), but a guard's: the leak shutoff still closes the valve and says so.
// Heuristics keep deciding and journaling, so the Decisions tab shows what they would
// have done.

import {
  CategoryId,
  EntityId,
  andReply,
  categoryTypes,
  objectCodec,
  persist,
  reply,
  stampEnvelope,
  tagCodec,
  type Aggregate,
  type Codec,
  type EntityRuntime,
  type JournalReader,
} from "@lambda-house/teob-ts/core";
import type { Hono } from "hono";
import { mayWrite } from "./studio/files.js";

export const CONTROL_CATEGORY: CategoryId = CategoryId("teob-control");
export const PAUSE_ENTITY: EntityId = EntityId("pause");

export interface Paused {
  tag: "Paused";
  at: number;
  /** person:<name> (the HA user), user:<id prefix>, or "local" (standalone). */
  by: string;
  reason?: string;
}

export interface Resumed {
  tag: "Resumed";
  at: number;
  by: string;
}

export type PauseEvent = Paused | Resumed;

export type PauseCommand =
  | { tag: "Pause"; at: number; by: string; reason?: string }
  | { tag: "Resume"; at: number; by: string }
  | { tag: "Get" };

export interface PauseState {
  paused: boolean;
  /** The latest pause or resume: when, by whom, and the pause's reason. */
  at?: number;
  by?: string;
  reason?: string;
}

const ACTIVE: PauseState = { paused: false };

export function applyPause(_state: PauseState, e: PauseEvent): PauseState {
  return e.tag === "Paused"
    ? { paused: true, at: e.at, by: e.by, ...(e.reason !== undefined ? { reason: e.reason } : {}) }
    : { paused: false, at: e.at, by: e.by };
}

export const pauseAggregate: Aggregate<PauseCommand, PauseState, PauseEvent, PauseState> = {
  category: CONTROL_CATEGORY,
  initial: () => ACTIVE,
  async decide(state, cmd) {
    // Pausing what is paused (or resuming what runs) changes nothing: no event.
    if (cmd.tag === "Get" || (cmd.tag === "Pause") === state.paused) return reply(state);
    const event: PauseEvent =
      cmd.tag === "Pause"
        ? { tag: "Paused", at: cmd.at, by: cmd.by, ...(cmd.reason !== undefined ? { reason: cmd.reason } : {}) }
        : { tag: "Resumed", at: cmd.at, by: cmd.by };
    return andReply(persist(stampEnvelope(event, { origin: cmd.by })), applyPause(state, event));
  },
  apply: applyPause,
};

export const pauseEventCodec: Codec<PauseEvent> = tagCodec<PauseEvent>("Paused", "Resumed");
export const pauseStateCodec: Codec<PauseState> = objectCodec<PauseState>("PauseState");

/** The pause as the journal has it (up to `before`), folded the way the aggregate does. */
export function pauseFromJournal(journal: Pick<JournalReader, "queryEvents">, before = Infinity): PauseState {
  let state = ACTIVE;
  let cursor: number | undefined;
  for (;;) {
    const page = journal.queryEvents({ category: CONTROL_CATEGORY, entityId: PAUSE_ENTITY, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    for (const r of page) {
      const e = r.payload as PauseEvent | null;
      if (e?.tag !== "Paused" && e?.tag !== "Resumed") continue;
      if (e.at >= before) return state;
      state = applyPause(state, e);
    }
    if (page.length < 1000) return state;
    cursor = page.at(-1)!.globalSeq;
  }
}

export interface PauseControl {
  state(): PauseState;
  /** Journal the pause (or the resume), then set the actuator; the state after it. */
  set(paused: boolean, by: string, reason?: string): Promise<PauseState>;
}

/**
 * The pause over the journal and the actuator. The actuator is set from the journal
 * at once, before any heuristic can act, and after each journaled change.
 */
export function createPauseControl(deps: {
  runtime: Pick<EntityRuntime, "ask">;
  journal: Pick<JournalReader, "queryEvents">;
  actuator: { setPaused(paused: boolean): void };
  now?: () => number;
}): PauseControl {
  const now = deps.now ?? Date.now;
  const cat = categoryTypes<PauseCommand, PauseState>(CONTROL_CATEGORY);
  let current = pauseFromJournal(deps.journal);
  deps.actuator.setPaused(current.paused);
  let chain: Promise<unknown> = Promise.resolve();
  return {
    state: () => current,
    set(paused, by, reason) {
      const cmd: PauseCommand = paused ? { tag: "Pause", at: now(), by, ...(reason ? { reason } : {}) } : { tag: "Resume", at: now(), by };
      const run = chain.then(async () => {
        const res = await deps.runtime.ask(PAUSE_ENTITY, cmd, cat);
        if (!res.ok || res.value.reply === undefined) throw new Error(`pause: ${res.ok ? "no reply" : JSON.stringify(res.error)}`);
        current = res.value.reply;
        deps.actuator.setPaused(current.paused);
        return current;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** Who gave a panel command: the HA user of the ingress session, or "local" standalone. */
export function requestUser(header: (name: string) => string | undefined): string {
  const name = header("x-remote-user-display-name") ?? header("x-remote-user-name");
  if (name) return `person:${name}`;
  const id = header("x-remote-user-id");
  return id ? `user:${id.slice(0, 8)}` : "local";
}

const MAX_REASON = 200;

/** GET api/pause, and POST api/pause { paused, reason? } through Home Assistant ingress only. */
export function mountPause(app: Hono, deps: { mode: "addon" | "standalone"; pause: PauseControl }): void {
  app.get("/api/pause", (c) => c.json(deps.pause.state()));
  app.post("/api/pause", async (c) => {
    const peer = (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;
    if (!mayWrite(deps.mode, peer)) return c.json({ error: "Forbidden", reason: "pause through the Home Assistant panel only" }, 403);
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown; reason?: unknown } | null;
    if (typeof body?.paused !== "boolean") return c.json({ error: "BadRequest", reason: 'body: { "paused": true | false, "reason"?: string }' }, 400);
    if (body.reason !== undefined && typeof body.reason !== "string") return c.json({ error: "BadRequest", reason: "reason must be a string" }, 400);
    const reason = body.reason?.trim().slice(0, MAX_REASON);
    try {
      return c.json(await deps.pause.set(body.paused, requestUser((n) => c.req.header(n)), reason || undefined));
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
}
