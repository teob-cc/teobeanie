// service.ts — serves the Infra view (GET api/infra): the bridge's live cache of every
// entity Home Assistant has (the house scope does not limit it: infrastructure is mostly
// outside the scope), the registries (ha-registry.ts, refreshed on registry events) and
// the cards tiles.json puts on the tab. Read-only towards Home Assistant.

import type { HaEntityState } from "@lambda-house/teob-ts/ha";
import type { HaRegistry, HaRegistryReader } from "../ha-registry.js";
import type { InstanceCard } from "../kernel/card.js";
import { infraView, onInfraTab } from "./extract.js";
import type { InfraView } from "./view.js";

export interface InfraConfig {
  /** Instance cards shown on the Infra tab instead of the House page: keys, heuristic ids or globs ("health-watch/*"). */
  cards: string[];
}

export interface InfraService {
  view(): Promise<InfraView>;
  /** A card belongs on the Infra tab (the House page leaves it out). */
  onTab(key: string): boolean;
  configure(next: InfraConfig): void;
}

export function createInfraService(deps: {
  registry: Pick<HaRegistryReader, "get">;
  live: () => ReadonlyMap<string, HaEntityState>;
  cards: () => InstanceCard[];
  config: InfraConfig;
  now?: () => number;
}): InfraService {
  const now = deps.now ?? Date.now;
  let config = deps.config;
  const onTab = (key: string): boolean => onInfraTab(config.cards, key);
  return {
    async view() {
      const registry: Pick<HaRegistry, "ok" | "devices" | "entities"> = await deps.registry.get();
      return infraView({ now: now(), states: deps.live(), registry, cards: deps.cards().filter((c) => onTab(c.key)) });
    },
    onTab,
    configure(next) {
      config = next;
    },
  };
}

/** tiles.json "infra": { "cards": [...] }; absent: no cards on the tab. */
export function parseInfraConfig(raw: unknown, where = "infra"): InfraConfig {
  if (raw === undefined) return { cards: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  for (const k of Object.keys(raw)) if (k !== "cards") throw new Error(`${where}: unknown key "${k}" (cards)`);
  const cards = (raw as { cards?: unknown }).cards;
  if (cards === undefined) return { cards: [] };
  if (!Array.isArray(cards) || !cards.every((c) => typeof c === "string" && c !== "")) throw new Error(`${where}.cards must be a list of instance keys, heuristic ids or globs`);
  return { cards: cards as string[] };
}
