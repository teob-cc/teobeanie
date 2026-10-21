// instances.ts — the panel's instance editor and catalogue, server side. The catalogue
// is the library as the house runs it (its packages and its own files),
// each with its parameters described from its schema; the editor adds, changes and
// removes whole instances of heuristics.json.
//
// Every edit takes the mode command's path (working-set.ts): through Home Assistant
// ingress only, checked as the loader checks it before anything is written, then
// written into the hand-edited file in place, reloaded all or nothing (a rejected
// reload puts the file back) and journaled with the HA user and what changed. The
// reload judges what the file alone cannot: the house scope, two owners of one
// entity, the params of a heuristic without a schema.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context as Ctx, Hono } from "hono";
import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import type { HouseScope } from "./allowlist.js";
import type { AnyHeuristic, Pattern } from "./kernel/heuristic.js";
import type { InstanceConfig } from "./kernel/host.js";
import { checkInstance, newIdProblem } from "./kernel/instance-check.js";
import { DEFAULT_NOTIFY_PER_HOUR } from "./kernel/kernel.js";
import { describeParams, type ParamField } from "./kernel/params.js";
import { requestUser } from "./pause.js";
import type { Reloader } from "./reload.js";
import type { PackageInfo } from "./packages/library.js";
import { mayWrite } from "./studio/files.js";
import { addInstance, describeEdit, INSTANCE_FIELDS, readInstance, readInstances, removeInstance, replaceInstance } from "./working-set.js";

/** One heuristic in the catalogue: GET api/library. */
export interface CatalogueEntry {
  id: string;
  title: string;
  description: string;
  pattern?: Pattern;
  /** A desired-state rule (rule.ts), as opposed to a hand-written decider. */
  rule: boolean;
  /** The house's own: not from the starter set (a file in heuristics/, or a package of its own). */
  own: boolean;
  /** The package it came from; absent: a file in heuristics/. */
  package?: CataloguePackage;
  guarantees?: string;
  /** Its parameters; null: it has no schema, its params are edited as JSON. */
  params: ParamField[] | null;
  /** The notice cap an instance has unless it sets its own. */
  notifyPerHour: number;
}

/** An entity the editor's pickers offer: the house scope, with Home Assistant's names. */
export interface PickerEntity {
  id: string;
  name?: string;
  /** "operate" in allowlist.json: Teobeanie may switch it. */
  operate: boolean;
}

/** A heuristic's package, as the catalogue shows it. */
export interface CataloguePackage {
  name: string;
  version: string;
  /** "starter" (shipped with the add-on), "local"; later a git URL. */
  origin: string;
  /** The house changed it since it was installed. */
  modified: boolean;
}

export function catalogue(library: AnyHeuristic[], packages: PackageInfo[] = []): CatalogueEntry[] {
  return library.map((d) => {
    const pkg = packages.find((p) => p.heuristics.includes(d.id));
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      ...(d.pattern !== undefined ? { pattern: d.pattern } : {}),
      rule: d.kind === "rule",
      own: pkg?.origin !== "starter",
      ...(pkg !== undefined ? { package: { name: pkg.name, version: pkg.version, origin: pkg.origin, modified: pkg.modified } } : {}),
      ...(d.guarantees !== undefined ? { guarantees: d.guarantees } : {}),
      params: describeParams(d) ?? null,
      notifyPerHour: d.notifyPerHour ?? DEFAULT_NOTIFY_PER_HOUR,
    };
  });
}

/** A starting heuristics.json, when the first instance comes from the panel. */
const EMPTY = '{\n  "instances": []\n}\n';

/** An edit refused before anything was written: 422 with the problems, or 404. */
class Refused extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly problems: string[],
  ) {
    super(problems.join("; "));
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body's instance fields, and a problem per key that is none of them. */
function fieldsOf(body: Record<string, unknown>, allowed: readonly string[]): { fields: Partial<InstanceConfig>; unknown: string[] } {
  const fields: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if ((INSTANCE_FIELDS as readonly string[]).includes(k)) fields[k] = v;
    else if (!allowed.includes(k)) unknown.push(`${k}: unknown, expected one of ${[...allowed, ...INSTANCE_FIELDS].join(", ")}`);
  }
  return { fields: fields as Partial<InstanceConfig>, unknown };
}

export interface InstancesDeps {
  mode: "addon" | "standalone";
  reloader: Reloader;
  /** Where heuristics.json is. */
  configDir: string;
  /** The library the running set was loaded with: the packages' heuristics and the house's own files'. */
  library: () => AnyHeuristic[];
  /** The packages it came from: the catalogue says which heuristic is a starter one, and whether the house changed it. */
  packages?: () => PackageInfo[];
  scope: HouseScope;
  liveStates: () => Iterable<HaEntityState>;
}

/**
 * GET api/library: the catalogue and the entities the pickers offer.
 * GET api/instances/<heuristic>/<id>: the instance as heuristics.json has it.
 * POST api/instances { heuristic, id, mode?, params, alerts?, notifyPerHour?, commandHelp? }: add one.
 * PUT api/instances/<heuristic>/<id> { mode?, params, alerts?, notifyPerHour?, commandHelp? }: replace its fields.
 * DELETE api/instances/<heuristic>/<id>: remove it.
 * The writes through Home Assistant ingress only; each answers with the reload's
 * outcome (200, or 422 when the reload rejected it and the file was put back), 422
 * with the problems when the edit was refused before anything was written.
 */
