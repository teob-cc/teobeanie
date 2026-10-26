// server.ts — the HTTP server on :8099: ingress panel (static), read API, the MCP
// endpoint, /health for the supervisor watchdog. All URLs relative so the page works
// behind ingress. A second, small server on the agent port (8199) serves /mcp and
// nothing else, for agents with a token (agentApp below).

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { HaBridgeStats, HaClientStats } from "@lambda-house/teob-ts/ha";
import type { FactInfo, InstanceInfo } from "./kernel/host.js";
import type { DeviceResolver } from "./devices.js";
import type { HouseService } from "./house/service.js";
import type { EnergyService } from "./energy/service.js";
import type { InfraService } from "./infra/service.js";
import { mountEnergy } from "./energy/index.js";
import { mountStudio, type StudioDeps } from "./studio/files.js";
import { mountReload, type Reloader } from "./reload.js";
import { mountPause, type PauseControl, type PauseState } from "./pause.js";
import { mountCommand } from "./command.js";
import { mountTimeline, type HouseRecord } from "./mcp/timeline.js";
import { mountInstanceMode } from "./working-set.js";
import { mountInstances } from "./instances.js";
import { mountConnect, type ConnectDeps } from "./connect.js";
import { mountMove, type MoveDeps } from "./move.js";
import type { PackageInfo } from "./packages/library.js";
import type { AnyHeuristic, CommandSource } from "./kernel/heuristic.js";
import type { JournalReader } from "@lambda-house/teob-ts/core";
import { mountRevisions, type RevisionStore } from "./revisions.js";
import { mountTwins } from "./twins.js";

export interface HealthReport {
  status: "ok" | "degraded";
  uptimeSec: number;
  mode: "addon" | "standalone";
  shadowMode: boolean;
  /** The global pause: while set only guards act. */
  pause: PauseState;
  ha: HaClientStats;
  bridge: HaBridgeStats;
  journal: { path: string; globalSeq: number };
  signals: { rows: number; newestAt: number | null; dbBytes: number };
  projections: { lastCycleAt: number | null; cycles: number };
  sse: { subscribers: number };
}

export interface ServerDeps {
  readApi: { handle: (req: Request) => Promise<Response | undefined> };
  health: () => HealthReport;
  heuristics: () => InstanceInfo[];
  /** The facts with their values (GET api/facts); also in api/house. */
  facts?: () => FactInfo[];
  house: HouseService;
  /** The energy ledger: api/energy, api/energy/periods, api/energy/hours. */
  energy?: EnergyService;
  /** The Infra tab: GET api/infra. */
  infra?: InfraService;
  devices: DeviceResolver;
  studio: StudioDeps;
  /** Config reloads: POST api/reload, the panel's mode changes and instance edits, and the latest outcome with the instances. */
  reload?: Reloader;
  /** The library the running set was loaded with, and the packages it came from: the catalogue (GET api/library). */
  library?: { current: () => AnyHeuristic[]; packages: () => PackageInfo[] };
  /** The global pause: GET and POST api/pause. */
  pause?: PauseControl;
  /** A named command from the panel (POST api/command): routed to the instances that answer to it, their keys back. */
  command?: (name: string, args: string[], from: CommandSource) => string[];
  /** The record read back: GET api/timeline. */
  record?: HouseRecord;
  /** Logs what the panel's commands reached. */
  log?: (level: "info", msg: string) => void;
  /** The working set's revisions: api/revisions (list, files, diff, rollback). */
  revisions?: RevisionStore;
  /** The journal the twins are compared in: api/twins (differences, promote). */
  twins?: Pick<JournalReader, "queryEvents">;
  /** Mounts the MCP endpoint (/mcp). */
  mcp?: (app: Hono) => void;
  /** The Connect page: agent tokens and the agent port (api/connect, api/agent-tokens). */
  connect?: ConnectDeps;
  /** Moving the install: api/move (the exports, what the start imported) and api/move/export. */
  move?: MoveDeps;
  panelDistDir: string;
}

export interface RunningServer {
  close(): void;
}

