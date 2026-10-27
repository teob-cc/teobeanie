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
import { createEnergyService } from "./energy/service.js";
import { createInfraService } from "./infra/service.js";
import { createEnergyTools } from "./energy/index.js";
import { loadEnergyFile } from "./energy/file.js";
import { EMPTY_ENERGY_FILE, type EnergyFile } from "./energy/config.js";
import { createEnergyJournal, energyAggregate, energyEventCodec, energyStateCodec } from "./energy/journal.js";
import { applyConfig, createReloader, watchConfig } from "./reload.js";
import { startAgentServer, startServer, type HealthReport } from "./server.js";
import { installStarter, loadLibrary, starterPackages, type PackageInfo } from "./packages/library.js";
import { createSafeActuator, createTelegramNotifier } from "./kernel/actuator.js";
import { createTelegramReceiver } from "./telegram.js";
import { loadVoiceFile, NO_VOICE, type VoiceFile } from "./voice/file.js";
import { monthStart, VOICE_ENTITY, voiceAggregate, voiceEventCodec, voiceSpend, voiceStateCodec, VOICE_CATEGORY, type VoiceCommand } from "./voice/journal.js";
import { createVoiceLane } from "./voice/lane.js";
import { createChatClient, OPENROUTER_URL, type ChatClient } from "./voice/llm.js";
import { createTranscriber, siblingWhisperUrl } from "./voice/stt.js";
import { createHeuristicHost, loadInstances, seedConfigExamples } from "./kernel/host.js";
import { createDeviceResolver } from "./devices.js";
import { createMonitor, type Monitor } from "./monitor.js";
import { houseZone, isTimeZone } from "./kernel/clock.js";
import { createMcp, currentCaller } from "./mcp/index.js";
import { mcpNetworks as resolveMcpNetworks, networks } from "./mcp/access.js";
import { MCP_CATEGORY, MCP_ENTITY, mcpAuditAggregate, mcpEventCodec, mcpStateCodec, type McpCommand } from "./mcp/journal.js";
import { INSTRUCTIONS, createHouseTools } from "./mcp/tools.js";
import { DEVELOP_INSTRUCTIONS, createDevelopTools } from "./mcp/develop.js";
import { createHaTools } from "./mcp/ha-tools.js";
import { createHaRegistry } from "./ha-registry.js";
import { createHouseRecord } from "./mcp/timeline.js";
import { AGENT_PORT, accessAggregate, accessEventCodec, accessStateCodec, createAccessJournal, createAgentTokens, createFailureLimiter } from "./mcp/agents.js";
import { supervisorPort, type AgentPortInfo } from "./connect.js";
import { createPauseControl, pauseAggregate, pauseEventCodec, pauseStateCodec } from "./pause.js";
import { configAggregate, configEventCodec, configStateCodec, createConfigJournal } from "./working-set.js";
import { createRevisionStore, recordBootRevision } from "./revisions.js";
import { createMoveJournal, importAtStart, importedEvent, moveAggregate, moveEventCodec, moveStateCodec } from "./move.js";

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

// 1a. A move from another install (move.ts): an export copied into the config folder's
// teobeanie-move/ is taken in now, before anything reads the data dir or the config
// folder, when this install's journal is empty. Journaled once the runtime is up (step 5).
const moved = importAtStart({ dataDir: config.dataDir, configDir: config.configDir, log });

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
let { tiles, groups, infra: infraConfig } = loadHouseConfig(config.configDir, log);
// energy.json: the energy ledger's tariffs and additions. One that will not do is
// reported and left out at the start (a reload rejects it, as any working-set file).
let energyFile: EnergyFile = EMPTY_ENERGY_FILE;
try {
  energyFile = loadEnergyFile(config.configDir);
} catch (err) {
  log("error", `energy: ${String(err)} (the ledger runs without energy.json until it is fixed)`);
}
// voice.json: the voice lane. One that will not do leaves voice off until it is fixed.
let voiceFile: VoiceFile = NO_VOICE;
try {
  voiceFile = loadVoiceFile(config.configDir);
} catch (err) {
  log("error", `voice: ${String(err)} (voice is off until it is fixed)`);
}
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
  registration(accessAggregate, accessEventCodec, accessStateCodec),
  registration(moveAggregate, moveEventCodec, moveStateCodec),
  registration(energyAggregate, energyEventCodec, energyStateCodec),
  registration(voiceAggregate, voiceEventCodec, voiceStateCodec),
]);
// The global pause, folded from the journal before any instance can act (a recovered
// notice is resent through the actuator too).
const pause = createPauseControl({ runtime, journal, actuator });
if (pause.state().paused) log("warning", `all heuristics paused (by ${pause.state().by ?? "?"}): only guards act until resumed`);
heuristics.attach(journal, onPersisted);
log("info", `journal open at ${journalPath} (globalSeq ${journal.lastGlobalSeq()})`);
const recordMove = createMoveJournal(runtime);
const importedFrom = importedEvent(moved);
if (importedFrom !== undefined) await recordMove(importedFrom).catch((err) => log("error", `move: the import is done, but not journaled: ${String(err)}`));

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
    // The ledger and the house view are made in step 9; the summary first reads them at its time.
    energy: () => energy.overview(),
    // Every card, the Infra tab's too (the House page leaves those out).
    house: async () => ({ ...(await house.view()), cards: heuristics.cards() }),
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

