// host.ts — runs heuristic instances: loads heuristics.json, compiles each instance's
// library definition into its journal stream (category = heuristic, entity = instance),
// claims actuated entities, and feeds instances their inputs: routed signals, a start
// on the first HA states snapshot, and declared HA triggers.
//
// Each instance runs in an entity runtime of its own over the shared journal, so a
// config reload (prepare, then commit) stops and starts only the instances that
// changed. Stopping a runtime cancels the instance's in-memory timers; the new one
// replays the stream and re-arms them, as after a restart.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CategoryId, EntityId, categoryTypes, type EntityRuntime, type Journal, type OnPersisted } from "@lambda-house/teob-ts/core";
import { createInMemoryRuntime, registration } from "@lambda-house/teob-ts/inmem";
import { normalizeState, type HaClient, type HaEntityState, type SignalRow } from "@lambda-house/teob-ts/ha";
import { commandArgs, outdoorEntities, type AnyHeuristic, type CommandSource, type HouseFacts, type Input, type Observed } from "./heuristic.js";
import type { Mode, SafeActuator } from "./actuator.js";
import { validateParams } from "./params.js";
import { notifyPerHourProblem } from "./instance-check.js";
import { DEFAULT_NOTIFY_PER_HOUR, compileHeuristic, type KCommand } from "./kernel.js";
import type { HouseScope } from "../allowlist.js";
import { instanceCard, type InstanceCard } from "./card.js";

export interface InstanceConfig {
  heuristic: string;
  id: string;
  mode?: Mode;
  params: unknown;
  /** Its notices also go to the alerts chat (the add-on option telegram_alerts_chat_id). */
  alerts?: boolean;
  /** Notifications per hour it may send, instead of the heuristic's own cap (a positive whole number). */
  notifyPerHour?: number;
  /** The bot's command menu: descriptions by command name, instead of the heuristic's. */
  commandHelp?: Record<string, string>;
}

/** An entry of the bot's command menu. */
export interface MenuCommand {
  command: string;
  description: string;
}

/** What a chat keyboard offers for a command with arguments (commandArg). */
export interface CommandKeyboard {
  /** Every first argument some instance answers for (the command's choices). */
  choices: string[];
  /** One row per acting instance; each button is the arguments it sends ("bedroom", "bedroom off"). */
  rows: string[][];
}

export interface InstanceInfo {
  key: string;
  heuristic: string;
  id: string;
  title: string;
  mode: Mode;
  configuredMode: Mode;
  watch: string[];
  reads: string[];
  actuates: string[];
  /** Entities another instance owns and shares, which this one operates too. */
  uses: string[];
  commands: string[];
  pattern?: string;
  triggers: string[];
  params: unknown;
  /** Its notices also go to the alerts chat. */
  alerts: boolean;
  /** The cap in force: the instance's own, else the heuristic's, else the kernel's. */
  notifyPerHour: number;
}

interface Instance {
  key: string;
  def: AnyHeuristic;
  id: string;
  params: unknown;
  mode: Mode;
  configuredMode: Mode;
  watch: string[];
  entities: string[];
  actuates: string[];
  uses: string[];
  commands: string[];
  /** Menu descriptions by command: the instance's own, else the heuristic's. */
  commandHelp: Record<string, string>;
  alerts: boolean;
  /** Its own cap, when heuristics.json sets one. */
  notifyPerHour?: number;
  /** Everything the instance was built from except its code: equal means unchanged. */
  fingerprint: string;
}

type Log = (level: "debug" | "info" | "warn" | "error", msg: string) => void;

/**
 * Put the general examples (examples/ in the repo) into the config folder once, as a
 * starting point. Never touches the user's own files: no heuristics.json means no
 * heuristics.
 */
export function seedConfigExamples(configDir: string, log: Log): void {
  const target = join(configDir, "examples");
  if (existsSync(target)) return;
  const source = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
  try {
    cpSync(source, target, { recursive: true });
    log("info", `wrote ${target}/ — copy a starter's files up one level and adapt the entity ids to enable heuristics`);
  } catch (err) {
    log("warn", `could not write ${target}: ${String(err)}`);
  }
}

