// agents.ts — agent tokens: how an AI agent reaches the MCP tools on the add-on's own
// port, without Home Assistant ingress. An owner mints a token in the panel's Connect
// page (an HA admin's ingress session), gives it a name ("Claude Code on my laptop"),
// and sees it once. Only a salted hash is kept, in /data/agent-tokens.json; minting
// and revoking are journaled with who did it (`teob-access/agent-tokens`). A revoked
// token is refused from the next request on. When each token was last used is kept in
// memory only.
//
// A token reads `tbn_<id>_<secret>`: the id finds the stored hash, the secret is 32
// random bytes. Hashes are compared in constant time. Failed attempts are limited per
// client address.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  CategoryId,
  EntityId,
  categoryTypes,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  type Aggregate,
  type Codec,
  type EntityRuntime,
} from "@lambda-house/teob-ts/core";

export const ACCESS_CATEGORY: CategoryId = CategoryId("teob-access");
export const AGENT_TOKENS_ENTITY: EntityId = EntityId("agent-tokens");

/** The container port of the agent door (teobeanie/config.yaml `ports`). */
export const AGENT_PORT = 8199;

export interface AgentTokenMinted {
  tag: "AgentTokenMinted";
  at: number;
  id: string;
  name: string;
  /** person:<name> or user:<id prefix> (the panel's HA user), or "local" (standalone). */
  by: string;
}

export interface AgentTokenRevoked {
  tag: "AgentTokenRevoked";
  at: number;
  id: string;
  by: string;
}

export type AccessEvent = AgentTokenMinted | AgentTokenRevoked;
export type AccessCommand = { tag: "Record"; event: AccessEvent };

export const accessAggregate: Aggregate<AccessCommand, void, AccessEvent, { events: number }> = {
  category: ACCESS_CATEGORY,
  initial: () => ({ events: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag !== "Record") return done();
    return persist(stampEnvelope(cmd.event, { origin: cmd.event.by }));
  },
  apply: (state) => ({ events: state.events + 1 }),
};

export const accessEventCodec: Codec<AccessEvent> = tagCodec<AccessEvent>("AgentTokenMinted", "AgentTokenRevoked");
export const accessStateCodec: Codec<{ events: number }> = objectCodec<{ events: number }>("AccessState");

/** Journal a mint or a revocation; resolves once it is persisted. */
export function createAccessJournal(runtime: Pick<EntityRuntime, "ask">): (event: AccessEvent) => Promise<void> {
  const cat = categoryTypes<AccessCommand, void>(ACCESS_CATEGORY);
  return async (event) => {
    const res = await runtime.ask(AGENT_TOKENS_ENTITY, { tag: "Record", event }, cat);
    if (!res.ok) throw new Error(`access journal: ${JSON.stringify(res.error)}`);
  };
}

// ---- the tokens ----

/** A token as the panel lists it: never the secret, never the hash. */
export interface AgentTokenInfo {
  id: string;
  name: string;
  createdAt: number;
  by: string;
  /** The last request it authenticated since the add-on started; null: none yet. */
  lastUsedAt: number | null;
}

interface Stored {
  id: string;
  name: string;
  createdAt: number;
  by: string;
  /** hex */
  salt: string;
  /** sha256(salt ‖ secret), hex */
  hash: string;
}

export interface AgentTokens {
  list(): AgentTokenInfo[];
  /** A new token: stored as a hash, journaled; the token itself is in the answer only. */
  mint(name: string, by: string): Promise<{ token: string; info: AgentTokenInfo }>;
  /** Refused from the next request on; false when there is no such token. */
  revoke(id: string, by: string): Promise<boolean>;
  /** The token's record when the token is valid (and its last use set to now). */
  verify(token: string): AgentTokenInfo | undefined;
}

export const MAX_NAME = 80;
export const MAX_TOKENS = 50;
const TOKEN = /^tbn_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const hashOf = (salt: Buffer, secret: string): Buffer => createHash("sha256").update(salt).update(secret, "utf8").digest();

/** A name as given: trimmed, without control characters; an error for one that will not do. */
export function tokenName(name: unknown): string | { error: string } {
  if (typeof name !== "string") return { error: "name must be a string" };
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (clean === "") return { error: "give the token a name, such as the agent and the machine it runs on" };
  if (clean.length > MAX_NAME) return { error: `a name is at most ${MAX_NAME} characters` };
  return clean;
}

