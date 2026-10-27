// surfaces.ts — the commands a voice message may run, as the model sees them: one tool
// per command voice.json lists, typed from its heuristic's commandSchema (the choices,
// ranges and durations of the instances that run now), and the check of a call against
// the same schema before it is sent. Nothing reaches a command that the schema refuses.

import { formatDuration, type CommandArgSpec, type CommandSchema } from "../kernel/heuristic.js";
import type { ToolDef } from "./llm.js";

/** A command a voice message may run, typed. */
export interface Surface {
  command: string;
  schema: CommandSchema;
}

/** The surfaces: the listed commands that have a schema now, and the listed ones that have none. */
export function surfacesOf(listed: string[], schemas: Record<string, CommandSchema>): { surfaces: Surface[]; missing: string[] } {
  const surfaces: Surface[] = [];
  const missing: string[] = [];
  for (const command of listed) {
    const schema = schemas[command];
    if (schema === undefined || schema.args.some((a) => a.kind === "choice" && a.choices.length === 0)) missing.push(command);
    else surfaces.push({ command, schema });
  }
  return { surfaces, missing };
}

function argSchema(a: CommandArgSpec): Record<string, unknown> {
  const doc = a.doc !== undefined ? `${a.doc}` : undefined;
  switch (a.kind) {
    case "choice":
      return { type: "string", enum: a.choices, ...(doc !== undefined ? { description: doc } : {}) };
    case "number": {
      const range = [a.min !== undefined ? `at least ${a.min}` : "", a.max !== undefined ? `at most ${a.max}` : "", a.step !== undefined ? `in steps of ${a.step}` : ""].filter(Boolean).join(", ");
      const description = [doc, a.unit !== undefined ? `In ${a.unit}.` : "", range ? `Allowed: ${range}.` : "", a.or?.length ? `Or one of: ${a.or.join(", ")}.` : ""].filter(Boolean).join(" ");
      // The range is in the description, not as minimum/maximum: a value outside it gets
      // the house's reason back (check), which the model can say, rather than an API error.
      const num = { type: "number" };
      return { ...(a.or?.length ? { anyOf: [num, { type: "string", enum: a.or }] } : num), description };
    }
    case "duration": {
      const description = [
        doc,
        "Minutes.",
        a.maxMin !== undefined ? `At most ${a.maxMin}.` : "",
        a.defaultMin !== undefined ? `Leave it out unless a duration was said: then ${a.defaultMin}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return { type: "integer", description };
    }
  }
}

/** The tool the model calls for a surface. */
export function toolOf(s: Surface): ToolDef {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of s.schema.args) {
    properties[a.name] = argSchema(a);
    if (a.optional !== true) required.push(a.name);
  }
  return { name: s.command, description: s.schema.doc, parameters: { type: "object", properties, required, additionalProperties: false } };
}

/** A call checked: the command's arguments as the chat would type them, or why not. */
export type Checked = { ok: true; args: string[] } | { ok: false; reason: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The model's arguments for a surface, checked against its schema and written as the command takes them. */
export function check(s: Surface, input: unknown): Checked {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "arguments must be an object" };
  const o = input as Record<string, unknown>;
  const known = new Set(s.schema.args.map((a) => a.name));
  for (const k of Object.keys(o)) if (!known.has(k)) return { ok: false, reason: `unknown argument "${k}"` };
  const args: string[] = [];
  let gap: string | undefined;
  for (const a of s.schema.args) {
    let v = o[a.name];
    if (v === undefined || v === null || v === "") {
      if (a.optional !== true) return { ok: false, reason: `${a.name} is required` };
      gap ??= a.name;
      continue;
    }
    if (gap !== undefined) return { ok: false, reason: `${a.name} given without ${gap} before it` };
    switch (a.kind) {
      case "choice": {
        const said = typeof v === "string" ? v.trim().toLowerCase() : undefined;
        const hit = said !== undefined ? a.choices.find((c) => c.toLowerCase() === said) : undefined;
        if (hit === undefined) return { ok: false, reason: `${a.name} must be one of ${a.choices.join(", ")} (got ${JSON.stringify(v)})` };
        args.push(hit);
        break;
      }
      case "number": {
        const said = typeof v === "string" ? v.trim().toLowerCase() : undefined;
        const word = said !== undefined ? a.or?.find((w) => w.toLowerCase() === said) : undefined;
        if (word !== undefined) {
          args.push(word);
          break;
        }
        if (typeof v === "string" && /^-?\d+([.,]\d+)?$/.test(v.trim())) v = Number(v.trim().replace(",", "."));
        if (!isNum(v)) return { ok: false, reason: `${a.name} must be a number${a.or?.length ? ` or ${a.or.join(", ")}` : ""}` };
        if ((a.min !== undefined && v < a.min) || (a.max !== undefined && v > a.max)) {
          return { ok: false, reason: `${a.name} ${v}${a.unit ?? ""} is outside the allowed ${a.min ?? "…"}–${a.max ?? "…"}${a.unit ?? ""}` };
        }
        if (a.step !== undefined && Math.abs(Math.round(v / a.step) * a.step - v) > 1e-9) return { ok: false, reason: `${a.name} goes in steps of ${a.step}` };
        args.push(String(v));
        break;
      }
      case "duration": {
        if (typeof v === "string" && /^\d+$/.test(v.trim())) v = Number(v.trim());
        if (!isNum(v) || !Number.isInteger(v) || v <= 0) return { ok: false, reason: `${a.name} must be a whole number of minutes` };
        if (a.maxMin !== undefined && v > a.maxMin) return { ok: false, reason: `${a.name} ${v} min is longer than the allowed ${a.maxMin} min` };
        args.push(formatDuration(v * 60_000));
        break;
      }
    }
  }
  return { ok: true, args };
}

/** "/warm BG 21 2h": a call as the chat would type it. */
export const commandLine = (command: string, args: string[]): string => `/${command}${args.length > 0 ? " " + args.join(" ") : ""}`;
