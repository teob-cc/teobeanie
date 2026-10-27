// journal.ts — every voice message, journaled once handled: who spoke, what was heard,
// what the model made of it (its tool calls and what the house said to each), what ran,
// what the bot answered, the tokens and the cost. The month's spend is folded from here.

import { CategoryId, EntityId, done, objectCodec, persist, stampEnvelope, tagCodec, type Aggregate, type Codec, type JournalReader } from "@lambda-house/teob-ts/core";
import type { TraceStep } from "./loop.js";

export const VOICE_CATEGORY: CategoryId = CategoryId("teob-voice");
export const VOICE_ENTITY: EntityId = EntityId("messages");

export interface VoiceHandled {
  tag: "VoiceHandled";
  at: number;
  /** The id commands it ran carry as their source's ref ("voice:<id>"). */
  voiceId: string;
  by: string;
  chat: string;
  /** Seconds of audio, as the chat said. */
  seconds: number;
  mode: "shadow" | "active";
  /** instruction, not_instruction, clarify, failed, too_long, nothing_heard, budget, unavailable. */
  kind: string;
  transcript?: string;
  stt?: { model?: string; ms: number };
  /** The checked calls, as typed commands. */
  calls: string[];
  /** The instances each call reached (active only), in the order of calls. */
  reached?: string[][];
  reply?: string;
  reason?: string;
  model?: string;
  turns?: number;
  usage?: { input: number; output: number; cost?: number };
  trace?: TraceStep[];
  ms: number;
}

export type VoiceCommand = { tag: "Record"; event: Omit<VoiceHandled, "tag"> };

export const voiceAggregate: Aggregate<VoiceCommand, void, VoiceHandled, { messages: number }> = {
  category: VOICE_CATEGORY,
  initial: () => ({ messages: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag !== "Record") return done();
    return persist(stampEnvelope({ tag: "VoiceHandled", ...cmd.event } satisfies VoiceHandled, { origin: "voice" }));
  },
  apply: (state) => ({ messages: state.messages + 1 }),
};

export const voiceEventCodec: Codec<VoiceHandled> = tagCodec<VoiceHandled>("VoiceHandled");
export const voiceStateCodec: Codec<{ messages: number }> = objectCodec<{ messages: number }>("VoiceState");

/** The first instant of the UTC month `at` falls in. */
export const monthStart = (at: number): number => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** USD the voice lane's model spent since `from`, as journaled. */
export function voiceSpend(journal: Pick<JournalReader, "queryEvents">, from: number): number {
  let sum = 0;
  let cursor: number | undefined;
  for (;;) {
    const page = journal.queryEvents({ category: VOICE_CATEGORY, entityId: VOICE_ENTITY, order: "asc", limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    for (const r of page) {
      const e = r.payload as VoiceHandled | null;
      if (e?.tag === "VoiceHandled" && e.at >= from) sum += e.usage?.cost ?? 0;
    }
    if (page.length < 1000) return sum;
    cursor = page.at(-1)!.globalSeq;
  }
}
