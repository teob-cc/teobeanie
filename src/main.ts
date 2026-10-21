// main.ts — composition root: HA firehose → signals ring + call_service audit
// journal → projections → read API + SSE; heuristic instances (heuristics.json) decide
// on routed signals and actuate only through the SafeActuator (shadow unless enabled).
// The config folder's files reload in-process (reload.ts); add-on options need a restart.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { categoryTypes, ulid, type OnPersisted } from "@lambda-house/teob-ts/core";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import {
  createProjectionRunner,
  createSqliteProjectionStore,
  type ProjectionRunner,
} from "@lambda-house/teob-ts/projection";
import { createReadApi, createStreamBus, journalFrame, type StreamFrame } from "@lambda-house/teob-ts/http";
import {
  createHaBridge,
  createHaClient,
  createSignalStore,
  normalizeState,
  type HaBridge,
  type HaClient,
  type HaStatesSnapshot,
  type RouteSpec,
  type SignalRow,
} from "@lambda-house/teob-ts/ha";
import { OUTDOOR_ATTRIBUTES, type HouseFacts } from "./kernel/heuristic.js";
import { loadConfig } from "./config.js";
import { liveScope, loadAllowlist, type Allowlist } from "./allowlist.js";
import {
  AUDIT_CATEGORY,
  AUDIT_ENTITY,
  auditAggregate,
  auditEventCodec,
  auditStateCodec,
  type AuditCommand,
  type AuditReply,
} from "./audit.js";
import { createAttributor, createOwnCalls, createUserDirectory } from "./attribution.js";
import { noderedTimeline } from "./projections.js";
import { buildTiles, checkTileCoverage, loadHouseConfig } from "./tiles.js";
import { createHouseService, type HouseConfig } from "./house/service.js";
import { applyConfig, createReloader, watchConfig } from "./reload.js";
import { startServer, type HealthReport } from "./server.js";
import { installStarter, loadLibrary, type PackageInfo } from "./packages/library.js";
import { createSafeActuator, createTelegramNotifier } from "./kernel/actuator.js";
import { createTelegramReceiver } from "./telegram.js";
import { createHeuristicHost, loadInstances, seedConfigExamples } from "./kernel/host.js";
import { createDeviceResolver } from "./devices.js";
import { createMonitor, type Monitor } from "./monitor.js";
import { houseZone, isTimeZone } from "./kernel/clock.js";
import { currentCaller, mountMcp } from "./mcp/index.js";
import { mcpNetworks as resolveMcpNetworks, networks } from "./mcp/access.js";
import { MCP_CATEGORY, MCP_ENTITY, mcpAuditAggregate, mcpEventCodec, mcpStateCodec, type McpCommand } from "./mcp/journal.js";
import { INSTRUCTIONS, createHouseTools } from "./mcp/tools.js";
import { createHouseRecord } from "./mcp/timeline.js";
import { createPauseControl, pauseAggregate, pauseEventCodec, pauseStateCodec } from "./pause.js";
import { configAggregate, configEventCodec, configStateCodec, createConfigJournal } from "./working-set.js";

const LEVELS = ["debug", "info", "warning", "error"] as const;

// 1. Config + logger.
const config = loadConfig();
const minLevel = LEVELS.indexOf(config.options.log_level);
const log = (level: string, msg: string): void => {
  if (LEVELS.indexOf(level as (typeof LEVELS)[number]) < minLevel) return;
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
};
/** teob-ts components log "warn"; the add-on log convention is "warning". */
const haLog = (level: "debug" | "info" | "warn" | "error", msg: string): void =>
  log(level === "warn" ? "warning" : level, msg);

const startedAt = Date.now();
log("info", `starting Teobeanie in ${config.mode} mode (shadow=${config.options.shadow_mode})`);