// 9a. Voice messages: heard by Teobeanie Whisper (or stt_url), understood by the model
// into the commands voice.json lists, run through the command lane as whoever spoke.
const sttUrl = config.options.stt_url.trim() || (config.mode === "addon" ? siblingWhisperUrl() : "");
const transcriber = sttUrl ? createTranscriber({ url: sttUrl }) : undefined;
const llmFor = (() => {
  const clients = new Map<string, ChatClient>();
  return (model: string): ChatClient | undefined => {
    const o = config.options;
    const name = model.trim() || o.openrouter_model;
    if (o.llm_provider === "none" || !name) return undefined;
    if (o.llm_provider === "openrouter" && !o.openrouter_api_key) return undefined;
    if (o.llm_provider === "ollama" && !o.ollama_url) return undefined;
    let c = clients.get(name);
    if (c === undefined) {
      c =
        o.llm_provider === "openrouter"
          ? createChatClient({ baseUrl: OPENROUTER_URL, apiKey: o.openrouter_api_key, model: name, openrouter: true })
          : createChatClient({ baseUrl: `${o.ollama_url.replace(/\/+$/, "")}/v1`, model: name });
      clients.set(name, c);
    }
    return c;
  };
})();
const voiceCategory = categoryTypes<VoiceCommand, void>(VOICE_CATEGORY);
/** The month's model spend: folded from the journal at the start, then added to as messages are journaled. */
const voiceMonth = { start: monthStart(Date.now()), spent: 0 };
voiceMonth.spent = voiceSpend(journal, voiceMonth.start);
const houseTimeFormat = (): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-GB", { timeZone: houseZone(houseFacts), weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const voiceLane = createVoiceLane({
  file: () => voiceFile,
  transcriber,
  llm: llmFor,
  schemas: () => heuristics.commandSchemas(),
  context: (commands) => {
    const answering = new Set(heuristics.instances().filter((i) => i.mode !== "off" && i.commands.some((c) => commands.includes(c))).map((i) => i.key));
    return heuristics
      .cards()
      .filter((c) => answering.has(c.key) && c.card !== undefined)
      .map((c) => `${c.card!.title}: ${c.card!.fields.map((f) => `${f.label} ${f.value === null ? "—" : String(f.value)}${f.unit ?? ""}`).join("; ")}`);
  },
  dispatch: (name, args, from) => heuristics.command(name, args, from),
  houseTime: (at) => houseTimeFormat().format(at),
  spent: () => {
    const start = monthStart(Date.now());
    if (start !== voiceMonth.start) Object.assign(voiceMonth, { start, spent: 0 });
    return voiceMonth.spent;
  },
  budgetUsd: config.options.llm_monthly_budget_usd,
  record: (handled) => {
    voiceMonth.spent += handled.usage?.cost ?? 0;
    void runtime.tell(VOICE_ENTITY, { tag: "Record", event: handled }, voiceCategory).catch((err) => log("error", `voice journal: ${String(err)}`));
  },
  log: haLog,
});
if (voiceFile.mode !== "off") log("info", `voice: ${voiceFile.mode}, commands ${voiceFile.commands.map((c) => "/" + c).join(", ") || "none"}; speech to text ${sttUrl || "none"}`);

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
        voice: voiceLane,
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
// HA's registries as the explore tools and the Infra tab read them (refreshed on registry events).
const haRegistry = createHaRegistry({ ha, log: haLog });
// 9a. Infra tab: the internet link, the mesh, the network's devices, the tailnet, HA's health.
const infra = createInfraService({ registry: haRegistry, live: () => bridge.liveCache(), cards: () => heuristics.cards(), config: infraConfig });
const house = createHouseService({
  ha,
  live: () => bridge.liveCache(),
  ...houseConfig(),
  timeZone,
  // The bus's frame union predates "house"; the SSE writer sends any frame by its type.
  publish: (frame) => bus.publish(frame as unknown as StreamFrame),
  listening: () => bus.subscriberCount() > 0,
  // The cards tiles.json puts on the Infra tab are left off the House page.
  cards: () => heuristics.cards().filter((c) => !infra.onTab(c.key)),
  facts: () => heuristics.facts(),
  log: haLog,
});
// 9c. Energy ledger: today from HA's statistics, the past from the days it closed (journaled).
const energy = createEnergyService({
  ha,
  journal,
  record: createEnergyJournal(runtime),
  signals: signalStore,
  state: (id) => bridge.liveState(id),
  timeZone: () => houseZone(houseFacts),
  outdoorTemperature: () => allowlist.house.outdoor?.temperature,
  file: energyFile,
  log: haLog,
});
energy.start();
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

