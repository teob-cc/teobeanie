// instanceForm.ts — the instance editor's model, without React: a draft of one
// heuristics.json instance, how a heuristic's parameter schema (describeParams) turns
// into form fields and back, and the problems to show next to each field. The check
// is the server's own (src/kernel/instance-check.ts), so a draft the editor accepts
// is one the server accepts; the reload then judges the house scope and the owners.

import { checkInstance, newIdProblem } from "../../src/kernel/instance-check";
import type { ParamField, ParamSpec } from "../../src/kernel/params";
import type { CatalogueEntry, InstanceConfig, InstanceMode, PickerEntity } from "./api";

/** An instance as the editor holds it. */
export interface Draft {
  heuristic: string;
  id: string;
  mode: InstanceMode;
  /** The params as typed: a field that is not valid yet holds what was typed, and its problem says why. */
  params: unknown;
  alerts: boolean;
  /** A number, or what was typed. */
  notifyPerHour?: unknown;
  commandHelp: Record<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A new instance of a heuristic: shadow, nothing set. A param's default shows as its placeholder, not as a value. */
export function newDraft(entry: Pick<CatalogueEntry, "id">): Draft {
  return { heuristic: entry.id, id: "", mode: "shadow", params: {}, alerts: false, commandHelp: {} };
}

/** An instance of heuristics.json as a draft. */
export function draftOf(inst: InstanceConfig): Draft {
  return {
    heuristic: inst.heuristic,
    id: inst.id,
    mode: inst.mode ?? "shadow",
    params: inst.params ?? {},
    alerts: inst.alerts === true,
    ...(inst.notifyPerHour !== undefined ? { notifyPerHour: inst.notifyPerHour } : {}),
    commandHelp: { ...(inst.commandHelp ?? {}) },
  };
}

/** The draft as the endpoints take it: alerts only when on, commandHelp only when it says something. */
export function toInstance(d: Draft): InstanceConfig {
  const help = Object.fromEntries(Object.entries(d.commandHelp).filter(([k, v]) => k.trim() !== "" && v.trim() !== ""));
  return {
    heuristic: d.heuristic,
    id: d.id,
    mode: d.mode,
    params: d.params,
    ...(d.alerts ? { alerts: true } : {}),
    ...(d.notifyPerHour !== undefined ? { notifyPerHour: d.notifyPerHour as number } : {}),
    ...(Object.keys(help).length > 0 ? { commandHelp: help } : {}),
  };
}

/** The heuristic's parameters as one object spec, for checkParams; undefined: no schema. */
export const paramsSpec = (entry: Pick<CatalogueEntry, "params">): ParamSpec | undefined =>
  entry.params === null ? undefined : { kind: "object", required: true, fields: entry.params };

/**
 * Everything wrong with a draft, one line each with its path first ("id: ...",
 * "params.door: ..."). `taken`: the ids the heuristic's instances already have, for a
 * new instance; null when editing one (its id stays).
 */
export function draftProblems(entry: Pick<CatalogueEntry, "params">, d: Draft, taken: string[] | null): string[] {
  const id = taken === null ? undefined : newIdProblem(d.id, taken);
  return [...(id !== undefined ? [id] : []), ...checkInstance(paramsSpec(entry), toInstance(d))];
}

/** The problems about exactly this path, without the path: what the field shows under itself. */
export function problemsAt(problems: string[], path: string): string[] {
  const prefix = `${path}: `;
  return problems.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
}

/** How many problems are about something inside this path (a collapsed section's count). */
export const problemsUnder = (problems: string[], path: string): number =>
  problems.filter((p) => p.startsWith(`${path}.`) || p.startsWith(`${path}[`)).length;

/** A copy of the object with one key set, or removed when the value is undefined. */
export function setField(obj: unknown, name: string, v: unknown): Record<string, unknown> {
  const out = { ...(isObject(obj) ? obj : {}) };
  if (v === undefined) delete out[name];
  else out[name] = v;
  return out;
}

/** A number field's value from what was typed: nothing is unset, a number is a number, anything else stays text (and is a problem). */
export function numberFrom(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : text;
}

/** A desired value from what was typed: a number, attributes as JSON ({"temperature": 21}), else a state. */
export function valueFrom(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (/^[{[]/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** What a value field shows for a value. */
export const valueText = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** The oneOf alternative a value is: the one it has most keys of; -1: none yet. */
export function alternativeOf(spec: ParamSpec, value: unknown): number {
  if (!isObject(value)) return -1;
  let best = -1;
  let most = 0;
  (spec.alternatives ?? []).forEach((a, i) => {
    const shared = (a.fields ?? []).filter((f) => f.name in value).length;
    if (shared > most) [best, most] = [i, shared];
  });
  return best;
}

/** What a field starts as when someone adds it (an optional object, a list item). */
export function blank(spec: ParamSpec): unknown {
  switch (spec.kind) {
    case "object":
    case "texts":
    case "oneOf":
      return {};
    case "list":
    case "entities":
    case "strings":
      return [];
    case "bool":
      return false;
    default:
      return undefined;
  }
}

/** The fields people must fill in, then the ones they may (shown collapsed). */
export function splitFields(fields: ParamField[]): { required: ParamField[]; optional: ParamField[] } {
  return { required: fields.filter((f) => f.required), optional: fields.filter((f) => !f.required) };
}

/** How many of these fields the value sets. */
export const countSet = (fields: ParamField[], value: unknown): number => (isObject(value) ? fields.filter((f) => value[f.name] !== undefined).length : 0);

/** The house's entities a picker offers: those of these domains (none: any). */
export function pickable(entities: PickerEntity[], domains: string[] | undefined): PickerEntity[] {
  return domains === undefined ? entities : entities.filter((e) => domains.includes(e.id.slice(0, e.id.indexOf("."))));
}

/** A default as a placeholder: "5", "on", "[\"on\"]". */
export const placeholderOf = (spec: ParamSpec): string | undefined =>
  spec.default === undefined ? undefined : typeof spec.default === "string" ? spec.default : JSON.stringify(spec.default);

const UNIT_NAME: Record<string, string> = { ms: "ms", s: "seconds", min: "minutes", h: "hours" };

/** What a number or duration is measured in, as shown after its input. */
export const unitOf = (spec: ParamSpec): string | undefined => (spec.kind === "duration" ? UNIT_NAME[spec.unit ?? ""] : spec.unit);

/** A heuristic's params as JSON text, for one without a schema; a problem when it does not parse. */
export function paramsFromJson(text: string): { params: unknown } | { problem: string } {
  try {
    return { params: text.trim() === "" ? {} : (JSON.parse(text) as unknown) };
  } catch (e) {
    return { problem: `params: not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}