// 2. Allowlist and tiles.json. Both are reloaded live with heuristics.json (step 10b):
// the scope and house facts handed out below always answer from the current ones.
seedConfigExamples(config.configDir, haLog);
// The behaviour packages: every starter package missing from <config>/packages is copied
// in (one the house removed only when heuristics.json needs it), one that is there is
// never overwritten, and teobeanie.lock.json records origin, version and hash.
try {
  const installed = installStarter(config.configDir, { log: haLog });
  if (installed.installed.length > 0) log("info", `packages installed from the starter set: ${installed.installed.join(", ")}`);
} catch (err) {
  log("error", `could not install the starter packages into ${join(config.configDir, "packages")}: ${String(err)}`);
}
let allowlist = loadAllowlist(config.configDir, log);
log(
  "info",
  `house scope: ${allowlist.scope.observed.length} entities observed, ${allowlist.scope.operated.length} operable (policyVersion ${allowlist.policyVersion})`,
);
let { tiles, groups } = loadHouseConfig(config.configDir, log);
checkTileCoverage(tiles, allowlist.routes.map((r) => r.entityId), log);
const scope = liveScope(() => allowlist.scope);

// 2a. The house's time zone: the time_zone option, else HA's configuration (get_config
// on every connect, step 8), else UTC until HA has said (clock.ts FALLBACK_TZ).
const zoneOption = config.options.time_zone.trim();
if (zoneOption !== "" && !isTimeZone(zoneOption)) log("warning", `time_zone "${zoneOption}" is not a known time zone — using Home Assistant's`);
let haZone: string | undefined;
const timeZone = (): string | undefined => (isTimeZone(zoneOption) ? zoneOption : haZone);
const houseFacts = {
  get outdoor() {
    return allowlist.house.outdoor;
  },
  get timeZone() {
    return timeZone();
  },
} as HouseFacts;

// 2b. HA client (connects at step 9) + SafeActuator + heuristic host. Every entity a
// heuristic watches is routed on-change unless the allowlist already routes it.
const ha = createHaClient({ url: config.haWsUrl, token: config.haToken, log: haLog });
const { telegram_bot_token: tgToken, telegram_chat_id: tgChat, telegram_alerts_chat_id: tgAlerts } = config.options;
// Notices of instances marked "alerts" also go to the alerts chat (the host is created below).
const notifier =
  tgToken && tgChat
    ? createTelegramNotifier({
        token: tgToken,
        chatId: tgChat,
        ...(tgAlerts ? { alertsChatId: tgAlerts } : {}),
        toAlerts: (from) => heuristics.instances().some((i) => i.key === from && i.alerts),
      })
    : undefined;
if (tgAlerts && notifier !== undefined) log("info", `telegram: notices of instances marked "alerts" also go to ${tgAlerts}`);
// The actuator registers each call here before sending it, so the audit (step 8) knows Teobeanie's own.
const ownCalls = createOwnCalls();
const actuator = createSafeActuator({
  ha,
  scope,
  ownCalls,
  ...(notifier !== undefined ? { notifier } : {}),
});
// The bridge is created at step 9 (and replaced when a reload changes the routes);
// decisions only read it after start().
let bridgeRef: HaBridge | undefined;
// The library the running set was loaded with: a reload reads the house's own again.
// The image ships no heuristics: they are the config folder's packages (copied in from
// the starter set at step 2) and its own heuristics/ files.
const loadedLibrary = await loadLibrary(config.configDir, haLog);
let library = loadedLibrary.heuristics;
let packages: PackageInfo[] = loadedLibrary.packages;
// The facts (derived state, kernel/fact.ts) and the files they come from.
let libraryFacts = loadedLibrary.facts;
let factSources = loadedLibrary.factSources;
// The House view (step 9b) follows the instances' cards and the facts; it exists only after the host.
let cardsChanged = (): void => {};
let factsChanged = (): void => {};
const heuristics = createHeuristicHost({
  library,
  facts: loadedLibrary.facts,
  instances: loadInstances(config.configDir, haLog),
  actuator,
  liveState: (entityId) => bridgeRef?.liveState(entityId),
  scope: allowlist.scope,
  house: allowlist.house,
  forceShadow: config.options.shadow_mode,
  log: haLog,
  timeZone,
  onCardChange: () => cardsChanged(),
  onFactChange: () => factsChanged(),
});
const routesFor = (al: Allowlist, watched: string[]): RouteSpec[] => {
  const out: RouteSpec[] = [...al.routes];
  for (const entityId of watched) {
    if (!out.some((r) => r.entityId === entityId)) out.push({ entityId, debounce: "on-change" });
  }
  return out;
};
let routes = routesFor(allowlist, heuristics.watchedEntities());
log("info", `heuristics: ${heuristics.instances().length} instances, ${routes.length - allowlist.routes.length} extra routed entities`);

