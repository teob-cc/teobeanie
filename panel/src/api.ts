// api.ts — typed client for the read API (contract §6.2 / §7) + /api/heuristics.
// Response shapes are copied from the contract, NOT imported from teob-ts.
// ALL URLs are relative WITHOUT a leading slash: the panel is served behind
// HA ingress under a dynamic path prefix, and every request must resolve
// against the URL index.html was loaded from.

import type { HeuristicInstance } from "./decisions";
import type { EnergyToday, HouseView } from "../../src/house/view";
import type { ParamField } from "../../src/kernel/params";

export interface TimelineCard {
  at: number;
  domain: string;
  service: string;
  entityIds: string[];
  summary: string;
  contextId: string | null;
  /** Who made the call (origin.ts); absent on cards projected before attribution. */
  by?: string;
  eventId?: string;
}

export interface EnvelopeMeta {
  eventId: string;
  causationId?: string;
  correlationId?: string;
  origin?: string;
  v: number;
}

export interface JournalRow {
  globalSeq: number;
  category: string;
  entityId: string;
  sequenceNr: number;
  manifest: string;
  payload: any;
  /** Journal row timestamp, unix SECONDS (legacy column). */
  ts: number;
  envelope: EnvelopeMeta | null;
}

/** Who caused a change or a call (src/mcp/timeline.ts Cause): an origin, Teobeanie's instance, the event to chain. */
export interface Cause {
  by: string;
  instance?: string;
  event?: string;
}

/** One row of api/timeline (src/mcp/timeline.ts TimelineRow), at in epoch ms. */
export type TimelineEntry =
  | { at: number; kind: "change"; entity: string; from?: string; to: string; by: Cause; obs_id: string }
  | { at: number; kind: "call"; service: string; entities: string[]; data?: unknown; by: Cause; event_id: string }
  | {
      at: number;
      kind: "decision";
      instance: string;
      input: { kind: string; entity?: string; value?: unknown; state?: string; timer?: string; trigger?: string; fact?: string };
      why?: string;
      mode?: string;
      failed?: string;
      actions?: Array<{ action: string; status: string; event_id?: string }>;
      timers?: Array<{ timer: string; at: number }>;
      event_id: string;
    }
  | { at: number; kind: "pause" | "config"; summary: string; by?: string; event_id: string }
  /** A fact's value changed: why, and what made it re-evaluate. */
  | { at: number; kind: "fact"; fact: string; value: unknown; why?: string; input?: string; event_id: string; cause?: string };

export interface SignalPoint {
  at: number;
  value: number | string | boolean | null;
  unit: string | null;
}

export type TileKind = "power" | "temp" | "co2" | "humidity" | "wind" | "binary" | "presence" | "text";

export interface Tile {
  entityId: string;
  label: string;
  kind: TileKind;
  /** The attribute shown instead of the state. */
  attribute?: string;
  value: number | string | boolean | null;
  unit: string | null;
  stateAt: number | null;
}

/** Shape of GET health (contract §7.5 HealthReport). */
export interface HealthReport {
  status: "ok" | "degraded";
  uptimeSec: number;
  mode: "addon" | "standalone";
  shadowMode: boolean;
  pause: PauseState;
  ha: {
    connected: boolean;
    haVersion: string | null;
    connectedSince: number | null;
    reconnects: number;
    eventsSeen: number;
    lastEventAt: number | null;
    pendingCommands: number;
    subscriptions: number;
  };
  bridge: {
    routedEntities: number;
    cacheSize: number;
    received: number;
    appended: number;
    suppressed: number;
    resyncSynthesized: number;
    lastSignalAt: number | null;
    prunedTotal: number;
  };
  journal: { path: string; globalSeq: number };
  signals: { rows: number; newestAt: number | null; dbBytes: number };
  projections: { lastCycleAt: number | null; cycles: number };
  sse: { subscribers: number };
}

/** The global pause (src/pause.ts): while paused only guards act. */
export interface PauseState {
  paused: boolean;
  /** The latest pause or resume: when, by whom (an origin, origin.ts), the pause's reason. */
  at?: number;
  by?: string;
  reason?: string;
}