export function mountInstances(app: Hono, deps: InstancesDeps): void {
  app.get("/api/library", (c) => {
    const names = new Map<string, string>();
    for (const s of deps.liveStates()) {
      const n = s.attributes?.friendly_name;
      if (typeof n === "string" && deps.scope.observes(s.entity_id)) names.set(s.entity_id, n);
    }
    const entities: PickerEntity[] = deps.scope.observed.map((id) => ({ id, ...(names.has(id) ? { name: names.get(id)! } : {}), operate: deps.scope.operates(id) }));
    return c.json({ heuristics: catalogue(deps.library(), deps.packages?.() ?? []), entities });
  });

  app.get("/api/instances/:heuristic/:id", (c) => {
    const key = `${c.req.param("heuristic")}/${c.req.param("id")}`;
    const path = join(deps.configDir, "heuristics.json");
    try {
      const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const inst = text === undefined ? undefined : readInstance(text, key);
      return inst === undefined ? c.json({ error: "NotFound", reason: `heuristics.json: no instance ${key}` }, 404) : c.json(inst);
    } catch (err) {
      return c.json({ error: "BadRequest", reason: (err as Error).message }, 400);
    }
  });

  const peerOf = (c: Ctx): string | undefined => (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;

  /** Write one edit through the reload path and answer with its outcome. */
  const run = async (c: Ctx, change: (text: string | undefined) => { text: string; summary: string }) => {
    if (!mayWrite(deps.mode, peerOf(c))) return c.json({ error: "Forbidden", reason: "instances are changed through the Home Assistant panel only" }, 403);
    try {
      const outcome = await deps.reloader.edit({ file: "heuristics.json", by: requestUser((n) => c.req.header(n)), change });
      return c.json(outcome, outcome.ok ? 200 : 422);
    } catch (err) {
      if (err instanceof Refused) return c.json({ ok: false, error: err.message, problems: err.problems }, err.status);
      return c.json({ error: "BadRequest", reason: err instanceof Error ? err.message : String(err) }, 400);
    }
  };

  const bodyOf = async (c: Ctx): Promise<Record<string, unknown> | undefined> => {
    const body: unknown = await c.req.json().catch(() => undefined);
    return isPlainObject(body) ? body : undefined;
  };

  const defOf = (heuristic: unknown): AnyHeuristic | undefined => deps.library().find((d) => d.id === heuristic);

  app.post("/api/instances", async (c) => {
    const body = await bodyOf(c);
    if (body === undefined) return c.json({ error: "BadRequest", reason: 'body: { "heuristic", "id", "mode", "params", ... }' }, 400);
    const { fields, unknown } = fieldsOf(body, ["heuristic", "id"]);
    const def = defOf(body.heuristic);
    const inst = { heuristic: String(body.heuristic), id: String(body.id), mode: "shadow", ...fields, params: fields.params ?? {} } as InstanceConfig;
    const key = `${inst.heuristic}/${inst.id}`;
    return run(c, (text) => {
      const taken = text === undefined ? [] : readInstances(text).filter((i) => i.heuristic === body.heuristic).map((i) => i.id);
      const problems = [
        ...unknown,
        ...(def === undefined ? [`heuristic: unknown heuristic ${JSON.stringify(body.heuristic ?? "")}`] : []),
        ...[newIdProblem(body.id, taken)].filter((p): p is string => p !== undefined),
        ...checkInstance(def?.params?.spec, inst),
      ];
      if (problems.length > 0) throw new Refused(422, problems);
      return { text: addInstance(text ?? EMPTY, inst), summary: describeEdit(key, undefined, inst) };
    });
  });

  app.put("/api/instances/:heuristic/:id", async (c) => {
    const [heuristic, id] = [c.req.param("heuristic"), c.req.param("id")];
    const key = `${heuristic}/${id}`;
    const body = await bodyOf(c);
    if (body === undefined) return c.json({ error: "BadRequest", reason: 'body: { "mode", "params", "alerts", "notifyPerHour", "commandHelp" }' }, 400);
    const { fields, unknown } = fieldsOf(body, ["heuristic", "id"]);
    // Another id is another stream: renaming is removing and adding.
    if ((body.heuristic !== undefined && body.heuristic !== heuristic) || (body.id !== undefined && body.id !== id)) {
      return c.json({ error: "BadRequest", reason: `the body is for another instance than ${key}: renaming one is removing it and adding a new one` }, 400);
    }
    return run(c, (text) => {
      const before = text === undefined ? undefined : readInstance(text, key);
      if (before === undefined) throw new Refused(404, [`heuristics.json: no instance ${key}`]);
      const problems = [...unknown, ...checkInstance(defOf(heuristic)?.params?.spec, { ...fields, params: fields.params ?? {} })];
      if (problems.length > 0) throw new Refused(422, problems);
      const next = replaceInstance(text!, key, { ...fields, params: fields.params ?? {} });
      return { text: next, summary: describeEdit(key, before, readInstance(next, key)) };
    });
  });

  app.delete("/api/instances/:heuristic/:id", (c) => {
    const key = `${c.req.param("heuristic")}/${c.req.param("id")}`;
    return run(c, (text) => {
      if (text === undefined || readInstance(text, key) === undefined) throw new Refused(404, [`heuristics.json: no instance ${key}`]);
      return { text: removeInstance(text, key), summary: describeEdit(key, readInstance(text, key), undefined) };
    });
  });
}