/** Load CONFIG_DIR/heuristics.json. No file means no heuristics — never someone else's house. */
export function loadInstances(dataDir: string, log: Log): InstanceConfig[] {
  const path = join(dataDir, "heuristics.json");
  if (!existsSync(path)) {
    log("info", `no ${path} — no heuristics configured`);
    return [];
  }
  let parsed: { instances?: InstanceConfig[] };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { instances?: InstanceConfig[] };
  } catch (err) {
    throw new Error(`${path}: unparseable JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.instances)) throw new Error(`${path}: missing "instances" array`);
  return parsed.instances;
}

/** What a host runs: the library, heuristics.json's instances and the house they run in. */
export interface HostConfig {
  library: AnyHeuristic[];
  instances: InstanceConfig[];
  /** The house's scope: an instance that watches, reads or owns anything outside it is not started. */
  scope?: HouseScope;
  /** Facts every decision sees: where the outdoor conditions come from. */
  house?: HouseFacts;
}

/** How a reload changes the running set, by instance key. */
export interface ReloadChanges {
  added: string[];
  removed: string[];
  /** Restarted, because its code, mode, params or entities (the outdoor sources) changed. */
  changed: Array<{ key: string; why: "code" | "mode" | "params" | "alerts" | "notifyPerHour" | "entities" }>;
  unchanged: number;
}

/** A validated reload, not applied yet. */
export interface PreparedReload {
  changes: ReloadChanges;
  /** What the new set watches (to route), and whose attribute changes are signals. */
  watchedEntities: string[];
  attributeWatched: string[];
  /**
   * Swap the running set. Claims, routing and the instance list change before the
   * first await; then the replaced instances stop and the new ones start.
   */
  commit(): Promise<void>;
}

export interface HeuristicHost {
  /** Every entity some instance watches — must be routed by the bridge (on-change). */
  watchedEntities(): string[];
  /**
   * Entities whose attribute-only changes are signals too (an enforced setpoint, the
   * weather's outdoor readings): the bridge routes state changes only, so the caller
   * feeds these through attributeChanged().
   */
  attributeWatched(): string[];
  instances(): InstanceInfo[];
  /** Run the instances over this journal, each in an entity runtime of its own. */
  attach(journal: Journal, onPersisted?: OnPersisted): void;
  /** Deliver a named command to the instances that answer to it; returns their keys. */
  command(name: string, args: string[], from: CommandSource): string[];
  commandNames(): string[];
  /**
   * The bot's command menu: every command an active instance answers to, sorted. A
   * shadow instance answers too, but never replies, so its commands are not offered.
   */
  commandMenu(): MenuCommand[];
  /** The keyboard for a command with arguments, as the active instances stand now; none without. */
  commandKeyboard(name: string): CommandKeyboard | undefined;
  /** The card of every active and shadow instance whose heuristic has a view(), as it stands now. */
  cards(): InstanceCard[];
  onSignal(row: SignalRow): void;
  /** Call once the live cache holds the first full states snapshot. */
  start(ha: Pick<HaClient, "subscribeTrigger">): Promise<void>;
  /**
   * Plan a new config against the running set. Throws with the reason when any
   * instance would be left out or two would own one entity; nothing changes until
   * commit().
   */
  prepare(next: HostConfig): PreparedReload;
  stop(): Promise<void>;
}

interface Plan {
  instances: Instance[];
  /** Instances left out, with the reason. */
  problems: string[];
  claims: Array<[string, string[]]>;
  uses: Array<[string, string[]]>;
  forbids: Array<{ entity: string; service: string; reason: string }>;
  /** entity → keys of the instances it wakes; command → keys of the instances answering it. */
  watchers: Map<string, string[]>;
  commandees: Map<string, string[]>;
  /** command → the first arguments its instances answer for (commandArg), sorted. */
  choices: Map<string, string[]>;
  menu: MenuCommand[];
  attributeWatched: Set<string>;
}

/**
 * Resolve, scope-check and claim-check a config. A config mistake leaves the instance
 * out (a problem); two owners of one entity throws, as that is never safe.
 */
function planInstances(cfg: HostConfig, forceShadow: boolean): Plan {
  const defs = new Map(cfg.library.map((d) => [d.id, d]));
  const outdoor = outdoorEntities(cfg.house?.outdoor);
  const problems: string[] = [];
  const candidates: Instance[] = [];
  for (const c of cfg.instances) {
    const def = defs.get(c.heuristic);
    if (def === undefined) {
      problems.push(`unknown heuristic "${c.heuristic}" (instance ${c.id})`);
      continue;
    }
    const key = `${def.id}/${c.id}`;
    if (candidates.some((x) => x.key === key)) {
      problems.push(`duplicate instance ${key}`);
      continue;
    }
    const cap = notifyPerHourProblem(c.notifyPerHour);
    if (cap !== undefined) {
      problems.push(`${key}: ${cap}`);
      continue;
    }
    // Params against the heuristic's schema, before anything reads them.
    const invalid = validateParams(def, c.params);
    if (invalid.length > 0) {
      problems.push(`${key}: ${invalid.join("; ")}`);
      continue;
    }
    const configuredMode = c.mode ?? "shadow";
    const mode = forceShadow && configuredMode === "active" ? "shadow" : configuredMode;
    const watch = [...new Set([...def.watch(c.params), ...(def.usesOutdoor ? outdoor : [])])];
    const reads = def.reads?.(c.params) ?? [];
    const actuates = def.actuates(c.params);
    const uses = def.uses?.(c.params) ?? [];
    if (cfg.scope !== undefined) {
      const scope = cfg.scope;
      const unseen = [...watch, ...reads].filter((e) => !scope.observes(e));
      const unoperable = [...actuates, ...uses].filter((e) => !scope.operates(e));
      if (unseen.length > 0 || unoperable.length > 0) {
        problems.push(
          `${key} is outside the house scope (allowlist.json):` +
            (unseen.length > 0 ? ` not listed: ${[...new Set(unseen)].join(", ")};` : "") +
            (unoperable.length > 0 ? ` not "operate": ${unoperable.join(", ")}` : ""),
        );
        continue;
      }
    }
    const entities = [...new Set([...watch, ...reads, ...(def.usesOutdoor ? outdoor : [])])];
    const commands = def.commands?.(c.params) ?? [];
    const fingerprint = JSON.stringify([
      c.params, mode, configuredMode, watch, entities, actuates, uses, commands, c.alerts === true, c.notifyPerHour ?? null,
      def.shares?.(c.params) ?? [], def.forbids?.(c.params) ?? [], def.watchAttributes?.(c.params) ?? [],
      def.triggers?.(c.params) ?? {}, def.usesOutdoor ? (cfg.house?.outdoor ?? null) : null,
    ]);
    const commandHelp = { ...def.commandHelp?.(c.params), ...c.commandHelp };
    candidates.push({ key, def, id: c.id, params: c.params, configuredMode, mode, watch, entities, actuates, uses, commands, commandHelp, alerts: c.alerts === true, ...(c.notifyPerHour !== undefined ? { notifyPerHour: c.notifyPerHour } : {}), fingerprint });
  }

  // Owners first, then the instances that use what an owner shares (a press on a
  // momentary relay, a remote on an appliance another instance switches off).
  const owners = new Map<string, string>();
  const shared = new Set<string>();
  const forbids: Plan["forbids"] = [];
  for (const inst of candidates) {
    if (inst.mode === "off") continue;
    for (const e of inst.actuates) {
      const prev = owners.get(e);
      if (prev !== undefined && prev !== inst.key) throw new Error(`entity ${e} is claimed by both ${prev} and ${inst.key} — one owner per entity`);
      owners.set(e, inst.key);
    }
    for (const e of inst.def.shares?.(inst.params) ?? []) {
      if (!inst.actuates.includes(e)) throw new Error(`${inst.key} shares ${e}, which it does not own`);
      shared.add(e);
    }
    forbids.push(...(inst.def.forbids?.(inst.params) ?? []));
  }
  const plan: Plan = { instances: [], problems, claims: [], uses: [], forbids, watchers: new Map(), commandees: new Map(), choices: new Map(), menu: [], attributeWatched: new Set() };
  for (const inst of candidates) {
    const unshared = inst.uses.filter((e) => !shared.has(e));
    if (unshared.length > 0) {
      problems.push(`${inst.key} uses ${unshared.join(", ")}, which no running instance shares`);
      continue;
    }
    plan.instances.push(inst);
    if (inst.mode === "off") continue;
    plan.claims.push([inst.key, inst.actuates]);
    if (inst.uses.length > 0) plan.uses.push([inst.key, inst.uses]);
    for (const e of inst.watch) plan.watchers.set(e, [...(plan.watchers.get(e) ?? []), inst.key]);
    for (const c of inst.commands) plan.commandees.set(c, [...(plan.commandees.get(c) ?? []), inst.key]);
    for (const [c, arg] of Object.entries(inst.def.commandArg?.(inst.params) ?? {})) plan.choices.set(c, [...(plan.choices.get(c) ?? []), ...commandArgs(arg)].sort());
    for (const e of inst.def.watchAttributes?.(inst.params) ?? []) plan.attributeWatched.add(e);
    if (inst.def.usesOutdoor && cfg.house?.outdoor?.weather !== undefined) plan.attributeWatched.add(cfg.house.outdoor.weather);
    if (inst.mode !== "active") continue;
    for (const c of inst.commands) {
      if (!plan.menu.some((m) => m.command === c)) plan.menu.push({ command: c, description: inst.commandHelp[c] ?? inst.def.title });
    }
  }
  plan.menu.sort((a, b) => a.command.localeCompare(b.command));
  return plan;
}

/** One instance at run time. */
interface Running {
  inst: Instance;
  /** Its own entity runtime; none while off or before attach(). */
  runtime?: EntityRuntime;
  untrigger: Array<() => Promise<void>>;
  /** Cleared when a reload replaces or removes it: no input reaches it any more. */
  live: boolean;
  /** The heuristic's state as last seen by its runtime. */
  state?: unknown;
}

export function createHeuristicHost(
  opts: HostConfig & {
    actuator: SafeActuator;
    liveState: (entityId: string) => HaEntityState | undefined;
    /** Global dry run: active instances run as shadow. */
    forceShadow: boolean;
    log: Log;
    /** How often every instance is woken (crash recovery for timers). Default 2 min. */
    wakeIntervalMs?: number;
    /** The house's time zone, read at decision time (HA's configuration may arrive after boot). */
    timeZone?: () => string | undefined;
    /** An instance's state moved (or it decided on an input): its card may have changed. */
    onCardChange?: () => void;
  },
): HeuristicHost {
  let scope = opts.scope;
  let house: HouseFacts = opts.house ?? {};
  let plan = planInstances(opts, opts.forceShadow);
  // At boot a config mistake skips the instance rather than crash-looping the add-on.
  for (const p of plan.problems) opts.log("error", `heuristics.json: ${p} — skipped`);
  let running = new Map<string, Running>(plan.instances.map((inst) => [inst.key, { inst, untrigger: [], live: true }]));

  const claim = (p: Plan): void => {
    opts.actuator.resetClaims();
    for (const [key, entities] of p.claims) opts.actuator.claim(key, entities);
    for (const [key, entities] of p.uses) opts.actuator.allowUse(key, entities);
    for (const f of p.forbids) opts.actuator.forbid(f.entity, f.service, f.reason);
    // A guard protects the house: the global pause does not stop it.
    for (const i of p.instances) if (i.def.pattern === "guard" && i.mode !== "off") opts.actuator.exemptFromPause(i.key);
  };
  claim(plan);

  const observe = (entityId: string): Observed | undefined => {
    // Outside the scope an entity does not exist, for every read a decision makes.
    if (scope !== undefined && !scope.observes(entityId)) return undefined;
    const s = opts.liveState(entityId);
    if (s === undefined) return undefined;
    // Where attributes are the signal, they also date it.
    const since = Date.parse(plan.attributeWatched.has(entityId) ? s.last_updated : s.last_changed);
    return { value: normalizeState(s).value, state: s.state, since: Number.isFinite(since) ? since : 0, attributes: s.attributes };
  };
  // Decisions read the house facts of the latest reload, and the zone HA last gave.
  const liveHouse = {
    get outdoor() {
      return house.outdoor;
    },
    get timeZone() {
      return opts.timeZone?.() ?? house.timeZone;
    },
  } as HouseFacts;

  let journal: Journal | undefined;
  let onPersisted: OnPersisted | undefined;
  /** Set by start(): the first states snapshot is in, inputs flow. */
  let ha: Pick<HaClient, "subscribeTrigger"> | undefined;
  let wakeTimer: ReturnType<typeof setInterval> | undefined;

  const boot = (r: Running): void => {
    if (journal === undefined || r.runtime !== undefined || r.inst.mode === "off") return;
    const inst = r.inst;
    const c = compileHeuristic(inst.def, {
      instance: (id) => (id === inst.id ? inst : undefined),
      observe,
      actuator: opts.actuator,
      log: opts.log,
      house: liveHouse,
      onState: (s) => {
        r.state = s;
        if (inst.def.view !== undefined) opts.onCardChange?.();
      },
    });
    r.runtime = createInMemoryRuntime([registration(c.aggregate, c.eventCodec, c.stateCodec)], {
      journal,
      ...(onPersisted !== undefined ? { onPersisted } : {}),
    }).runtime;
  };

  const send = (r: Running | undefined, input: Input | "wake"): void => {
    if (r === undefined || !r.live || r.runtime === undefined) return;
    const cmd: KCommand = input === "wake" ? { tag: "Wake" } : { tag: "Input", input };
    r.runtime.tell(EntityId(r.inst.id), cmd, categoryTypes<KCommand, void>(CategoryId(r.inst.def.id))).catch((err) =>
      opts.log("error", `${r.inst.key}: ${String(err)}`),
    );
  };

  const subscribe = async (r: Running): Promise<void> => {
    if (ha === undefined || r.inst.mode === "off") return;
    for (const [trigger, spec] of Object.entries(r.inst.def.triggers?.(r.inst.params) ?? {})) {
      try {
        const off = await ha.subscribeTrigger(spec, (vars) => send(r, { kind: "trigger", at: Date.now(), trigger, data: vars }));
        if (r.live) r.untrigger.push(off);
        else await off();
      } catch (err) {
        opts.log("error", `${r.inst.key}: cannot subscribe trigger ${trigger}: ${String(err)}`);
      }
    }
  };

  /** Stop an instance: no more inputs, its triggers unsubscribed, its runtime (and timers) gone. */
  const halt = async (r: Running): Promise<void> => {
    r.live = false;
    const offs = r.untrigger.splice(0);
    await Promise.all(offs.map((off) => off().catch((err) => opts.log("warn", `${r.inst.key}: unsubscribe trigger: ${String(err)}`))));
    await r.runtime?.shutdown();
  };

  const all = (): Running[] => [...running.values()];

  return {
    watchedEntities: () => [...plan.watchers.keys()],

    attributeWatched: () => [...plan.attributeWatched],

    instances: () =>
      all().map(({ inst: i }) => ({
        key: i.key,
        heuristic: i.def.id,
        id: i.id,
        title: i.def.title,
        mode: i.mode,
        configuredMode: i.configuredMode,
        watch: i.watch,
        reads: i.entities.filter((e) => !i.watch.includes(e)),
        actuates: i.actuates,
        uses: i.uses,
        commands: i.commands,
        ...(i.def.pattern !== undefined ? { pattern: i.def.pattern } : {}),
        triggers: Object.keys(i.def.triggers?.(i.params) ?? {}),
        params: i.params,
        alerts: i.alerts,
        notifyPerHour: i.notifyPerHour ?? i.def.notifyPerHour ?? DEFAULT_NOTIFY_PER_HOUR,
      })),

    attach(j, persisted) {
      journal = j;
      onPersisted = persisted;
      for (const r of all()) boot(r);
    },

    command(name, args, from) {
      const to = ha !== undefined ? (plan.commandees.get(name) ?? []) : [];
      const choices = plan.choices.get(name);
      for (const key of to) send(running.get(key), { kind: "command", at: Date.now(), command: name, args, from, ...(choices !== undefined ? { choices } : {}) });
      return to;
    },

    commandNames: () => [...plan.commandees.keys()].sort(),

    commandMenu: () => plan.menu.map((m) => ({ ...m })),

    commandKeyboard(name) {
      const choices = plan.choices.get(name);
      if (choices === undefined) return undefined;
      const rows: Array<[string, string[]]> = [];
      for (const key of plan.commandees.get(name) ?? []) {
        const r = running.get(key);
        if (r === undefined || r.inst.mode !== "active") continue;
        const args = commandArgs(r.inst.def.commandArg?.(r.inst.params)[name]);
        if (args.length === 0) continue;
        const state = r.state ?? r.inst.def.initial(r.inst.params);
        rows.push([args[0]!, r.inst.def.commandButtons?.(r.inst.params, state)[name] ?? args]);
      }
      // In the order of the choices, as the instances' own replies list them.
      rows.sort(([a], [b]) => choices.indexOf(a) - choices.indexOf(b));
      return rows.length > 0 ? { choices, rows: rows.map(([, buttons]) => buttons) } : undefined;
    },

    cards: () =>
      all().flatMap(({ inst, state }) =>
        inst.mode === "off" || inst.def.view === undefined
          ? []
          : [instanceCard(inst.def, { key: inst.key, id: inst.id, params: inst.params, mode: inst.mode, entities: inst.entities, commands: inst.commands }, state, observe)],
      ),

    onSignal(row) {
      // Boot baselines arrive before start(); the start input reconciles them instead.
      if (ha === undefined) return;
      const raw = row.raw as Partial<HaEntityState> | null;
      for (const key of plan.watchers.get(row.entityId) ?? []) {
        send(running.get(key), {
          kind: "signal",
          at: row.at,
          obsId: row.obsId,
          entity: row.entityId,
          value: row.normalized.value,
          state: typeof raw?.state === "string" ? raw.state : "unavailable",
          origin: row.origin,
          ...(typeof raw?.context?.user_id === "string" ? { user: raw.context.user_id } : {}),
        });
      }
    },

    async start(client) {
      if (ha !== undefined) return;
      ha = client;
      const at = Date.now();
      const now = all();
      for (const r of now) send(r, { kind: "start", at });
      for (const r of now) await subscribe(r);
      opts.log("info", `heuristics started: ${all().map((r) => `${r.inst.key}=${r.inst.mode}`).join(", ") || "none"}`);
      // Recreate any instance that crashed, so its journaled timers are re-armed.
      wakeTimer = setInterval(() => {
        for (const r of all()) send(r, "wake");
      }, opts.wakeIntervalMs ?? 120_000);
      wakeTimer.unref?.();
    },

    prepare(next) {
      const p = planInstances(next, opts.forceShadow);
      if (p.problems.length > 0) throw new Error(p.problems.join("; "));
      const base = running;
      const keys = new Set(p.instances.map((i) => i.key));
      const same = (old: Instance | undefined, inst: Instance): boolean => old !== undefined && old.def === inst.def && old.fingerprint === inst.fingerprint;
      const changes: ReloadChanges = { added: [], removed: [...base.keys()].filter((k) => !keys.has(k)), changed: [], unchanged: 0 };
      for (const inst of p.instances) {
        const old = base.get(inst.key)?.inst;
        if (old === undefined) changes.added.push(inst.key);
        else if (same(old, inst)) changes.unchanged++;
        else {
          const why =
            old.def !== inst.def ? "code"
            : old.configuredMode !== inst.configuredMode || old.mode !== inst.mode ? "mode"
            : JSON.stringify(old.params) !== JSON.stringify(inst.params) ? "params"
            : old.alerts !== inst.alerts ? "alerts"
            : old.notifyPerHour !== inst.notifyPerHour ? "notifyPerHour"
            : "entities";
          changes.changed.push({ key: inst.key, why });
        }
      }
      return {
        changes,
        watchedEntities: [...p.watchers.keys()],
        attributeWatched: [...p.attributeWatched],
        async commit() {
          if (running !== base) throw new Error("the running set changed since this reload was prepared");
          const nextRunning = new Map<string, Running>();
          const stopping: Running[] = [];
          const starting: Running[] = [];
          for (const inst of p.instances) {
            const old = base.get(inst.key);
            if (old !== undefined && same(old.inst, inst)) {
              nextRunning.set(inst.key, old);
              continue;
            }
            if (old !== undefined) stopping.push(old);
            const r: Running = { inst, untrigger: [], live: true };
            nextRunning.set(inst.key, r);
            starting.push(r);
          }
          for (const [key, old] of base) if (!keys.has(key)) stopping.push(old);
          for (const r of stopping) r.live = false;
          scope = next.scope;
          house = next.house ?? {};
          plan = p;
          running = nextRunning;
          claim(p);
          await Promise.all(stopping.map(halt));
          // Each starts on its own stream: the runtime replays it and re-arms its
          // timers, and the start input reconciles it with the house as it is now.
          const at = Date.now();
          for (const r of starting) {
            if (!r.live) continue;
            boot(r);
            if (ha !== undefined) send(r, { kind: "start", at });
          }
          await Promise.all(starting.filter((r) => r.live).map(subscribe));
        },
      };
    },

    async stop() {
      if (wakeTimer !== undefined) clearInterval(wakeTimer);
      await Promise.all(all().map(halt));
    },
  };
}