export function startServer(deps: ServerDeps, port: number): RunningServer {
  const app = new Hono();

  app.get("/health", (c) => c.json(deps.health()));

  app.get("/api/heuristics", (c) => c.json({ instances: deps.heuristics(), reload: deps.reload?.last() ?? null }));

  app.get("/api/house", async (c) => c.json(await deps.house.view()));

  // The facts: derived state, each with its value and since (its changes: api/timeline?fact=<id>).
  app.get("/api/facts", (c) => c.json({ facts: deps.facts?.() ?? [] }));

  app.get("/api/house/energy-today", async (c) => {
    try {
      return c.json(await deps.house.energyToday());
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  app.get("/api/device-entities", async (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean).slice(0, 100);
    try {
      return c.json({ devices: await deps.devices.entitiesOf(ids) });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  if (deps.energy !== undefined) mountEnergy(app, deps.energy);
  if (deps.infra !== undefined) {
    const infra = deps.infra;
    app.get("/api/infra", async (c) => c.json(await infra.view()));
  }

  mountStudio(app, deps.studio);
  if (deps.reload !== undefined) {
    mountReload(app, { mode: deps.studio.mode, reloader: deps.reload });
    mountInstanceMode(app, { mode: deps.studio.mode, reloader: deps.reload });
    if (deps.library !== undefined) {
      const { mode, configDir, scope, liveStates } = deps.studio;
      mountInstances(app, { mode, configDir, scope, liveStates, reloader: deps.reload, library: deps.library.current, packages: deps.library.packages });
    }
    if (deps.revisions !== undefined) mountRevisions(app, { mode: deps.studio.mode, store: deps.revisions, reloader: deps.reload });
    if (deps.twins !== undefined) mountTwins(app, { mode: deps.studio.mode, journal: deps.twins, instances: deps.heuristics, reloader: deps.reload });
  }
  if (deps.pause !== undefined) mountPause(app, { mode: deps.studio.mode, pause: deps.pause });
  if (deps.command !== undefined) mountCommand(app, { mode: deps.studio.mode, command: deps.command, ...(deps.log !== undefined ? { log: deps.log } : {}) });
  if (deps.record !== undefined) mountTimeline(app, deps.record);
  deps.mcp?.(app);
  if (deps.connect !== undefined) mountConnect(app, deps.connect);
  if (deps.move !== undefined) mountMove(app, deps.move);

  app.all("/api/*", async (c) => (await deps.readApi.handle(c.req.raw)) ?? c.json({ error: "NotFound" }, 404));

  if (existsSync(join(deps.panelDistDir, "index.html"))) {
    // serveStatic resolves its root relative to process.cwd().
    const root = relative(process.cwd(), deps.panelDistDir);
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: join(root, "index.html") }));
  } else {
    app.get("/", (c) => {
      const h = deps.health();
      return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Teobeanie</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 2rem auto; max-width: 40rem; padding: 0 1rem; line-height: 1.5; }
    .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 1rem; font-size: 0.85rem; }
    .ok { background: #2e7d3230; } .bad { background: #c6282830; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
    dt { font-weight: 600; }
  </style>
</head>
<body>
  <h1>Teobeanie</h1>
  <p>Event-sourced smart-home brain — M0 (watch your house think). Panel build not found.</p>
  <dl>
    <dt>Home Assistant</dt>
    <dd><span class="badge ${h.ha.connected ? "ok" : "bad"}">${h.ha.connected ? "connected" : "disconnected"}</span>
        ${h.ha.haVersion ?? ""}</dd>
    <dt>Events seen</dt><dd>${h.ha.eventsSeen}</dd>
    <dt>Signals appended</dt><dd>${h.bridge.appended} (${h.bridge.routedEntities} routed entities)</dd>
    <dt>Journal events</dt><dd>${h.journal.globalSeq}</dd>
    <dt>Mode</dt><dd>${h.mode}${h.shadowMode ? " · shadow (no actuation)" : ""}${h.pause.paused ? " · paused (only guards act)" : ""}</dd>
  </dl>
  <p><a href="health">health</a> · <a href="api/tiles">tiles</a> · <a href="api/views/nodered-timeline">timeline</a></p>
</body>
</html>`);
    });
  }

  const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
  return { close: () => server.close() };
}

/**
 * The agent port's app: /mcp behind the agent token, and nothing else. No panel, no
 * read API, no writes, no health: every other path is a 404.
 */
export function agentApp(mountMcp: (app: Hono) => void): Hono {
  const app = new Hono();
  mountMcp(app);
  app.all("*", (c) => c.json({ error: "NotFound", reason: "this port serves only /mcp" }, 404));
  return app;
}

/** A port that cannot be opened is logged; the rest of the add-on runs on. */
export function startAgentServer(mountMcp: (app: Hono) => void, port: number, onError: (err: Error) => void): RunningServer {
  const server = serve({ fetch: agentApp(mountMcp).fetch, port, hostname: "0.0.0.0" });
  server.on("error", onError);
  return { close: () => server.close() };
}
