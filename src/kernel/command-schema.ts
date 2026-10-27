// command-schema.ts — the typed form of the house's commands, merged over the instances
// that answer to them (HeuristicDef.commandSchema). Instances share a command the way
// the climate guards share theirs, each for its own room: their first argument's
// choices add up to the rooms the house has, and a number or a duration keeps to what
// every one of them accepts. The voice lane offers the language model these commands
// only, and checks every call against them before it is sent.

import type { CommandArgSpec, CommandSchema } from "./heuristic.js";

/** One instance's schemas, by command. */
export interface InstanceSchemas {
  key: string;
  schemas: Record<string, CommandSchema>;
}

/** Same name, kind and place: two instances describe the command alike. */
const sameShape = (a: CommandArgSpec[], b: CommandArgSpec[]): boolean =>
  a.length === b.length && a.every((x, i) => x.name === b[i]!.name && x.kind === b[i]!.kind);

/** Two descriptions of one argument as one: choices add up, ranges narrow. */
function mergeArg(a: CommandArgSpec, b: CommandArgSpec): CommandArgSpec {
  if (a.kind === "choice" && b.kind === "choice") {
    return { ...a, choices: [...new Set([...a.choices, ...b.choices])].sort(), optional: a.optional === true && b.optional === true ? true : undefined };
  }
  if (a.kind === "number" && b.kind === "number") {
    const min = a.min === undefined ? b.min : b.min === undefined ? a.min : Math.max(a.min, b.min);
    const max = a.max === undefined ? b.max : b.max === undefined ? a.max : Math.min(a.max, b.max);
    const or = a.or === undefined && b.or === undefined ? undefined : [...new Set([...(a.or ?? []), ...(b.or ?? [])])].sort();
    return { ...a, min, max, or };
  }
  if (a.kind === "duration" && b.kind === "duration") {
    const maxMin = a.maxMin === undefined ? b.maxMin : b.maxMin === undefined ? a.maxMin : Math.min(a.maxMin, b.maxMin);
    return { ...a, maxMin };
  }
  return a;
}

/** Drop the keys left undefined by a merge: a schema is JSON. */
const clean = (arg: CommandArgSpec): CommandArgSpec => Object.fromEntries(Object.entries(arg).filter(([, v]) => v !== undefined)) as CommandArgSpec;

/**
 * Per command, its schema over every instance that gives one: the first instance's doc,
 * the arguments merged by position. An instance that describes a command otherwise (more
 * or fewer arguments, another kind or name in a place) is left out of it, as a problem.
 */
export function mergeCommandSchemas(entries: InstanceSchemas[]): { schemas: Record<string, CommandSchema>; problems: string[] } {
  const schemas: Record<string, CommandSchema> = {};
  const firstOf: Record<string, string> = {};
  const problems: string[] = [];
  for (const { key, schemas: own } of entries) {
    for (const [name, s] of Object.entries(own)) {
      const have = schemas[name];
      if (have === undefined) {
        schemas[name] = { doc: s.doc, args: s.args.map(clean) };
        firstOf[name] = key;
        continue;
      }
      if (!sameShape(have.args, s.args)) {
        problems.push(`${key} describes /${name} otherwise than ${firstOf[name]} (${s.args.map((a) => `${a.name}:${a.kind}`).join(" ")}): left out of its schema`);
        continue;
      }
      have.args = have.args.map((a, i) => clean(mergeArg(a, s.args[i]!)));
    }
  }
  return { schemas, problems };
}
