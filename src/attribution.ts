// attribution.ts — who made an observed HA service call: Teobeanie itself, a person (an HA
// user), a system user (the Supervisor: other add-ons call HA as it, and so does Teobeanie),
// or nobody (no user id: a device, an integration, an automation).
//
// Teobeanie's own calls are recognised in memory at the moment the call_service event
// arrives, not from the journal: HA fires call_service BEFORE it answers the call, so
// the event usually comes in before ActionCompleted (and its context id) exists. The
// actuator therefore registers every call before sending it (service + entities), and
// the context id HA gives back once it returns. An event matches a pending request, or
// carries a context id Teobeanie owns; that context id also covers the calls HA makes on
// Teobeanie's behalf (homeassistant.turn_on, a script) whichever side of the answer they fall.

export type Origin = typeof OWN_ORIGIN | "device" | `person:${string}` | `system:${string}` | `user:${string}`;

/**
 * The `by` of Teobeanie's own calls. Journaled since before the product was named
 * Teobeanie, so it stays "teob"; panel and MCP show it as "Teobeanie".
 */
export const OWN_ORIGIN = "teob";

/** What ha-audit rows journaled before attribution carry (envelope origin, upcast `by`). */
export const LEGACY_ORIGIN = "nodered";

/** A request matches a call_service event for at most this long (a hung call is not Teobeanie's forever). */
export const REQUEST_WINDOW_MS = 5_000;
/** How long a context id stays Teobeanie's: long enough for a script Teobeanie started to finish. */
const CONTEXT_TTL_MS = 10 * 60_000;
const CONTEXT_CAP = 500;

export interface OwnCalls {
  /** Before the call is sent; the returned settle() takes HA's context id (none when it failed). */
  requested(domain: string, service: string, entities: string[]): (contextId?: string) => void;
  /**
   * Whether an observed call is Teobeanie's: its context id is one of Teobeanie's, or it is the
   * call a pending request is waiting for (same service, same entities). A match by
   * request is consumed and its context id remembered.
   */
  claim(e: { domain: string; service: string; entityIds: string[]; contextId: string | null }): boolean;
}

const sameSet = (a: string[], b: string[]): boolean => {
  const s = new Set(a);
  return s.size === new Set(b).size && b.every((x) => s.has(x));
};

export function createOwnCalls(now: () => number = Date.now): OwnCalls {
  const pending = new Set<{ domain: string; service: string; entities: string[]; at: number }>();
  /** context id → when Teobeanie got it; insertion order is age order. */
  const contexts = new Map<string, number>();

  const remember = (id: string): void => {
    contexts.delete(id);
    contexts.set(id, now());
    for (const [old, at] of contexts) {
      if (contexts.size <= CONTEXT_CAP && at > now() - CONTEXT_TTL_MS) break;
      contexts.delete(old);
    }
  };

  return {
    requested(domain, service, entities) {
      const req = { domain, service, entities, at: now() };
      pending.add(req);
      return (contextId) => {
        pending.delete(req);
        if (contextId !== undefined) remember(contextId);
      };
    },

    claim(e) {
      if (e.contextId !== null) {
        const at = contexts.get(e.contextId);
        if (at !== undefined && at > now() - CONTEXT_TTL_MS) return true;
      }
      for (const req of pending) {
        if (req.at <= now() - REQUEST_WINDOW_MS) {
          pending.delete(req);
          continue;
        }
        if (req.domain !== e.domain || req.service !== e.service || !sameSet(req.entities, e.entityIds)) continue;
        pending.delete(req);
        if (e.contextId !== null) remember(e.contextId);
        return true;
      }
      return false;
    },
  };
}

/** One row of HA's config/auth/list. */
export interface HaUser {
  id: string;
  name: string;
  system_generated: boolean;
}

/** person:<name>, system:<name>, or user:<id prefix> when the user is not known. */
export function userOrigin(userId: string, user: HaUser | undefined): Origin {
  if (user === undefined) return `user:${userId.slice(0, 8)}`;
  return user.system_generated ? `system:${user.name}` : `person:${user.name}`;
}

export interface UserDirectory {
  /** The origin of a call made as this HA user; waits for the first load of the list. */
  originOf(userId: string): Promise<Origin>;
  /** Re-read config/auth/list (on every reconnect: users may have changed meanwhile). */
  refresh(): Promise<void>;
}

/** An id missing from a loaded list triggers a re-read, at most this often (a new user). */
const UNKNOWN_REFRESH_MS = 60_000;

/**
 * HA users by id, from the websocket command config/auth/list (admin only). When the
 * command fails the list stays as it was (empty at first) and callers get user:<id
 * prefix>; the failure is logged once.
 */
export function createUserDirectory(deps: {
  send<T>(message: Record<string, unknown>): Promise<T>;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
}): UserDirectory {
  const now = deps.now ?? Date.now;
  let users = new Map<string, HaUser>();
  let loadedAt: number | undefined;
  let loading: Promise<void> | undefined;
  let warned = false;

  const refresh = (): Promise<void> => {
    loading ??= (async () => {
      try {
        const list = await deps.send<HaUser[]>({ type: "config/auth/list" });
        users = new Map(list.map((u) => [u.id, { id: u.id, name: u.name, system_generated: u.system_generated === true }]));
      } catch (err) {
        if (!warned) {
          warned = true;
          deps.log("warn", `config/auth/list failed (${err instanceof Error ? err.message : String(err)}): calls by HA users are attributed as user:<id>`);
        }
      } finally {
        loadedAt = now();
        loading = undefined;
      }
    })();
    return loading;
  };

  return {
    refresh,
    async originOf(userId) {
      if (loading !== undefined) await loading;
      else if (loadedAt === undefined || (!users.has(userId) && now() - loadedAt >= UNKNOWN_REFRESH_MS)) await refresh();
      return userOrigin(userId, users.get(userId));
    },
  };
}

/**
 * The origin of an observed call. The own-call check runs synchronously, when the
 * event arrives (before any await); only a user's name may take a round trip.
 */
export function createAttributor(deps: { own: OwnCalls; users: UserDirectory }) {
  return async (e: { domain: string; service: string; entityIds: string[]; contextId: string | null; userId: string | null }): Promise<Origin> => {
    if (deps.own.claim(e)) return OWN_ORIGIN;
    if (e.userId === null) return "device";
    return deps.users.originOf(e.userId);
  };
}
