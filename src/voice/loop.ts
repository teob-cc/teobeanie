// loop.ts — the intent loop: a transcript in, the commands it asks for out. The model
// sees only the voice surfaces (surfaces.ts) and three ways to answer without one; every
// call is checked against its command's schema here, and a refused call goes back to
// the model with the reason, for at most a few turns. Nothing here acts: the voice lane
// sends what comes out through the command lane, where the behaviours decide.

import type { ChatClient, ChatMessage, ToolDef } from "./llm.js";
import { check, commandLine, toolOf, type Surface } from "./surfaces.js";

/** A checked call: the command and its arguments as the chat would type them. */
export interface VoiceCall {
  command: string;
  args: string[];
}

/** One tool call the model made and what became of it, for the journal. */
export interface TraceStep {
  turn: number;
  tool: string;
  arguments: string;
  /** accepted, a meta answer, or refused with the reason. */
  result: string;
}

export interface Understood {
  /** instruction: commands (and maybe a word about a refused one); not_instruction; clarify: a question back; failed. */
  kind: "instruction" | "not_instruction" | "clarify" | "failed";
  calls: VoiceCall[];
  /** What the model says to the speaker, in their language. */
  reply?: string;
  /** failed: why. */
  reason?: string;
  turns: number;
  model: string;
  usage: { input: number; output: number; cost?: number };
  trace: TraceStep[];
}

export interface UnderstandInput {
  transcript: string;
  /** Who spoke, as the chat names them. */
  speaker?: string;
  surfaces: Surface[];
  /** The speakers' language ("ru"); empty: theirs, whatever it is. */
  language: string;
  /** The house's words for its rooms and things. */
  glossary: string[];
  /** What the commands act on, now: one line each. */
  context: string[];
  /** House-local time, as people say it ("Tuesday 2026-10-27 11:50"). */
  now: string;
  maxCalls: number;
  maxTurns?: number;
}

