// scope-edit.ts — allowlist.json edited in place, like heuristics.json (working-set.ts):
// an entity added to the house scope after the last one, in the layout of the others,
// or one entity's "operate" set, and the rest of the hand-written file as it was. The
// MCP tools scope_add (observe only) and scope_operate (with a reason) use these; the
// reload is still the judge of the result.

import { locateJson, type JsonNode } from "./working-set.js";

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

function entitiesArray(text: string): JsonNode & { items: JsonNode[] } {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`allowlist.json: unparseable JSON: ${(err as Error).message}`);
  }
  const list = locateJson(text).members?.find((m) => m.key === "entities")?.value;
  if (list?.items === undefined) throw new Error('allowlist.json: missing "entities" array');
  return list as JsonNode & { items: JsonNode[] };
}

const idOf = (o: JsonNode): unknown => o.members?.find((m) => m.key === "id")?.value.value;

/** The entry of an entity, as written; undefined when the scope does not list it. */
export function scopeEntry(text: string, entity: string): { id: string; operate?: boolean } | undefined {
  const o = entitiesArray(text).items.find((x) => idOf(x) === entity);
  return o === undefined ? undefined : (JSON.parse(text.slice(o.start, o.end)) as { id: string; operate?: boolean });
}

/** allowlist.json's text with the entity added (observed, not operated), after the last entry and in its layout. */
export function addScopeEntity(text: string, entity: string): string {
  if (!ENTITY_ID.test(entity)) throw new Error(`${entity} is not an entity id`);
  const list = entitiesArray(text);
  if (list.items.some((o) => idOf(o) === entity)) throw new Error(`${entity} is already in the house scope`);
  const spaced = !/"id":"/.test(text);
  const entry = spaced ? `{ "id": ${JSON.stringify(entity)} }` : `{"id":${JSON.stringify(entity)}}`;
  const last = list.items.at(-1);
  if (last === undefined) {
    const lineStart = text.lastIndexOf("\n", list.start) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
    return `${text.slice(0, list.start)}[\n${indent}  ${entry}\n${indent}]${text.slice(list.end)}`;
  }
  const before = text.slice(text.lastIndexOf("\n", last.start - 1) + 1, last.start);
  const sep = /^[ \t]*$/.test(before) ? `,\n${before}` : spaced ? ", " : ",";
  return text.slice(0, last.end) + sep + entry + text.slice(last.end);
}

/** allowlist.json's text with the entity's "operate" set to true (it must be in the scope already). */
export function setScopeOperate(text: string, entity: string): string {
  const o = entitiesArray(text).items.find((x) => idOf(x) === entity);
  if (o === undefined) throw new Error(`${entity} is not in the house scope: add it with scope_add first`);
  const members = o.members!;
  const current = members.find((m) => m.key === "operate");
  if (current !== undefined) return text.slice(0, current.value.start) + "true" + text.slice(current.value.end);
  const lastMember = members.at(-1)!;
  const colon = text.slice(lastMember.keyEnd, lastMember.value.start);
  return `${text.slice(0, lastMember.value.end)}, "operate"${colon}true${text.slice(lastMember.value.end)}`;
}
