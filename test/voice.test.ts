// voice: a voice message heard, understood into typed commands within their schemas,
// and run (or, in shadow, only said) — with a scripted model, a fake speech to text and
// a fake Bot API.

import { describe, expect, it } from "vitest";
import type { CommandSchema, CommandSource } from "../src/kernel/heuristic.js";
import { NO_VOICE, parseVoiceFile, type VoiceFile } from "../src/voice/file.js";
import type { VoiceHandled } from "../src/voice/journal.js";
import { createVoiceLane, type VoiceIo } from "../src/voice/lane.js";
import { createChatClient, type ChatClient, type ChatMessage, type Completion, type ToolCall } from "../src/voice/llm.js";
import { understand, type UnderstandInput } from "../src/voice/loop.js";
import { createTranscriber, siblingWhisperUrl } from "../src/voice/stt.js";
import { check, surfacesOf, toolOf } from "../src/voice/surfaces.js";
import { createTelegramReceiver } from "../src/telegram.js";

const SCHEMAS: Record<string, CommandSchema> = {
  warm: {
    doc: "Heat a room to a temperature for a while.",
    args: [
      { name: "room", kind: "choice", choices: ["den", "attic", "hall"] },
      { name: "temperature", kind: "number", min: 17, max: 22, step: 0.5, unit: "°C", or: ["off"] },
      { name: "duration", kind: "duration", maxMin: 720, defaultMin: 180, optional: true },
    ],
  },
  pet: { doc: "Tell where the cat is.", args: [{ name: "where", kind: "choice", choices: ["home", "away"] }] },
  garage_open: { doc: "Open the garage door.", args: [] },
};
const { surfaces } = surfacesOf(["warm", "pet"], SCHEMAS);
const warm = surfaces[0]!;

describe("surfaces", () => {
  it("only the commands voice.json lists, and only those with a schema", () => {
    const r = surfacesOf(["warm", "pet", "lights"], SCHEMAS);
    expect(r.surfaces.map((s) => s.command)).toEqual(["warm", "pet"]);
    expect(r.missing).toEqual(["lights"]);
  });

  it("a tool per command: choices as an enum, the range and the words in the description, optional args not required", () => {
    const t = toolOf(warm);
    expect(t.name).toBe("warm");
    const p = t.parameters as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(p.properties.room).toEqual({ type: "string", enum: ["den", "attic", "hall"] });
    expect(p.properties.temperature!.description).toContain("at least 17, at most 22");
    expect(p.properties.temperature!.anyOf).toEqual([{ type: "number" }, { type: "string", enum: ["off"] }]);
    expect(p.required).toEqual(["room", "temperature"]);
  });

  it("checks a call and writes it as the chat would type it", () => {
    expect(check(warm, { room: "Den", temperature: 21, duration: 120 })).toEqual({ ok: true, args: ["den", "21", "2h"] });
    expect(check(warm, { room: "den", temperature: "20,5" })).toEqual({ ok: true, args: ["den", "20.5"] });
    expect(check(warm, { room: "den", temperature: "off" })).toEqual({ ok: true, args: ["den", "off"] });
    expect(check(warm, { room: "den", temperature: 21, duration: 90 })).toEqual({ ok: true, args: ["den", "21", "90m"] });
  });

  it("refuses what the schema does not allow, saying why", () => {
    expect(check(warm, { room: "garage", temperature: 21 })).toMatchObject({ ok: false, reason: expect.stringContaining("one of den, attic, hall") });
    expect(check(warm, { room: "den", temperature: 25 })).toMatchObject({ ok: false, reason: "temperature 25°C is outside the allowed 17–22°C" });
    expect(check(warm, { room: "den", temperature: 21.3 })).toMatchObject({ ok: false, reason: "temperature goes in steps of 0.5" });
    expect(check(warm, { room: "den", temperature: 21, duration: 800 })).toMatchObject({ ok: false });
    expect(check(warm, { room: "den" })).toMatchObject({ ok: false, reason: "temperature is required" });
    expect(check(warm, { room: "den", temperature: 21, entity: "climate.x" })).toMatchObject({ ok: false, reason: 'unknown argument "entity"' });
  });
});