/** The journal stream of the pause (src/pause.ts). */
export const CONTROL_CATEGORY = "teob-control";

/** The journal stream of the working set's edits (src/working-set.ts). */
export const CONFIG_CATEGORY = "teob-config";

/** A working-set edit as journaled (src/working-set.ts ConfigChanged). */
export interface ConfigChange {
  at: number;
  /** "heuristics.json", "heuristics/my-rule.ts, allowlist.json" */
  file: string;
  /** An origin (origin.ts): person:<name>, user:<id>, file, cli, local. */
  by: string;
  summary: string;
  /** The instances it touched; absent: all of them. */
  instances?: string[];
  /** The revision it made (src/revisions.ts); absent on rows from before revisions. */
  revision?: number;
  parent?: number;
}

/** A revision of the working set (src/revisions.ts listRevisions). */
export interface RevisionRow {
  revision: number;
  parent?: number;
  at: number;
  by: string;
  summary: string;
  instances?: string[];
  /** The files it changed against its parent. */
  file: string;
  fileCount: number;
}

/** One file's change between two revisions (src/revisions.ts FileDiff). */
export interface FileDiff {
  path: string;
  status: "added" | "removed" | "changed";
  diff: string;
}

/** A twin against its original, per input signal (src/twins.ts TwinComparison). */
export interface TwinComparison {
  twin: string;
  original: string;
  from: number;
  to: number;
  compared: number;
  same: number;
  differences: Array<{
    obsId: string;
    at: number;
    input: { kind: string; entity?: string; state?: string };
    original?: { why?: string; actions: unknown[] };
    twin?: { why?: string; actions: unknown[] };
  }>;
  other: { original: number; twin: number };
}

/** A config reload (src/reload.ts): what changed, or why the config was rejected. */
export interface ReloadOutcome {
  ok: boolean;
  at: number;
  source: "file" | "api";
  by?: string;
  summary?: string;
  /** What was journaled for it, when it changed something. */
  journaled?: ConfigChange;
  error?: string;
}

export type InstanceMode = "off" | "shadow" | "active";

/** An instance as heuristics.json has it (src/kernel/host.ts InstanceConfig). */
export interface InstanceConfig {
  heuristic: string;
  id: string;
  mode?: InstanceMode;
  params: unknown;
  alerts?: boolean;
  notifyPerHour?: number;
  commandHelp?: Record<string, string>;
}

/** A behaviour package in the config folder (src/studio/files.ts StudioPackage). */
export interface StudioPackage {
  name: string;
  version: string;
  title: string;
  description?: string;
  /** "starter" (came with the add-on), "local"; later a git URL. */
  origin: string;
  modified: boolean;
  heuristics: string[];
  /** Per heuristic id, the file that defines it. */
  sources: Record<string, string>;
  files: string[];
}

/** One heuristic of the catalogue (src/instances.ts CatalogueEntry). */
export interface CatalogueEntry {
  id: string;
  title: string;
  description: string;
  pattern?: string;
  rule: boolean;
  /** The house's own: not from the starter set (a file in heuristics/, or a package of its own). */
  own: boolean;
  /** Its package in the config folder (absent: a file in heuristics/); modified: the house changed it. */
  package?: { name: string; version: string; origin: string; modified: boolean };
  guarantees?: string;
  /** null: no schema, the params are edited as JSON. */
  params: ParamField[] | null;
  notifyPerHour: number;
}

/** An entity the editor's pickers offer (src/instances.ts PickerEntity). */
export interface PickerEntity {
  id: string;
  name?: string;
  operate: boolean;
}

/** An instance edit's answer: the reload's outcome, or the problems that refused it before anything was written. */
export type EditOutcome = ReloadOutcome | { ok: false; error: string; problems: string[] };