const META: ToolDef[] = [
  {
    name: "not_an_instruction",
    description: "The message holds no instruction for the house: talk between people, a shopping list, a question no tool answers. Say so in one short sentence.",
    parameters: {
      type: "object",
      properties: { reply: { type: "string", description: "One short sentence in the speaker's language: this is not an instruction for the house." } },
      required: ["reply"],
      additionalProperties: false,
    },
  },
  {
    name: "ask",
    description: "The message is an instruction for the house, but you cannot place it (which room? which value?). Ask one short question.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "One short question in the speaker's language." } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "say",
    description: "After the house refused a call: tell the speaker briefly what was not done and why (the reason the house gave). Not for anything else.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "One or two short sentences in the speaker's language." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

export function systemPrompt(i: UnderstandInput): string {
  const lang = i.language ? `The speakers speak ${i.language}; write every reply in it.` : "Write every reply in the speaker's language.";
  return [
    "You turn a voice message, written down by speech to text, into commands for a house's automation.",
    "You never switch anything yourself: you call tools; the house checks each call, runs it, and its behaviours answer the speaker.",
    "",
    "Rules:",
    "- Answer with tool calls only.",
    `- One call per thing asked, at most ${i.maxCalls} in all. Several things in one message: several calls.`,
    "- Speech to text mishears: read the transcript for its meaning (a word that sounds like a room or a command word is that word).",
    "- Use only the rooms and values the tools take; the house's words below say what its people call them. A group (a floor, a level) is one call per room in it.",
    "- A value outside what a tool allows: call it anyway with the value said; the house refuses it with the reason, and you tell the speaker with say.",
    "- A value (a temperature, a duration) only when one was said: never make one up. A command that needs a value nobody said: ask.",
    "- Nothing for the house in the message: not_an_instruction. An instruction you cannot place: ask.",
    `- ${lang} Keep replies short and plain.`,
    "",
    ...(i.glossary.length > 0 ? ["The house's words:", ...i.glossary.map((g) => `- ${g}`), ""] : []),
    `Now: ${i.now}.`,
    ...(i.context.length > 0 ? ["What the commands act on, now:", ...i.context.map((c) => `- ${c}`)] : []),
  ].join("\n");
}

const parseArgs = (text: string): unknown => {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return undefined;
  }
};

export async function understand(llm: ChatClient, i: UnderstandInput): Promise<Understood> {
  const maxTurns = i.maxTurns ?? 3;
  const bySurface = new Map(i.surfaces.map((s) => [s.command, s]));
  const tools = [...i.surfaces.map(toolOf), ...META];
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(i) },
    { role: "user", content: `${i.speaker ? `${i.speaker} said` : "Said"}: «${i.transcript}»` },
  ];
  const calls: VoiceCall[] = [];
  const trace: TraceStep[] = [];
  const usage: Understood["usage"] = { input: 0, output: 0 };
  let model = llm.model;
  const done = (rest: Pick<Understood, "kind"> & Partial<Understood>, turns: number): Understood => ({ calls, turns, model, usage, trace, ...rest });

  for (let turn = 1; turn <= maxTurns; turn++) {
    const c = await llm.complete({ messages, tools });
    model = c.model;
    usage.input += c.usage.input;
    usage.output += c.usage.output;
    if (c.usage.cost !== undefined) usage.cost = (usage.cost ?? 0) + c.usage.cost;
    if (c.calls.length === 0) return done({ kind: calls.length > 0 ? "instruction" : "failed", reason: "the model called no tool", ...(c.text ? { reply: c.text } : {}) }, turn);

    let meta: { kind: Understood["kind"]; reply: string } | undefined;
    let refused = false;
    const results: Array<{ id: string; content: string }> = [];
    for (const tc of c.calls) {
      const args = parseArgs(tc.arguments);
      let result: string;
      const surface = bySurface.get(tc.name);
      if (tc.name === "not_an_instruction" || tc.name === "ask" || tc.name === "say") {
        const o = (args ?? {}) as Record<string, unknown>;
        const text = typeof o.reply === "string" ? o.reply : typeof o.question === "string" ? o.question : typeof o.text === "string" ? o.text : "";
        if (text.trim() === "") {
          result = "refused: the text is empty";
          refused = true;
        } else {
          meta = { kind: tc.name === "not_an_instruction" ? "not_instruction" : tc.name === "ask" ? "clarify" : "instruction", reply: text.trim() };
          result = "noted";
        }
      } else if (surface === undefined) {
        result = `refused: no tool "${tc.name}"`;
        refused = true;
      } else {
        const checked = args === undefined ? ({ ok: false, reason: "arguments are not JSON" } as const) : check(surface, args);
        const line = checked.ok ? commandLine(surface.command, checked.args) : "";
        if (!checked.ok) {
          result = `refused: ${checked.reason}`;
          refused = true;
        } else if (calls.some((x) => commandLine(x.command, x.args) === line)) {
          result = `already accepted: ${line}; do not repeat it`;
        } else if (calls.length >= i.maxCalls) {
          result = `refused: at most ${i.maxCalls} commands from one message`;
          refused = true;
        } else {
          calls.push({ command: surface.command, args: checked.args });
          result = `accepted: ${line} (it will run; do not repeat it)`;
        }
      }
      trace.push({ turn, tool: tc.name, arguments: tc.arguments.slice(0, 500), result });
      results.push({ id: tc.id, content: result });
    }
    if (meta !== undefined) return done(meta, turn);
    if (!refused) return done({ kind: "instruction" }, turn);
    // A refusal: the model hears why, and may correct the call, ask, or say so.
    messages.push({ role: "assistant", content: c.text, tool_calls: c.calls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) });
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
  return done({ kind: calls.length > 0 ? "instruction" : "failed", reason: `no answer after ${maxTurns} turns` }, maxTurns);
}