/** A model that answers from a script: each turn, the tool calls given (and what it was sent, for the asserts). */
function scripted(turns: Array<Array<[string, Record<string, unknown>]>>, cost = 0.0003): ChatClient & { sent: ChatMessage[][] } {
  const sent: ChatMessage[][] = [];
  let n = 0;
  return {
    model: "test/model",
    sent,
    async complete({ messages }): Promise<Completion> {
      sent.push(structuredClone(messages));
      const turn = turns[n++] ?? [];
      const calls: ToolCall[] = turn.map(([name, args], i) => ({ id: `c${n}_${i}`, name, arguments: JSON.stringify(args) }));
      return { text: null, calls, model: "test/model", usage: { input: 1000, output: 50, cost } };
    },
  };
}

const input = (transcript: string, over: Partial<UnderstandInput> = {}): UnderstandInput => ({
  transcript,
  speaker: "alex",
  surfaces,
  language: "ru",
  glossary: ["внизу = hall", "второй уровень = den и attic"],
  context: ["Climate guard den: Mode heat; Setpoint 20°C"],
  now: "Tuesday 27/10/2026, 11:50",
  maxCalls: 4,
  ...over,
});

describe("understand", () => {
  it("one message, several commands: each checked, in one turn", async () => {
    const llm = scripted([[["warm", { room: "hall", temperature: 21, duration: 120 }], ["warm", { room: "den", temperature: 20 }], ["warm", { room: "attic", temperature: 20 }]]]);
    const u = await understand(llm, input("поставь отопление внизу на 21 на два часа, а на втором уровне 20"));
    expect(u.kind).toBe("instruction");
    expect(u.calls).toEqual([
      { command: "warm", args: ["hall", "21", "2h"] },
      { command: "warm", args: ["den", "20"] },
      { command: "warm", args: ["attic", "20"] },
    ]);
    expect(u.turns).toBe(1);
    expect(u.usage).toEqual({ input: 1000, output: 50, cost: 0.0003 });
    const system = (llm.sent[0]![0] as { content: string }).content;
    expect(system).toContain("внизу = hall");
    expect(system).toContain("Climate guard den: Mode heat");
    expect(system).toContain("write every reply in it");
  });

  it("not an instruction: the model says so, nothing runs", async () => {
    const u = await understand(scripted([[["not_an_instruction", { reply: "Это не команда для дома." }]]]), input("купи молоко"));
    expect(u).toMatchObject({ kind: "not_instruction", calls: [], reply: "Это не команда для дома." });
  });

  it("a refused call goes back with the reason; the model then says why, and what was accepted still runs", async () => {
    const llm = scripted([[["pet", { where: "away" }], ["warm", { room: "den", temperature: 25 }]], [["say", { text: "25° нельзя: от 17 до 22." }]]]);
    const u = await understand(llm, input("кот ушёл, и поставь 25 в den"));
    expect(u.kind).toBe("instruction");
    expect(u.calls).toEqual([{ command: "pet", args: ["away"] }]);
    expect(u.reply).toBe("25° нельзя: от 17 до 22.");
    expect(u.turns).toBe(2);
    const tools = llm.sent[1]!.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(tools).toEqual(["accepted: /pet away (it will run; do not repeat it)", "refused: temperature 25°C is outside the allowed 17–22°C"]);
  });

  it("a repeated call is not run twice; a model that never gets it right fails after the turns", async () => {
    const llm = scripted([[["warm", { room: "x", temperature: 21 }]], [["warm", { room: "y", temperature: 21 }]], [["warm", { room: "z", temperature: 21 }]]]);
    const u = await understand(llm, input("..."));
    expect(u).toMatchObject({ kind: "failed", calls: [], turns: 3, reason: "no answer after 3 turns" });
  });

  it("at most maxCalls commands", async () => {
    const llm = scripted([[["pet", { where: "home" }], ["warm", { room: "den", temperature: 20 }]], [["say", { text: "Только одна команда." }]]]);
    const u = await understand(llm, input("...", { maxCalls: 1 }));
    expect(u.calls).toEqual([{ command: "pet", args: ["home"] }]);
    expect(u.trace[1]!.result).toBe("refused: at most 1 commands from one message");
  });

  it("a tool that is not a surface is refused, so the model cannot reach anything else", async () => {
    const llm = scripted([[["garage_open", {}]], [["say", { text: "Не могу." }]]]);
    const u = await understand(llm, input("открой гараж"));
    expect(u.calls).toEqual([]);
    expect(u.trace[0]!.result).toBe('refused: no tool "garage_open"');
  });
});