// 3. Stream bus (SSE fan-out).
const bus = createStreamBus();

// 4. Projection runner is created at step 7, the monitor at 5a; the persist hook closes over these lets.
let projectionRunner: ProjectionRunner | undefined;
let monitor: Monitor | undefined;

// 5. Sqlite runtime + audit aggregates; post-persist hook feeds SSE, nudges projections
// and shows the monitor every batch. Heuristic instances run in runtimes of their own
// over the same journal (host.ts).
const journalPath = join(config.dataDir, "journal.db");
const onPersisted: OnPersisted = (batch) => {
  bus.publish(journalFrame(batch));
  projectionRunner?.nudge();
  monitor?.onPersisted(batch);
};
const { runtime, journal } = createSqliteRuntime({ path: journalPath, onPersisted }, [
  registration(auditAggregate, auditEventCodec, auditStateCodec),
  registration(mcpAuditAggregate, mcpEventCodec, mcpStateCodec),
  registration(pauseAggregate, pauseEventCodec, pauseStateCodec),
  registration(configAggregate, configEventCodec, configStateCodec),
]);
// The global pause, folded from the journal before any instance can act (a recovered
// notice is resent through the actuator too).
const pause = createPauseControl({ runtime, journal, actuator });
if (pause.state().paused) log("warning", `all heuristics paused (by ${pause.state().by ?? "?"}): only guards act until resumed`);
heuristics.attach(journal, onPersisted);
log("info", `journal open at ${journalPath} (globalSeq ${journal.lastGlobalSeq()})`);

// 5a. Self-monitoring: problems and an optional daily summary in the Telegram chat, in
// the house's time zone (HA's arrives on connect, step 8).
const { monitor_alerts: monitorAlerts, monitor_summary_time: summaryTime, monitor_ha_down_min: haDownMin } = config.options;
if (notifier !== undefined && (monitorAlerts || summaryTime.trim() !== "")) {
  monitor = createMonitor({
    notifier,
    options: { alerts: monitorAlerts, ...(summaryTime.trim() !== "" ? { summaryTime } : {}), haDownMin },
    instances: () => heuristics.instances(),
    journal,
    timeZone: houseZone(houseFacts),
    log: haLog,
  });
  monitor.start();
  log("info", `monitor: alerts ${monitorAlerts ? `on (HA down after ${haDownMin} min)` : "off"}, daily summary ${summaryTime.trim() || "off"}`);
}

// 6. Signals ring store.
const signalStore = createSignalStore({ path: join(config.dataDir, "signals.db") });

// 7. Views db + projection runner (2 s poll as safety net; nudge is the fast path).
const viewsDb = new Database(join(config.dataDir, "views.db"));
const projectionStore = createSqliteProjectionStore(viewsDb);
projectionRunner = createProjectionRunner({
  entries: [{ projection: noderedTimeline, eventCodec: auditEventCodec }],
  journal,
  store: projectionStore,
  pollIntervalMs: 2000,
});
projectionRunner.runOnce();
projectionRunner.start();
const runner: ProjectionRunner = projectionRunner;

