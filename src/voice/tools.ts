// tools.ts — the voice lane over MCP: voice_try runs phrases through the same loop a
// voice message takes (the same surfaces, schemas and model), as if heard, and runs
// nothing. With expectations it is the house's eval: say what each phrase must become.

import type { MCPTool } from "@lambda-house/teob-ts/ai";
import { tool } from "../mcp/tools.js";
import type { VoiceLane, VoiceTrial } from "./lane.js";

const MAX_PHRASES = 20;

/** "/warm hall 21 2h; /pet away", "not_instruction" or "clarify": what a phrase must become. */
export function meets(t: VoiceTrial, expect: string): boolean {
  const e = expect.trim();
  if (e === "not_instruction" || e === "clarify" || e === "failed") return t.kind === e;
  const want = e.split(";").map((c) => c.trim().replace(/\s+/g, " ")).filter(Boolean).sort();
  return t.kind === "instruction" && JSON.stringify([...t.calls].sort()) === JSON.stringify(want);
}

export function createVoiceTools(deps: { lane: VoiceLane; caller: () => string }): MCPTool[] {
  return [
    tool(
      "voice_try",
      `Try phrases as if someone had said them in the chat: the voice lane's own loop (voice.json's commands, their schemas as the instances run now, its glossary and model) says what each would run, or that it is not an instruction, or what it would ask back. Nothing runs, in any voice mode; each phrase is one model call or a few, journaled (teob-voice, chat "mcp") and counted in the month's budget. expect (optional, one per phrase): the commands it must become, "; "-separated as typed ("/warm hall 21 2h; /cat away"), or not_instruction, clarify; the answer then says which pass. At most ${MAX_PHRASES} phrases.`,
      {
        say: { type: "array", items: { type: "string" }, description: "the phrases, in the speakers' language" },
        expect: { type: "array", items: { type: "string" }, description: "per phrase: what it must become" },
      },
      async (args) => {
        const say = args.say;
        const expect = args.expect;
        if (!Array.isArray(say) || say.length === 0 || say.length > MAX_PHRASES || !say.every((s) => typeof s === "string" && s.trim() !== "")) {
          throw new Error(`say: 1 to ${MAX_PHRASES} phrases`);
        }
        if (expect !== undefined && (!Array.isArray(expect) || expect.length !== say.length || !expect.every((s) => typeof s === "string"))) {
          throw new Error("expect: one string per phrase");
        }
        const results: Array<VoiceTrial & { expect?: string; pass?: boolean }> = [];
        for (let i = 0; i < say.length; i++) {
          const t = await deps.lane.trial((say[i] as string).trim(), deps.caller());
          const e = expect?.[i] as string | undefined;
          results.push(e === undefined ? t : { ...t, expect: e, pass: meets(t, e) });
        }
        const cost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
        return {
          ...(expect !== undefined ? { passed: results.filter((r) => r.pass).length, of: results.length } : {}),
          cost_usd: Math.round(cost * 1e6) / 1e6,
          results,
        };
      },
    ),
  ];
}
