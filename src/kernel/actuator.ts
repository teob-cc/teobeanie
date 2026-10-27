// actuator.ts — the single actuation choke point. Every action a heuristic decides
// passes vet() (inside the decision, so the verdict is journaled with it) and, in
// active mode only, execute(). Bounds and ownership are code, not configuration a
// heuristic can widen; the house may narrow them (allowlist.json "bounds").

import type { OwnCalls } from "../attribution.js";
import type { Action, HouseBound, Json } from "./heuristic.js";

export type Mode = "off" | "shadow" | "active";

export type Verdict = { ok: true } | { ok: false; reason: string };

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  /** HA context id of the service call — correlates with the call_service audit stream. */
  haContextId?: string;
}

/** A service data field's range for the entities with an id prefix ("climate.", "temperature"). */
export type Bound = HouseBound;

export const DEFAULT_BOUNDS: Bound[] = [
  { entityPrefix: "climate.", field: "temperature", min: 15, max: 27 },
  { entityPrefix: "light.", field: "brightness_pct", min: 0, max: 100 },
  { entityPrefix: "cover.", field: "position", min: 0, max: 100 },
  { entityPrefix: "fan.", field: "percentage", min: 0, max: 100 },
];

export interface ActuatorPolicy {
  /** Max service calls per entity per hour (default 30). */
  callsPerEntityPerHour?: number;
  bounds?: Bound[];
}

export interface CallGatewayLike {
  callService(req: {
    domain: string;
    service: string;
    serviceData?: Record<string, unknown>;
    target?: { entity_id?: string | string[] };
  }): Promise<{ context: { id: string } }>;
}

export interface Notifier {
  /** from: the instance whose notice it is (absent for Teobeanie's own messages, replies to a command and reports). */
  send(text: string, from?: string): Promise<void>;
  /** It retries a failed send itself (per chat, so no chat gets a message twice): execute() does not. */
  retriesItself?: boolean;
}

export interface SafeActuator {
  /** Ownership claims, validated at boot: one owner per entity. */
  claim(instanceKey: string, entities: string[]): void;
  /** Let an instance operate entities another instance owns and shares (checked by the host). */
  allowUse(instanceKey: string, entities: string[]): void;
  /** A service no heuristic may ever call on this entity (e.g. reopening a shut-off valve). */
  forbid(entity: string, service: string, reason: string): void;
  /**
   * `dry`: judge it without the rate windows, neither checked nor counted. A shadow twin
   * vets as its original this way (host.ts): it never calls, so it spends none of the
   * original's budget, and its verdicts do not hang on which of the two decided first.
   */
  vet(instanceKey: string, action: Action, now: number, notifyPerHour: number, dry?: boolean): Verdict;
  execute(action: Action, from?: string): Promise<ActionOutcome>;
  /**
   * An instance that protects the house (pattern "guard": the leak shutoff) acts through
   * the pause: pausing the heuristics must never leave a leak running.
   */
  exemptFromPause(instanceKey: string): void;
  /** Drop every claim, use, forbid and pause exemption, for a config reload to claim afresh. Rate windows and the pause stay. */
  resetClaims(): void;
  /** Global pause (journaled by pause.ts): every action vets as refused while set, but an exempt instance's. */
  setPaused(paused: boolean): void;
  paused(): boolean;
  owners(): ReadonlyMap<string, string>;
}

