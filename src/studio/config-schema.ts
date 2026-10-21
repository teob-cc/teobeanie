// config-schema.ts — heuristics.json as a JSON Schema, from the heuristics' parameter
// schemas (kernel/params.ts): `cli.js types` writes it to .teob/heuristics.schema.json,
// so an editor completes and checks the instances as the loader will. A heuristic
// without a schema (a rule, most of a house's own) takes any params here too.

import type { AnyHeuristic } from "../kernel/heuristic.js";
import type { ParamField, ParamSpec } from "../kernel/params.js";

type JsonSchema = Record<string, unknown>;

const OBJECT_ID = "[a-z0-9_]+";
const UNITS: Record<string, string> = { ms: "milliseconds", s: "seconds", min: "minutes", h: "hours" };

function entityPattern(domains: string[] | undefined): string {
  return `^${domains === undefined ? OBJECT_ID : `(${domains.join("|")})`}\\.${OBJECT_ID}$`;
}

function describe(s: ParamSpec): JsonSchema {
  const unit = s.kind === "duration" ? UNITS[s.unit ?? ""] : s.unit;
  const description = [s.doc, unit !== undefined ? `(${unit})` : undefined].filter((x) => x !== undefined).join(" ");
  return {
    ...(description !== "" ? { description } : {}),
    ...(s.default !== undefined ? { default: s.default } : {}),
  };
}

function objectOf(fields: ParamField[]): JsonSchema {
  const required = fields.filter((f) => f.required).map((f) => f.name);
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, toJsonSchema(f)])),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** One parameter's spec as JSON Schema (draft-07). */
export function toJsonSchema(s: ParamSpec): JsonSchema {
  const bounds = (floor?: number): JsonSchema => ({
    type: s.integer ? "integer" : "number",
    ...(s.positive ? { exclusiveMinimum: 0 } : (s.min ?? floor) !== undefined ? { minimum: s.min ?? floor } : {}),
    ...(s.max !== undefined ? { maximum: s.max } : {}),
  });
  const of = (): JsonSchema => {
    switch (s.kind) {
      case "entity":
        return { type: "string", pattern: entityPattern(s.domains) };
      case "entities":
        return { type: "array", items: { type: "string", pattern: entityPattern(s.domains) } };
      case "number":
        return bounds();
      case "duration":
        return bounds(0);
      case "bool":
        return { type: "boolean" };
      case "time":
        return { type: "string", pattern: s.seconds ? "^(([01]?\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?|24:00(:00)?)$" : "^(([01]?\\d|2[0-3]):[0-5]\\d|24:00)$" };
      case "text":
      case "string":
        return { type: "string" };
      case "strings":
        return { type: "array", items: { type: "string" } };
      case "value":
        return { type: ["string", "number", "object"] };
      case "texts":
      case "object":
        return objectOf(s.fields ?? []);
      case "list":
        return { type: "array", items: s.item !== undefined ? toJsonSchema(s.item) : {} };
      case "oneOf":
        return { oneOf: (s.alternatives ?? []).map((a) => ({ title: a.name, ...toJsonSchema(a) })) };
    }
  };
  return { ...of(), ...describe(s) };
}

/** heuristics.json for this library: every instance's fields, and each heuristic's params. */
export function heuristicsJsonSchema(library: AnyHeuristic[]): JsonSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Teobeanie heuristics.json",
    type: "object",
    required: ["instances"],
    properties: {
      $schema: { type: "string" },
      instances: {
        type: "array",
        items: {
          type: "object",
          required: ["heuristic", "id"],
          properties: {
            heuristic: { enum: library.map((d) => d.id), description: "The library heuristic (or one of the house's own) this is an instance of." },
            id: { type: "string", description: "The instance's id, unique per heuristic." },
            mode: { enum: ["off", "shadow", "active"], default: "shadow", description: "shadow decides and journals but never acts." },
            alerts: { type: "boolean", description: "Its notices also go to the alerts chat." },
            notifyPerHour: { type: "integer", minimum: 1, description: "Notifications per hour it may send, instead of the heuristic's own cap." },
            params: { type: "object" },
          },
          additionalProperties: false,
          allOf: library
            .filter((d) => d.params !== undefined)
            .map((d) => ({
              if: { properties: { heuristic: { const: d.id } }, required: ["heuristic"] },
              then: { properties: { params: { ...toJsonSchema(d.params!.spec), description: `${d.title}: ${d.description}` } } },
            })),
        },
      },
    },
  };
}
