// card.ts — an instance's card for the House page: its heuristic's view() over the
// state it holds, its params and the live values of the entities it declares. The
// buttons are checked here: each runs one of the instance's own commands, with a few
// short arguments, as POST api/command takes them (src/command.ts).

import type { AnyHeuristic, Card, CardButton, Observed } from "./heuristic.js";

/** An instance's card with whose it is: GET api/house and the house frames carry these. */
export interface InstanceCard {
  /** heuristic/instance */
  key: string;
  heuristic: string;
  id: string;
  mode: "active" | "shadow";
  /** Absent when view() gave none or failed. */
  card?: Card;
  /** view() threw, or a button was left out: why. */
  error?: string;
}

/** What a button may send: as api/command takes a command (src/command.ts). */
const NAME = /^[A-Za-z0-9_]{1,32}$/;
const MAX_ARGS = 8;
const MAX_ARG = 64;

export interface CardInstance {
  key: string;
  id: string;
  params: unknown;
  mode: "active" | "shadow";
  /** What it watches and reads: all a view may see. */
  entities: string[];
  /** The commands it answers to: all a button may run. */
  commands: string[];
}

/** The instance's card; a throwing view() or an unfit button is an error on it, never a throw. */
export function instanceCard(def: AnyHeuristic, inst: CardInstance, state: unknown, observe: (entity: string) => Observed | undefined): InstanceCard {
  const head = { key: inst.key, heuristic: def.id, id: inst.id, mode: inst.mode };
  if (def.view === undefined) return head;
  const declared = new Set(inst.entities);
  const get = (e: string): Observed | undefined => (declared.has(e) ? observe(e) : undefined);
  let card: Card | undefined;
  try {
    card = def.view(state ?? def.initial(inst.params), { params: inst.params, instance: inst.id, get, value: (e) => get(e)?.value });
  } catch (err) {
    return { ...head, error: `view: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (card === undefined) return head;
  const dropped: string[] = [];
  const fit = (b: CardButton): boolean => {
    const args = b.args ?? [];
    const why = !NAME.test(b.command) || !inst.commands.some((c) => c.toLowerCase() === b.command.toLowerCase())
      ? `/${b.command} is not one of its commands`
      : args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length > 0 && a.length <= MAX_ARG)
        ? `/${b.command}: at most ${MAX_ARGS} arguments of 1 to ${MAX_ARG} characters`
        : undefined;
    if (why !== undefined) dropped.push(`button "${b.label}" left out: ${why}`);
    return why === undefined;
  };
  const buttons = card.buttons?.filter(fit);
  const out: Card = { title: card.title, fields: card.fields, ...(buttons !== undefined && buttons.length > 0 ? { buttons } : {}) };
  return { ...head, card: out, ...(dropped.length > 0 ? { error: dropped.join("; ") } : {}) };
}