/** An agent token as the Connect page lists it (src/mcp/agents.ts AgentTokenInfo): never the secret. */
export interface AgentToken {
  id: string;
  name: string;
  createdAt: number;
  /** An origin (origin.ts): person:<name>, user:<id>, local. */
  by: string;
  /** Since the add-on started; null: not used yet. */
  lastUsedAt: number | null;
}

/** GET api/connect (src/connect.ts ConnectInfo): the tokens and the agent port's host port. */
export interface ConnectInfo {
  /** null: the port is disabled in the add-on's Network section. */
  port: number | null;
  source: "supervisor" | "default" | "standalone";
  defaultPort: number;
  tokens: AgentToken[];
}

/** A write that answers with an outcome (200, or 422: rejected); anything else throws. */
async function edit(url: string, method: string, body?: unknown): Promise<EditOutcome> {
  const res = await fetch(url, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const out = (await res.json().catch(() => ({}))) as EditOutcome & { reason?: string };
  if (res.status === 200 || res.status === 422) return out;
  throw new Error(out.reason ?? `HTTP ${res.status}`);
}

const instanceUrl = (key: string) => `api/instances/${key.split("/").map(encodeURIComponent).join("/")}`;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

function qs(p: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
}

export const api = {
  timelineView: () =>
    getJson<{ viewId: string; view: { cards: TimelineCard[]; total: number }; sequenceNr: number }>(
      "api/views/nodered-timeline/nodered",
    ),
  journal: (p: { category?: string; entity?: string; cursor?: number; limit?: number; since?: number }) =>
    getJson<{ rows: JournalRow[]; nextCursor: number | null }>(`api/journal?${qs(p)}`),
  chain: (eventId: string) =>
    getJson<{ chain: JournalRow[] }>(`api/journal/chain/${encodeURIComponent(eventId)}`),
  signals: (entityId: string, sinceMs: number) =>
    getJson<{ entityId: string; rows: SignalPoint[] }>(
      `api/signals/${encodeURIComponent(entityId)}?since=${sinceMs}`,
    ),
  /** Changes, calls, decisions, the pause and config edits around an entity or instance; `more` pages on. */
  timeline: (p: { entity?: string; instance?: string; fact?: string; from?: number; to?: number; limit?: number; cursor?: string; order?: "asc" | "desc" }) =>
    getJson<{ from: number; to: number; rows: TimelineEntry[]; more?: string }>(`api/timeline?${qs(p)}`),
  tiles: () => getJson<{ at: number; tiles: Tile[] }>("api/tiles"),
  health: () => getJson<HealthReport>("health"),
  house: () => getJson<HouseView>("api/house"),
  energyToday: () => getJson<EnergyToday>("api/house/energy-today"),
  heuristics: () => getJson<{ instances: HeuristicInstance[]; reload?: ReloadOutcome | null }>("api/heuristics"),
  /** Re-read heuristics.json, allowlist.json and tiles.json; a rejection is an outcome too. */
  reloadConfig: async (): Promise<ReloadOutcome> => {
    const res = await fetch("api/reload", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as Partial<ReloadOutcome> & { reason?: string };
    if (res.status === 200 || res.status === 422) return body as ReloadOutcome;
    throw new Error(body.reason ?? `HTTP ${res.status}`);
  },
  /** Set an instance's mode in heuristics.json and reload; a rejected reload is an outcome too (nothing written). */
  setMode: async (key: string, mode: InstanceMode): Promise<ReloadOutcome> => {
    const res = await fetch(`api/instances/${key.split("/").map(encodeURIComponent).join("/")}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<ReloadOutcome> & { reason?: string };
    if (res.status === 200 || res.status === 422) return body as ReloadOutcome;
    throw new Error(body.reason ?? `HTTP ${res.status}`);
  },
  /** The catalogue (the packages' and the house's own heuristics) and the entities the editor's pickers offer. */
  library: () => getJson<{ heuristics: CatalogueEntry[]; entities: PickerEntity[] }>("api/library"),
  /** An instance as heuristics.json has it. */
  instance: (key: string) => getJson<InstanceConfig>(instanceUrl(key)),
  /** Add an instance, change one, remove one: written, reloaded all or nothing, journaled with the HA user. */
  addInstance: (inst: InstanceConfig) => edit("api/instances", "POST", inst),
  saveInstance: (key: string, inst: Omit<InstanceConfig, "heuristic" | "id">) => edit(instanceUrl(key), "PUT", inst),
  removeInstance: (key: string) => edit(instanceUrl(key), "DELETE"),
  /** The working set's revisions, newest first. */
  revisions: () => getJson<{ revisions: RevisionRow[] }>("api/revisions"),
  /** What changed from revision a to b, file by file. */
  revisionDiff: (a: number, b: number) => getJson<{ from: number; to: number; files: FileDiff[] }>(`api/revisions/${a}/diff/${b}`),
  /** Put revision n's files back and reload; a rejection is an outcome too (the files stay as they were). */
  rollback: (n: number) => edit(`api/revisions/${n}/rollback`, "POST"),
  /** The twins, each against its original over the last day. */
  twins: () => getJson<{ twins: TwinComparison[] }>("api/twins"),
  twin: (key: string) => getJson<TwinComparison>(`api/twins/${key.split("/").map(encodeURIComponent).join("/")}`),
  /** The twin takes its original's place (id and mode) in one revision. */
  promote: (key: string) => edit(`api/twins/${key.split("/").map(encodeURIComponent).join("/")}/promote`, "POST"),
  pause: () => getJson<PauseState>("api/pause"),
  /** Pause every heuristic but the guards, or resume them; journaled with the HA user. */
  setPause: async (paused: boolean, reason?: string): Promise<PauseState> => {
    const res = await fetch("api/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused, ...(reason ? { reason } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as PauseState & { reason?: string; error?: string };
    if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
    return body;
  },
  /** Run a named command as the HA user, as Telegram would (src/command.ts); the instances it reached. */
  command: async (name: string, args: string[] = []): Promise<{ reached: string[] }> => {
    const res = await fetch("api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    const body = (await res.json().catch(() => ({}))) as { reached?: string[]; reason?: string; error?: string };
    if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
    return { reached: body.reached ?? [] };
  },
  studioFiles: () => getJson<{ files: Array<{ name: string; bytes: number; modifiedAt: number }> }>("api/studio/files"),
  studioFile: async (name: string): Promise<string> => {
    const res = await fetch(`api/studio/files/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.text();
  },
  saveStudioFile: async (name: string, text: string): Promise<void> => {
    const res = await fetch(`api/studio/files/${encodeURIComponent(name)}`, { method: "PUT", body: text });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
      throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
    }
  },
  studioPackages: () => getJson<{ packages: StudioPackage[] }>("api/studio/packages"),
  studioPackageFile: async (pkg: string, name: string): Promise<string> => {
    const res = await fetch(`api/studio/packages/${encodeURIComponent(pkg)}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`${pkg}/${name}: HTTP ${res.status}`);
    return res.text();
  },
  studioTypes: () => getJson<{ toolkit: Record<string, string> | null; house: string; scope?: { observed: number; operated: number } }>("api/studio/types"),
  /** The agent tokens and the agent port (ingress only). */
  connect: () => getJson<ConnectInfo>("api/connect"),
  /** A new agent token: the token itself is in this answer only. */
  mintAgentToken: async (name: string): Promise<{ token: string; info: AgentToken }> => {
    const res = await fetch("api/agent-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = (await res.json().catch(() => ({}))) as { token?: string; info?: AgentToken; reason?: string; error?: string };
    if (!res.ok || body.token === undefined || body.info === undefined) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
    return { token: body.token, info: body.info };
  },
  /** Revoke an agent token: refused from its next request on. */
  revokeAgentToken: async (id: string): Promise<void> => {
    const res = await fetch(`api/agent-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
      throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
    }
  },
  deviceEntities: (ids: string[]) =>
    getJson<{ devices: Record<string, string[]> }>(`api/device-entities?ids=${ids.map(encodeURIComponent).join(",")}`),
};