export function createAgentTokens(deps: {
  /** The file of the hashes (/data/agent-tokens.json); absent: in memory only (tests). */
  path?: string;
  /** Journals a mint or a revocation; a failure undoes the change. */
  record: (event: AccessEvent) => Promise<void>;
  now?: () => number;
}): AgentTokens {
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, Stored>();
  const lastUsed = new Map<string, number>();
  if (deps.path !== undefined && existsSync(deps.path)) {
    const stored = JSON.parse(readFileSync(deps.path, "utf8")) as { tokens?: Stored[] };
    for (const t of stored.tokens ?? []) tokens.set(t.id, t);
  }
  const save = (): void => {
    if (deps.path === undefined) return;
    const tmp = `${deps.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tokens: [...tokens.values()] }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, deps.path);
  };
  const info = (t: Stored): AgentTokenInfo => ({ id: t.id, name: t.name, createdAt: t.createdAt, by: t.by, lastUsedAt: lastUsed.get(t.id) ?? null });
  // Compared against when the id is unknown, so a miss takes as long as a wrong secret.
  const decoy = { salt: randomBytes(16), hash: randomBytes(32) };

  return {
    list: () => [...tokens.values()].sort((a, b) => a.createdAt - b.createdAt).map(info),

    async mint(name, by) {
      if (tokens.size >= MAX_TOKENS) throw new Error(`at most ${MAX_TOKENS} agent tokens: revoke one first`);
      let id = randomBytes(6).toString("hex");
      while (tokens.has(id)) id = randomBytes(6).toString("hex");
      const secret = randomBytes(32).toString("base64url");
      const salt = randomBytes(16);
      const stored: Stored = { id, name, createdAt: now(), by, salt: salt.toString("hex"), hash: hashOf(salt, secret).toString("hex") };
      tokens.set(id, stored);
      try {
        save();
        await deps.record({ tag: "AgentTokenMinted", at: stored.createdAt, id, name, by });
      } catch (err) {
        tokens.delete(id);
        try {
          save();
        } catch {
          // the file keeps a token nobody holds: harmless, it is never shown again
        }
        throw err;
      }
      return { token: `tbn_${id}_${secret}`, info: info(stored) };
    },

    async revoke(id, by) {
      const stored = tokens.get(id);
      if (stored === undefined) return false;
      // Gone before anything else, so the next request is refused whatever follows.
      tokens.delete(id);
      lastUsed.delete(id);
      save();
      await deps.record({ tag: "AgentTokenRevoked", at: now(), id, by });
      return true;
    },

    verify(token) {
      const m = TOKEN.exec(token);
      const stored = m === null ? undefined : tokens.get(m[1]!);
      const salt = stored !== undefined ? Buffer.from(stored.salt, "hex") : decoy.salt;
      const want = stored !== undefined ? Buffer.from(stored.hash, "hex") : decoy.hash;
      const got = hashOf(salt, m?.[2] ?? token);
      if (!timingSafeEqual(got, want) || stored === undefined) return undefined;
      lastUsed.set(stored.id, now());
      return info(stored);
    },
  };
}

// ---- failed attempts ----

export interface FailureLimiter {
  /** Whether the address has failed too often lately. */
  blocked(address: string): boolean;
  fail(address: string): void;
}

/** At most `max` failed attempts per address in `windowMs`; then refused until the oldest leaves the window. */
export function createFailureLimiter(opts: { max?: number; windowMs?: number; now?: () => number } = {}): FailureLimiter {
  const max = opts.max ?? 20;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();
  const recent = (address: string): number[] => {
    const cut = now() - windowMs;
    const kept = (failures.get(address) ?? []).filter((t) => t > cut);
    if (kept.length === 0) failures.delete(address);
    else failures.set(address, kept);
    return kept;
  };
  return {
    blocked: (address) => recent(address).length >= max,
    fail(address) {
      // Many addresses at once: forget the stale ones rather than grow.
      if (failures.size > 10_000) for (const a of [...failures.keys()]) recent(a);
      failures.set(address, [...recent(address), now()].slice(-max));
    },
  };
}