const VOICE: VoiceFile = parseVoiceFile({
  mode: "active",
  commands: ["warm", "pet"],
  language: "ru",
  vocabulary: "отопление, кот",
  glossary: ["внизу = hall"],
  texts: { heard: "🎙 {by}: «{text}»", shadow: "(тень: ничего не запущено)", failed: "Не понял." },
});

function laneHarness(o: { file?: VoiceFile; heard?: string; llm?: ChatClient; spent?: number; sttFails?: boolean } = {}) {
  const replies: string[] = [];
  const reactions: string[] = [];
  const dispatched: Array<{ name: string; args: string[]; from: CommandSource }> = [];
  const records: Array<Omit<VoiceHandled, "tag">> = [];
  const stt: Array<{ language?: string; prompt?: string }> = [];
  const lane = createVoiceLane({
    file: () => o.file ?? VOICE,
    transcriber: {
      url: "http://whisper",
      async transcribe(_audio, opts) {
        stt.push({ ...(opts.language ? { language: opts.language } : {}), ...(opts.prompt ? { prompt: opts.prompt } : {}) });
        if (o.sttFails) throw new Error("speech to text 503: loading");
        return { text: o.heard ?? "кот ушёл гулять", ms: 2800, model: "small" };
      },
    },
    llm: () => o.llm,
    schemas: () => SCHEMAS,
    context: () => [],
    dispatch: (name, args, from) => {
      dispatched.push({ name, args, from });
      return [`${name}/main`];
    },
    houseTime: () => "Tuesday 11:50",
    spent: () => o.spent ?? 0,
    budgetUsd: 10,
    record: (e) => records.push(e),
    log: () => undefined,
  });
  const io: VoiceIo = {
    download: async () => new Uint8Array([1, 2, 3]),
    reply: async (t) => void replies.push(t),
    react: async (e) => void reactions.push(e),
  };
  const take = (seconds = 3) => lane.take({ chat: "-1001", messageId: 7, by: "alex", seconds, at: 0 }, io);
  return { lane, take, replies, reactions, dispatched, records, stt };
}

describe("the voice lane", () => {
  it("active: heard, understood, run as the speaker; the answer is the transcript and the commands", async () => {
    const h = laneHarness({ llm: scripted([[["pet", { where: "away" }]]]) });
    await h.take();
    expect(h.stt).toEqual([{ language: "ru", prompt: "отопление, кот" }]);
    expect(h.reactions).toEqual(["👀"]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ name: "pet", args: ["away"], from: { channel: "voice", user: "alex" } });
    expect(h.dispatched[0]!.from.ref).toMatch(/^voice:/);
    expect(h.replies).toEqual(["🎙 alex: «кот ушёл гулять»\n→ /pet away"]);
    expect(h.records[0]).toMatchObject({ kind: "instruction", mode: "active", transcript: "кот ушёл гулять", calls: ["/pet away"], reached: [["pet/main"]], usage: { cost: 0.0003 } });
    expect(h.records[0]!.voiceId).toBe(h.dispatched[0]!.from.ref!.slice("voice:".length));
  });

  it("shadow: says what it would run, runs nothing", async () => {
    const h = laneHarness({ file: { ...VOICE, mode: "shadow" }, llm: scripted([[["pet", { where: "home" }]]]) });
    await h.take();
    expect(h.dispatched).toEqual([]);
    expect(h.replies).toEqual(["🎙 alex: «кот ушёл гулять»\n→ /pet home\n(тень: ничего не запущено)"]);
    expect(h.records[0]).toMatchObject({ mode: "shadow", calls: ["/pet home"] });
    expect(h.records[0]!.reached).toBeUndefined();
  });

  it("not an instruction: the model's words, nothing run", async () => {
    const h = laneHarness({ heard: "купи молоко", llm: scripted([[["not_an_instruction", { reply: "Это не команда для дома." }]]]) });
    await h.take();
    expect(h.dispatched).toEqual([]);
    expect(h.replies).toEqual(["🎙 alex: «купи молоко»\nЭто не команда для дома."]);
  });

  it("no model yet: the transcript still comes back, with why nothing runs", async () => {
    const h = laneHarness();
    await h.take();
    expect(h.replies[0]).toBe(`🎙 alex: «кот ушёл гулять»\n${NO_VOICE.texts.unavailable}`);
    expect(h.records[0]).toMatchObject({ kind: "unavailable", reason: "no model configured" });
  });

  it("too long, a spent budget, speech to text down, voice off", async () => {
    const long = laneHarness({ llm: scripted([]) });
    await long.take(120);
    expect(long.replies).toEqual(["Voice messages up to 60 s only."]);
    const broke = laneHarness({ llm: scripted([]), spent: 10 });
    await broke.take();
    expect(broke.replies[0]).toContain(NO_VOICE.texts.budget);
    const down = laneHarness({ llm: scripted([]), sttFails: true });
    await down.take();
    expect(down.records[0]).toMatchObject({ kind: "unavailable", reason: "Error: speech to text 503: loading" });
    const off = laneHarness({ file: NO_VOICE });
    await off.take();
    expect(off.replies).toEqual([]);
    expect(off.records).toEqual([]);
    expect(off.lane.enabled()).toBe(false);
  });

  it("messages are handled one at a time, in order", async () => {
    const h = laneHarness({ llm: scripted([[["pet", { where: "away" }]], [["pet", { where: "home" }]]]) });
    await Promise.all([h.take(), h.take()]);
    expect(h.dispatched.map((d) => d.args[0])).toEqual(["away", "home"]);
  });
});