// 8. HA client; every call_service becomes a RecordCallService command, attributed:
// Teobeanie's own (checked as the event arrives), a person, a system user, or the device.
// HA user names come from config/auth/list, and the house's zone from get_config, both
// re-read on every reconnect. Heuristics start once the first zone answer is in.
let zoneSettled!: () => void;
const zoneKnown = new Promise<void>((resolve) => (zoneSettled = resolve));
if (isTimeZone(zoneOption)) zoneSettled();
// A get_config that never answers must not hold the heuristics back.
setTimeout(() => zoneSettled(), 10_000).unref();
const auditCategoryRegistration = categoryTypes<AuditCommand, AuditReply>(AUDIT_CATEGORY);
const users = createUserDirectory({ send: (m) => ha.send(m), log: haLog });
ha.onConnectionChange((connected) => {
  monitor?.onConnection(connected);
  if (!connected) return;
  void users.refresh();
  ha.send<{ time_zone?: string }>({ type: "get_config" })
    .then((c) => {
      if (!isTimeZone(c.time_zone)) {
        if (timeZone() === undefined) log("warning", `Home Assistant names no time zone — local times are ${houseZone(houseFacts)}`);
        return;
      }
      if (c.time_zone !== haZone) log("info", `house time zone: ${c.time_zone} (Home Assistant)${isTimeZone(zoneOption) ? `, overridden by the time_zone option: ${zoneOption}` : ""}`);
      haZone = c.time_zone;
      monitor?.setTimeZone(houseZone(houseFacts));
    })
    .catch((err) => log("warning", `get_config: ${String(err)}`))
    .finally(() => zoneSettled());
});
const attribute = createAttributor({ own: ownCalls, users });
// A name lookup may wait on HA; the chain keeps the audit in arrival order meanwhile.
let auditChain: Promise<unknown> = Promise.resolve();
ha.onCallService((e) => {
  const haContextId = e.context?.id ?? null;
  const haUserId = e.context?.user_id ?? null;
  const by = attribute({ domain: e.domain, service: e.service, entityIds: e.entityIds, contextId: haContextId, userId: haUserId });
  auditChain = auditChain
    .then(async () =>
      runtime.tell(
        AUDIT_ENTITY,
        {
          tag: "RecordCallService",
          domain: e.domain,
          service: e.service,
          entityIds: e.entityIds,
          serviceData: e.serviceData,
          at: e.timeFired,
          haContextId,
          haParentId: e.context?.parent_id ?? null,
          haUserId,
          by: await by,
        },
        auditCategoryRegistration,
      ),
    )
    .catch((err) => log("error", `call_service audit: ${String(err)}`));
});

// 9. Bridge: state_changed → allowlist routing → debounce → signals.db (+SSE tap).
const createBridge = (routeSpecs: RouteSpec[], policyVersion: number, client: Pick<HaClient, "onStateChanged" | "onStatesSnapshot" | "stats"> = ha): HaBridge =>
  createHaBridge({
    client,
    store: signalStore,
    routes: routeSpecs,
    policyVersion,
    retention: { days: config.options.signal_retention_days },
    onSignal: (row) => {
      bus.publish({ type: "signal", row });
      heuristics.onSignal(row);
    },
    log: haLog,
  });
let bridge = createBridge(routes, allowlist.policyVersion);
bridgeRef = bridge;
bridge.start();

/**
 * New routes (a reload): a new bridge, seeded with the old one's live cache as a
 * resync, so it knows every entity at once and a newly routed one gets its baseline row.
 */
const swapBridge = (routeSpecs: RouteSpec[], policyVersion: number): void => {
  const old = bridge;
  let seed: ((snap: HaStatesSnapshot) => void) | undefined;
  const fresh = createBridge(routeSpecs, policyVersion, {
    onStateChanged: (h) => ha.onStateChanged(h),
    onStatesSnapshot: (h) => {
      seed = h;
      return ha.onStatesSnapshot(h);
    },
    get stats() {
      return ha.stats;
    },
  });
  old.stop();
  fresh.start();
  seed?.({ reason: "resync", states: [...old.liveCache().values()], at: Date.now() });
  bridge = bridgeRef = fresh;
};

