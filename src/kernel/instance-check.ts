// instance-check.ts — an instance of heuristics.json checked as the loader checks it,
// plus what an edit from the panel must get right on top: a new id, a known mode. No
// Node imports: the panel's instance editor runs the very check the server runs before
// it writes, and the reload stays the judge of everything a file alone cannot say (the
// house scope, two owners of one entity).

import { checkParams, type ParamSpec } from "./params.js";

export const MODES = ["off", "shadow", "active"] as const;

/** An instance id the panel accepts for a new instance: kebab-case, like a heuristic's. */
export const INSTANCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The instance fields besides heuristic and id, as heuristics.json holds them. */
export interface InstanceFields {
  mode?: unknown;
  params?: unknown;
  alerts?: unknown;
  notifyPerHour?: unknown;
  commandHelp?: unknown;
}

/** The loader's rule for an instance's own notice cap; undefined: fine. */
export function notifyPerHourProblem(v: unknown): string | undefined {
  return v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0)
    ? undefined
    : `notifyPerHour must be a positive whole number, got ${JSON.stringify(v)}`;
}

/** Why this id cannot be a new instance of a heuristic whose instances have `taken` ids; undefined: it can. */
export function newIdProblem(id: unknown, taken: readonly string[]): string | undefined {
  if (typeof id !== "string" || !INSTANCE_ID.test(id)) return `id: lower case letters, digits and dashes (like back-door), got ${JSON.stringify(id ?? "")}`;
  if (taken.includes(id)) return `id: there already is an instance "${id}" of this heuristic`;
  return undefined;
}

/**
 * What is wrong with an instance's fields: one line per problem, the params' with their
 * path ("params.door: expected an entity id ..."). `spec` is the heuristic's parameter
 * schema; without one the params are anything (the reload judges them).
 */
export function checkInstance(spec: ParamSpec | undefined, c: InstanceFields): string[] {
  const out: string[] = [];
  if (c.mode !== undefined && !MODES.includes(c.mode as never)) out.push(`mode: expected off, shadow or active, got ${JSON.stringify(c.mode)}`);
  if (c.alerts !== undefined && typeof c.alerts !== "boolean") out.push(`alerts: expected true or false, got ${JSON.stringify(c.alerts)}`);
  const cap = notifyPerHourProblem(c.notifyPerHour);
  if (cap !== undefined) out.push(cap);
  const help = c.commandHelp;
  if (help !== undefined && (typeof help !== "object" || help === null || Array.isArray(help) || !Object.values(help).every((v) => typeof v === "string"))) {
    out.push(`commandHelp: expected an object of descriptions by command name, got ${JSON.stringify(help)}`);
  }
  if (spec !== undefined) out.push(...checkParams(spec, c.params));
  return out;
}
