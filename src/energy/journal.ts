// journal.ts — what the energy ledger keeps in the journal (`teob-energy`): the past
// prices it fetched (`teob-energy/prices`), and each day it closed (`teob-energy/ledger`).
// A closed day is the record: Home Assistant purges the states the gas split reads
// after days, and a price history is fetched once. Today is never journaled; it is
// computed from the statistics as it goes.

import {
  CategoryId,
  EntityId,
  categoryTypes,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  type Aggregate,
  type Codec,
  type EntityRuntime,
  type JournalReader,
} from "@lambda-house/teob-ts/core";
import type { DataFlag, Ledger } from "./types.js";

export const ENERGY_CATEGORY: CategoryId = CategoryId("teob-energy");
export const PRICES_ENTITY: EntityId = EntityId("prices");
export const LEDGER_ENTITY: EntityId = EntityId("ledger");

/** Prices fetched for past hours: electricity all-in per hour, or the market gas price per gas day. */
export interface PricesRecorded {
  tag: "PricesRecorded";
  at: number;
  kind: "electricity" | "gas";
  source: "energyzero";
  /** all_in (electricity) or market (gas, with VAT). */
  priceType: "all_in" | "market";
  /** [start, end, price] per slot, ms epoch and €/kWh or €/m³. */
  slots: Array<[number, number, number]>;
}

/** A day closed: its ledger, and what was wrong with its data. A later DayClosed of the same day replaces it. */
export interface DayClosed {
  tag: "DayClosed";
  at: number;
  ledger: Ledger;
  flags: DataFlag[];
  /** The sources and energy.json it was closed with: a day closed with others is closed again. */
  fingerprint?: string;
}

export type EnergyEvent = PricesRecorded | DayClosed;
type EnergyCommand = { tag: "Record"; events: EnergyEvent[] };

export const energyAggregate: Aggregate<EnergyCommand, void, EnergyEvent, { events: number }> = {
  category: ENERGY_CATEGORY,
  initial: () => ({ events: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag !== "Record" || cmd.events.length === 0) return done();
    return persist(...cmd.events.map((e) => stampEnvelope(e, { origin: "system" })));
  },
  apply: (state) => ({ events: state.events + 1 }),
};

export const energyEventCodec: Codec<EnergyEvent> = tagCodec<EnergyEvent>("PricesRecorded", "DayClosed");
export const energyStateCodec: Codec<{ events: number }> = objectCodec<{ events: number }>("EnergyState");

/** Journal prices or closed days, in one batch per stream; resolves once persisted. */
export function createEnergyJournal(runtime: Pick<EntityRuntime, "ask">): (events: EnergyEvent[]) => Promise<void> {
  const cat = categoryTypes<EnergyCommand, void>(ENERGY_CATEGORY);
  return async (events) => {
    for (const [entity, of] of [
      [PRICES_ENTITY, events.filter((e) => e.tag === "PricesRecorded")],
      [LEDGER_ENTITY, events.filter((e) => e.tag === "DayClosed")],
    ] as const) {
      if (of.length === 0) continue;
      const res = await runtime.ask(entity, { tag: "Record", events: of }, cat);
      if (!res.ok) throw new Error(`energy journal: ${JSON.stringify(res.error)}`);
    }
  };
}

/** Every event of a stream, oldest first. */
export function readStream(journal: Pick<JournalReader, "queryEvents">, entityId: EntityId): EnergyEvent[] {
  const out: EnergyEvent[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = journal.queryEvents({ category: ENERGY_CATEGORY, entityId, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    for (const r of page) {
      const e = r.payload as EnergyEvent | null;
      if (e?.tag === "PricesRecorded" || e?.tag === "DayClosed") out.push(e);
    }
    if (page.length < 1000) return out;
    cursor = page.at(-1)!.globalSeq;
  }
}