// Attribute-only changes the bridge does not route (it compares states): an enforced
// setpoint drifting, the weather entity's outdoor readings moving. Same signal path.
let attributeWatched = new Set(heuristics.attributeWatched());
ha.onStateChanged((e) => {
  const { newState: now, oldState: before } = e;
  if (!attributeWatched.has(e.entityId) || now === null || before === null || now.state !== before.state) return;
  const moved =
    e.entityId === allowlist.house.outdoor?.weather
      ? OUTDOOR_ATTRIBUTES.some((k) => now.attributes[k] !== before.attributes[k])
      : JSON.stringify(now.attributes) !== JSON.stringify(before.attributes);
  if (!moved) return;
  const row: SignalRow = {
    obsId: ulid(),
    entityId: e.entityId,
    at: Date.now(),
    haTimeFired: e.timeFired,
    raw: now,
    normalized: normalizeState(now),
    origin: "ha",
    haVersion: ha.stats.haVersion,
    policyVersion: allowlist.policyVersion,
  };
  signalStore.append(row);
  bus.publish({ type: "signal", row });
  heuristics.onSignal(row);
});
if (attributeWatched.size > 0) log("info", `attribute signals for ${[...attributeWatched].join(", ")}`);
// After the snapshot's handlers have run, so the bridge's live cache holds it (also a
// bridge a reload created before HA first connected, whose handler comes later).
ha.onStatesSnapshot((snap) => {
  if (snap.reason === "initial") queueMicrotask(() => void zoneKnown.then(() => heuristics.start(ha)));
});
ha.start();

// 9a. Telegram commands, once Teobeanie is the bot's only client (telegram_commands).
const telegram =
  config.options.telegram_commands && notifier !== undefined && tgToken
    ? createTelegramReceiver({
        token: tgToken,
        chatIds: [tgChat],
        dispatch: (name, args, from) => heuristics.command(name, args, from),
        commandNames: () => heuristics.commandNames(),
        menu: () => heuristics.commandMenu(),
        keyboard: (name) => heuristics.commandKeyboard(name),
        reply: (text) => notifier.send(text),
        log: haLog,
      })
    : undefined;
if (config.options.telegram_commands && telegram === undefined) log("warning", "telegram_commands is on but telegram_bot_token/telegram_chat_id are not set");
telegram?.start();

// 9b. House view: every entity in scope, grouped, live over "house" frames on the same bus.
const houseConfig = (): HouseConfig => ({
  ...(allowlist.fromFile ? { observes: (id: string) => scope.observes(id) } : {}),
  groups,
  tiles,
  ...(allowlist.house.outdoor !== undefined ? { outdoor: allowlist.house.outdoor } : {}),
});
const house = createHouseService({
  ha,
  live: () => bridge.liveCache(),
  ...houseConfig(),
  timeZone,
  // The bus's frame union predates "house"; the SSE writer sends any frame by its type.
  publish: (frame) => bus.publish(frame as unknown as StreamFrame),
  listening: () => bus.subscriberCount() > 0,
  cards: () => heuristics.cards(),
  facts: () => heuristics.facts(),
  log: haLog,
});
cardsChanged = () => house.cardsChanged();
factsChanged = () => house.factsChanged();

// 10. Read API (journal implements JournalReader; ha implements RecorderReader).
const readApi = createReadApi(
  {
    projectionStore,
    journal,
    signals: signalStore,
    recorder: ha,
    tiles: () => buildTiles(tiles, bridge),
    bus,
    startedAt,
  },
  {},
);

// 10b. Config reload: a change of heuristics.json, allowlist.json or tiles.json (1 s
// after the last), or POST api/reload, applies in-process, all or nothing. Only the
// instances that changed restart; add-on options still need a restart. What a reload
// changed is journaled with who did it, and the panel's mode changes go through it.
const reloader = createReloader({
  apply: () =>
    applyConfig({
      configDir: config.configDir,
      host: heuristics,
      log,
      swap: (next, prepared) => {
        const prev = allowlist;
        allowlist = next.allowlist;
        library = next.library;
        packages = next.packages;
        libraryFacts = next.facts;
        factSources = next.factSources;
        ({ tiles, groups } = next);
        checkTileCoverage(tiles, allowlist.routes.map((r) => r.entityId), log);
        house.configure(houseConfig());
        attributeWatched = new Set(prepared.attributeWatched);
        const nextRoutes = routesFor(allowlist, prepared.watchedEntities);
        if (JSON.stringify(nextRoutes) !== JSON.stringify(routes) || prev.policyVersion !== allowlist.policyVersion) {
          swapBridge(nextRoutes, allowlist.policyVersion);
          log("info", `routing: ${nextRoutes.length} entities (was ${routes.length})`);
        }
        routes = nextRoutes;
      },
    }),
  log,
  // What changed, by whom, journaled in teob-config for the timeline.
  configDir: config.configDir,
  instances: () => heuristics.instances(),
  record: createConfigJournal(runtime),
  // The panel refetches the instances on this frame; the bot's menu follows the commands.
  onReloaded: (outcome) => {
    bus.publish({ type: "reload", ...outcome } as unknown as StreamFrame);
    telegram?.refreshMenu();
  },
});
const configWatch = watchConfig({ dir: config.configDir, log, onChange: () => void reloader.reload("file") });