describe("voice.json", () => {
  it("defaults, and what will not do", () => {
    expect(parseVoiceFile({})).toEqual(NO_VOICE);
    expect(() => parseVoiceFile({ mode: "on" })).toThrow(/mode must be one of off, shadow, active/);
    expect(() => parseVoiceFile({ commands: ["Warm!"] })).toThrow(/not a command name/);
    expect(() => parseVoiceFile({ texts: { hello: "x" } })).toThrow(/unknown text "hello"/);
    expect(() => parseVoiceFile({ maxCalls: 50 })).toThrow(/maxCalls/);
    expect(() => parseVoiceFile({ key: 1 })).toThrow(/unknown key "key"/);
  });
});

describe("the clients", () => {
  it("speech to text: multipart to the OpenAI transcription path; the sibling add-on's address", async () => {
    let got: { url: string; form?: FormData } = { url: "" };
    const t = createTranscriber({
      url: "http://local-teobeanie-whisper:8200/",
      fetchImpl: (async (url: string, init: RequestInit) => {
        got = { url, form: init.body as FormData };
        return new Response(JSON.stringify({ text: " Кот дома. ", language: "ru", duration: 0.8, model: "small" }));
      }) as typeof fetch,
    });
    const r = await t.transcribe(new Uint8Array([1]), { filename: "voice.ogg", language: "ru", prompt: "кот" });
    expect(got.url).toBe("http://local-teobeanie-whisper:8200/v1/audio/transcriptions");
    expect(got.form!.get("language")).toBe("ru");
    expect(got.form!.get("prompt")).toBe("кот");
    expect(r).toMatchObject({ text: "Кот дома.", language: "ru", model: "small" });
    expect(siblingWhisperUrl("32ce46bf-teobeanie")).toBe("http://32ce46bf-teobeanie-whisper:8200");
  });

  it("chat: tools required, the cost asked for on OpenRouter, the key never in an error", async () => {
    let body: Record<string, unknown> = {};
    let auth = "";
    const c = createChatClient({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-secret",
      model: "anthropic/claude-haiku-5.5",
      openrouter: true,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        auth = (init.headers as Record<string, string>).authorization!;
        return new Response(
          JSON.stringify({
            model: "anthropic/claude-haiku-5.5",
            choices: [{ message: { content: null, tool_calls: [{ id: "a", function: { name: "pet", arguments: '{"where":"home"}' } }] } }],
            usage: { prompt_tokens: 900, completion_tokens: 20, cost: 0.0001 },
          }),
        );
      }) as typeof fetch,
    });
    const r = await c.complete({ messages: [{ role: "user", content: "кот дома" }], tools: [toolOf(surfaces[1]!)] });
    expect(body.tool_choice).toBe("required");
    expect(body.usage).toEqual({ include: true });
    expect(auth).toBe("Bearer sk-secret");
    expect(r).toEqual({ text: null, calls: [{ id: "a", name: "pet", arguments: '{"where":"home"}' }], model: "anthropic/claude-haiku-5.5", usage: { input: 900, output: 20, cost: 0.0001 } });
    const failing = createChatClient({ baseUrl: "https://x/v1", apiKey: "sk-secret", model: "m", fetchImpl: (async () => new Response("no credit", { status: 402 })) as unknown as typeof fetch });
    await expect(failing.complete({ messages: [], tools: [] })).rejects.toThrow(/^model 402: no credit$/);
  });
});