// 10b. Config reload: a change of a working-set file (1 s after the last), or POST
// api/reload, applies in-process, all or nothing. Only the instances that changed
// restart; add-on options still need a restart. What a reload changed is journaled with
// who did it, as the working set's next revision (its files under /data/revisions), and
// the panel's edits, rollbacks and promotes go through it.
const recordConfig = createConfigJournal(runtime);
const revisions = createRevisionStore({ dir: join(config.dataDir, "revisions"), configDir: config.configDir, journal });
try {
  const booted = await recordBootRevision(revisions, recordConfig);
  if (booted !== undefined) log("info", `working set: revision ${booted.revision} (${booted.summary})`);
} catch (err) {
  log("error", `working set: could not record the revision at start: ${String(err)}`);
}
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
        infra.configure(next.infra);
        house.configure(houseConfig());
        energy.configure(next.energy);
        if (JSON.stringify(next.voice) !== JSON.stringify(voiceFile)) log("info", `voice: ${next.voice.mode}, commands ${next.voice.commands.map((c) => "/" + c).join(", ") || "none"}`);
        voiceFile = next.voice;
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
  record: recordConfig,
  revisions,
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
// The starter set.
const starterSet = starterPackages();
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
log("info", `mcp: ingress clients allowed from ${mcpNetworks.length > 0 ? mcpNetworks.join(", ") : "nowhere (no networks configured)"}`);
// One MCP server, two doors: HA ingress on :8099, and the agent port with agent tokens
// minted on the panel's Connect page (hashes in /data, mints and revocations journaled).
const mcp = createMcp({
  mode: config.mode,
  networks: mcpNetworks,
  version,
  instructions: `${INSTRUCTIONS}\n${DEVELOP_INSTRUCTIONS}`,
  tools: [
    ...createHouseTools({
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
      cards: () => heuristics.cards(),
      caller: currentCaller,
    }),
    // The energy ledger, read-only.
    ...createEnergyTools({ energy, timeZone: () => houseZone(houseFacts) }),
    // All of HA, read-only and never recorded (ha_registry, ha_states, ha_history, ha_services, suggest).
    ...createHaTools({
      ha,
      registry: haRegistry,
      states: () => bridge.liveCache(),
      scope,
      house: houseFacts,
      instances: () => heuristics.instances(),
      packages: () => packages,
      starter: () => starterSet,
    }),
    // Develop and operate: each write one revision through the reloader, by mcp:<caller>.
    ...createDevelopTools({
      configDir: config.configDir,
      reloader,
      revisions,
      journal,
      instances: () => heuristics.instances(),
      library: () => ({ heuristics: library, facts: libraryFacts, factSources, packages }),
      starter: () => starterSet,
      scope,
      liveStates: () => bridge.liveCache().values(),
      ha,
      users,
      house: houseFacts,
      pause,
      command: (name, args, from) => heuristics.command(name, args, from),
      caller: currentCaller,
    }),
  ],
  record: (call) => void runtime.tell(MCP_ENTITY, { tag: "Record", call }, mcpCategory).catch((err) => log("error", `mcp journal: ${String(err)}`)),
  log: haLog,
});
const agentTokens = createAgentTokens({ path: join(config.dataDir, "agent-tokens.json"), record: createAccessJournal(runtime), log });
// The add-on's port is fixed by config.yaml; standalone, MCP_AGENT_PORT moves it.
const agentPort = config.mode === "addon" ? AGENT_PORT : Number(process.env.MCP_AGENT_PORT ?? AGENT_PORT);
const agentPortInfo: () => Promise<AgentPortInfo> =
  config.mode === "addon" ? supervisorPort({ token: config.haToken, log }) : async () => ({ port: agentPort, source: "standalone" });
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
    energy,
    infra,
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
    revisions,
    twins: journal,
    library: { current: () => library, packages: () => packages },
    pause,
    command: (name, args, from) => heuristics.command(name, args, from),
    log,
    record: createHouseRecord({ scope, signals: signalStore, journal, users, instances: () => heuristics.instances(), facts: () => heuristics.facts(), house: houseFacts }),
    mcp: (app) => mcp.mountIngress(app),
    connect: { mode: config.mode, tokens: agentTokens, port: agentPortInfo, log },
    move: {
      mode: config.mode,
      dataDir: config.dataDir,
      configDir: config.configDir,
      journal: journal.db,
      signals: signalStore.db,
      version,
      journalReader: journal,
      record: recordMove,
      atStart: moved,
      log,
    },
    panelDistDir: join(packageRoot, "panel-dist"),
  },
  8099,
);
log("info", "http server listening on :8099");
const agentServer = startAgentServer((app) => mcp.mountAgents(app, { tokens: agentTokens, limiter: createFailureLimiter() }), agentPort, (err) =>
  log("error", `mcp: the agent port ${agentPort} could not be opened: ${err.message}`),
);
log("info", `mcp: agent port listening on :${agentPort} (/mcp only, agent tokens: ${agentTokens.list().length})`);
log("info", "mcp: the agent port is token-only; it cannot see client addresses behind the host's port mapping");

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
    energy.stop();
    haRegistry.stop();
    bridge.stop();
    await ha.stop();
    server.close();
    agentServer.close();
    signalStore.close();
    viewsDb.close();
    journal.close();
    process.exit(0);
  })();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