// 11. HTTP server + health + MCP.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
const mcpCategory = categoryTypes<McpCommand, void>(MCP_CATEGORY);
// The add-on's mcp_networks option; MCP_NETWORKS (comma-separated CIDRs) overrides it, standalone too.
// A malformed entry is dropped with a warning rather than stopping the add-on.
const mcpNetworks = resolveMcpNetworks(process.env.MCP_NETWORKS, config.options.mcp_networks).filter((cidr) => {
  try {
    networks([cidr]);
    return true;
  } catch {
    log("warn", `mcp: ignoring ${cidr} in the MCP networks: not a network (address/bits)`);
    return false;
  }
});
log("info", `mcp: clients allowed from ${mcpNetworks.length > 0 ? mcpNetworks.join(", ") : "nowhere (no networks configured)"}`);
const health = (): HealthReport => {
  const haStats = ha.stats;
  const signalStats = signalStore.stats();
  const runnerStats = runner.stats();
  return {
    status: haStats.connected ? "ok" : "degraded",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    mode: config.mode,
    shadowMode: config.options.shadow_mode,
    pause: pause.state(),
    ha: haStats,
    bridge: bridge.stats(),
    journal: { path: journalPath, globalSeq: journal.lastGlobalSeq() },
    signals: { rows: signalStats.rows, newestAt: signalStats.newestAt, dbBytes: signalStats.dbBytes },
    projections: { lastCycleAt: runnerStats.lastCycleAt, cycles: runnerStats.cycles },
    sse: { subscribers: bus.subscriberCount() },
  };
};

const server = startServer(
  {
    readApi,
    health,
    heuristics: () => heuristics.instances(),
    facts: () => heuristics.facts(),
    house,
    devices: createDeviceResolver({ wsUrl: config.haWsUrl, token: config.haToken }),
    studio: {
      configDir: config.configDir,
      mode: config.mode,
      liveStates: () => bridge.liveCache().values(),
      scope,
      packages: () => packages,
      facts: () => libraryFacts.map((f) => ({ id: f.id, title: f.title, ...factSources.get(f.id) })),
    },
    reload: reloader,
    library: { current: () => library, packages: () => packages },
    pause,
    command: (name, args, from) => heuristics.command(name, args, from),
    log,
    record: createHouseRecord({ scope, signals: signalStore, journal, users, instances: () => heuristics.instances(), facts: () => heuristics.facts(), house: houseFacts }),
    mcp: (app) =>
      mountMcp(app, {
        mode: config.mode,
        networks: mcpNetworks,
        version,
        instructions: INSTRUCTIONS,
        tools: createHouseTools({
          scope,
          liveState: (id) => bridge.liveState(id),
          signals: signalStore,
          journal,
          ha,
          users,
          instances: () => heuristics.instances(),
          facts: () => heuristics.facts(),
          pause: () => pause.state(),
          configDir: config.configDir,
          house: houseFacts,
          packages: () => packages,
          caller: currentCaller,
        }),
        record: (call) => void runtime.tell(MCP_ENTITY, { tag: "Record", call }, mcpCategory).catch((err) => log("error", `mcp journal: ${String(err)}`)),
        log: haLog,
      }),
    panelDistDir: join(packageRoot, "panel-dist"),
  },
  8099,
);
log("info", "http server listening on :8099");

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down");
  void (async () => {
    configWatch.close();
    await runner.stop();
    await heuristics.stop();
    monitor?.stop();
    telegram?.stop();
    house.stop();
    bridge.stop();
    await ha.stop();
    server.close();
    signalStore.close();
    viewsDb.close();
    journal.close();
    process.exit(0);
  })();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