describe("telegram: voice messages", () => {
  const T0 = Date.UTC(2026, 9, 27, 10);
  const voiceUpdate = (chat: number, date = T0 / 1000) => ({
    update_id: 1,
    message: { message_id: 42, date, chat: { id: chat }, from: { id: 5, first_name: "Alex" }, voice: { file_id: "F1", duration: 3, mime_type: "audio/ogg" } },
  });

  async function run(update: unknown, enabled = true) {
    const methods: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const taken: Array<{ by: string; seconds: number; audio: number[] }> = [];
    let polls = 0;
    let stop: () => void = () => undefined;
    const handled = new Promise<void>((resolve) => {
      const rx = createTelegramReceiver({
        token: "TEST",
        chatIds: ["-1001"],
        dispatch: () => [],
        commandNames: () => [],
        reply: async () => undefined,
        voice: {
          enabled: () => enabled,
          async take(msg, io) {
            const audio = [...(await io.download())];
            await io.react("👀");
            await io.reply("ok");
            taken.push({ by: msg.by, seconds: msg.seconds, audio });
            resolve();
          },
        },
        log: () => undefined,
        now: () => T0 + 5000,
        sleep: async () => undefined,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const method = url.split("/").pop()!.split("?")[0]!;
          if (url.includes("/file/botTEST/")) return new Response(new Uint8Array([9, 8]));
          if (method === "getUpdates") {
            if (polls++ === 0) return new Response(JSON.stringify({ ok: true, result: [update] }));
            stop();
            // The lane is not awaited by the poll: give a taken message its turn first.
            setTimeout(resolve, 50);
            return new Response(JSON.stringify({ ok: true, result: [] }));
          }
          methods.push({ method, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
          if (method === "getFile") return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }));
          return new Response(JSON.stringify({ ok: true, result: true }));
        }) as typeof fetch,
      });
      stop = () => rx.stop();
      rx.start();
    });
    await handled;
    return { methods, taken };
  }

  it("a voice message of the chat goes to the lane, which can download it, react and answer it", async () => {
    const { methods, taken } = await run(voiceUpdate(-1001));
    expect(taken).toEqual([{ by: "Alex", seconds: 3, audio: [9, 8] }]);
    expect(methods.map((m) => m.method)).toEqual(["getFile", "setMessageReaction", "sendMessage"]);
    expect(methods[2]!.body).toMatchObject({ chat_id: -1001, text: "ok", reply_parameters: { message_id: 42 } });
  });

  it("another chat's, or with voice off: not taken", async () => {
    expect((await run(voiceUpdate(-2002))).taken).toEqual([]);
    expect((await run(voiceUpdate(-1001), false)).taken).toEqual([]);
  });
});

describe("voice_try", () => {
  it("phrases as if heard: what each would run, nothing run, journaled; with expectations, which pass", async () => {
    const { createVoiceTools, meets } = await import("../src/voice/tools.js");
    const h = laneHarness({
      file: { ...VOICE, mode: "off" },
      llm: scripted([[["pet", { where: "home" }]], [["not_an_instruction", { reply: "Это не команда." }]]]),
    });
    const [t] = createVoiceTools({ lane: h.lane, caller: () => "mcp:agent" });
    const res = await t!.execute({ say: ["код дома", "купи молоко"], expect: ["/pet home", "clarify"] });
    const body = res.output as { passed: number; of: number; results: Array<{ calls: string[]; pass: boolean }> };
    expect(body.passed).toBe(1);
    expect(body.of).toBe(2);
    expect(body.results.map((r) => r.calls)).toEqual([["/pet home"], []]);
    expect(h.dispatched).toEqual([]);
    expect(h.records.map((r) => [r.chat, r.by, r.mode, r.kind])).toEqual([
      ["mcp", "mcp:agent", "shadow", "instruction"],
      ["mcp", "mcp:agent", "shadow", "not_instruction"],
    ]);
    expect(meets({ say: "", kind: "instruction", calls: ["/pet away", "/warm den 20"] }, "/warm den 20; /pet away")).toBe(true);
  });
});