export function createSafeActuator(deps: {
  ha: CallGatewayLike;
  notifier?: Notifier;
  policy?: ActuatorPolicy;
  /**
   * The bounds as they stand now: the code's, then the house's (allowlist.json), read at
   * every vet so a reload applies. Every matching bound must pass. Default: policy.bounds,
   * else DEFAULT_BOUNDS.
   */
  bounds?: () => readonly Bound[];
  /** The house's operation scope: no call on anything outside it, whoever owns it. */
  scope?: { operates(entityId: string): boolean };
  /** Told of every call before it is sent, so the call_service audit can attribute it to Teobeanie. */
  ownCalls?: OwnCalls;
  /**
   * A call or notice that fails is tried once more after this long (default 5000 ms; 0 =
   * never): cloud devices and the chat reject the odd request. Not for errors another
   * try cannot fix (an unknown service or entity, a malformed request).
   */
  retryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): SafeActuator {
  const owners = new Map<string, string>();
  /** entity → instances that may operate it besides its owner. */
  const users = new Map<string, Set<string>>();
  const forbidden = new Map<string, string>(); // "entity service" → reason
  /** Instances the pause does not stop. */
  const exempt = new Set<string>();
  const bounds = deps.bounds ?? ((): readonly Bound[] => deps.policy?.bounds ?? DEFAULT_BOUNDS);
  const perEntityPerHour = deps.policy?.callsPerEntityPerHour ?? 30;
  const retryAfterMs = deps.retryAfterMs ?? 5000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Rolling windows of accepted action times, per key. */
  const windows = new Map<string, number[]>();
  let paused = false;

  const admit = (key: string, now: number, limit: number, dry = false): boolean => {
    if (dry) return true;
    const recent = (windows.get(key) ?? []).filter((t) => t > now - 3_600_000);
    if (recent.length >= limit) {
      windows.set(key, recent);
      return false;
    }
    recent.push(now);
    windows.set(key, recent);
    return true;
  };

  return {
    claim(instanceKey, entities) {
      for (const e of entities) {
        const prev = owners.get(e);
        if (prev !== undefined && prev !== instanceKey) {
          throw new Error(`entity ${e} is claimed by both ${prev} and ${instanceKey} — one owner per entity`);
        }
        owners.set(e, instanceKey);
      }
    },

    allowUse(instanceKey, entities) {
      for (const e of entities) users.set(e, new Set([...(users.get(e) ?? []), instanceKey]));
    },

    vet(instanceKey, action, now, notifyPerHour, dry = false) {
      if (paused && !exempt.has(instanceKey)) return { ok: false, reason: "all heuristics paused" };
      if (action.kind === "notify") {
        if (!admit(`notify:${instanceKey}`, now, notifyPerHour, dry)) {
          return { ok: false, reason: `notification rate limit (${notifyPerHour}/h)` };
        }
        return { ok: true };
      }
      const [domain, service] = action.service.split(".");
      if (!domain || !service) return { ok: false, reason: `malformed service "${action.service}"` };
      if (service === "toggle") return { ok: false, reason: "toggle is banned: only absolute-state services retry safely" };
      if (action.entities.length === 0) return { ok: false, reason: "no target entity" };
      for (const e of action.entities) {
        if (deps.scope !== undefined && !deps.scope.operates(e)) {
          return { ok: false, reason: `${e} is outside the house's operation scope` };
        }
        const owner = owners.get(e);
        if (owner !== instanceKey && !(owner !== undefined && users.get(e)?.has(instanceKey))) {
          return { ok: false, reason: owner === undefined ? `${e} is not claimed by ${instanceKey}` : `${e} is owned by ${owner}` };
        }
        const denied = forbidden.get(`${e} ${action.service}`);
        if (denied !== undefined) return { ok: false, reason: denied };
        for (const b of bounds()) {
          if (!e.startsWith(b.entityPrefix)) continue;
          const v = action.data?.[b.field];
          if (v === undefined) continue;
          if (typeof v !== "number" || v < b.min || v > b.max) {
            return { ok: false, reason: `${b.field}=${JSON.stringify(v)} outside ${b.min}–${b.max} for ${e}` };
          }
        }
      }
      for (const e of action.entities) {
        if (!admit(`call:${e}`, now, perEntityPerHour, dry)) {
          return { ok: false, reason: `rate limit: ${e} already actuated ${perEntityPerHour}× in the last hour` };
        }
      }
      return { ok: true };
    },

    async execute(action, from) {
      const first = await attempt(action, from);
      if (first.ok || retryAfterMs <= 0 || !retriable(first.error)) return first;
      if (action.kind === "notify" && deps.notifier?.retriesItself) return first;
      await sleep(retryAfterMs);
      if (paused && !(from !== undefined && exempt.has(from))) return { ...first, error: `${first.error} (not retried: paused)` };
      const second = await attempt(action, from);
      return second.ok ? second : { ...second, error: `${second.error} (also after a retry)` };
    },

    forbid(entity, service, reason) {
      forbidden.set(`${entity} ${service}`, reason);
    },

    exemptFromPause(instanceKey) {
      exempt.add(instanceKey);
    },

    resetClaims() {
      owners.clear();
      users.clear();
      forbidden.clear();
      exempt.clear();
    },

    setPaused(p) {
      paused = p;
    },

    paused: () => paused,

    owners: () => owners,
  };

  /** One try of an action: what HA (or the chat) said. */
  async function attempt(action: Action, from: string | undefined): Promise<ActionOutcome> {
    try {
      if (action.kind === "notify") {
        if (deps.notifier === undefined) return { ok: false, error: "no notifier configured (telegram_bot_token/telegram_chat_id)" };
        // The alerts chat is for what may need someone to act: not a reply to a command, not a report.
        await deps.notifier.send(action.text, action.reply === true || action.info === true ? undefined : from);
        return { ok: true };
      }
      const [domain, service] = action.service.split(".") as [string, string];
      const settle = deps.ownCalls?.requested(domain, service, action.entities);
      try {
        const res = await deps.ha.callService({
          domain,
          service,
          ...(action.data !== undefined ? { serviceData: action.data as Record<string, Json> } : {}),
          target: { entity_id: action.entities },
        });
        settle?.(res.context.id);
        return { ok: true, haContextId: res.context.id };
      } catch (err) {
        settle?.();
        throw err;
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  }
}

/**
 * Telegram Bot API sender (sendMessage only; the command lane is src/telegram.ts). Every
 * message goes to the chat; an instance's notices also go to the alerts chat when
 * toAlerts says so: a chat for watching the house, where nobody acts. Each chat gets
 * one more try after a failure, on its own, so the other never sees a message twice.
 */
export function createTelegramNotifier(opts: {
  token: string;
  chatId: string;
  alertsChatId?: string;
  toAlerts?: (from: string) => boolean;
  retryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Notifier {
  const f = opts.fetchImpl ?? fetch;
  const retryAfterMs = opts.retryAfterMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sendTo = async (chatId: string, text: string): Promise<void> => {
    const res = await f(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${await res.text()}`);
  };
  const withRetry = async (chatId: string, text: string): Promise<string | undefined> => {
    try {
      await sendTo(chatId, text);
      return undefined;
    } catch (err) {
      const first = (err as Error).message ?? String(err);
      if (retryAfterMs <= 0 || !retriable(first)) return first;
      await sleep(retryAfterMs);
      try {
        await sendTo(chatId, text);
        return undefined;
      } catch (err2) {
        return `${(err2 as Error).message ?? String(err2)} (also after a retry)`;
      }
    }
  };
  return {
    retriesItself: true,
    async send(text, from) {
      const alerts = opts.alertsChatId && from !== undefined && opts.toAlerts?.(from) ? opts.alertsChatId : undefined;
      const [main, other] = await Promise.all([withRetry(opts.chatId, text), alerts !== undefined ? withRetry(alerts, text) : undefined]);
      const failed = [main, other !== undefined ? `${other} (alerts chat)` : undefined].filter((e): e is string => e !== undefined);
      if (failed.length > 0) throw new Error(failed.join("; "));
    },
  };
}

/** An error another try may get past: not an unknown service or entity, not a malformed request. */
export function retriable(error: string | undefined): boolean {
  if (error === undefined) return false;
  return !/not found|unknown (service|entity)|invalid|extra keys|not allowed|unauthori[sz]ed|forbidden|telegram sendMessage 4\d\d/i.test(error);
}
