// lane.ts — the voice lane: a voice message from the chat, heard on the Home Assistant
// host (stt.ts), understood by the model (loop.ts) into the commands voice.json lets it
// run, and sent through the command lane as the person who spoke. In shadow it answers
// with what it would run and runs nothing. The bot's answer is the transcript and the
// commands; the behaviours answer for themselves, as they do to a typed command.
//
// One message at a time, in the order they came: the host's CPU hears one at a time anyway.

import { ulid } from "@lambda-house/teob-ts/core";
import type { CommandSchema, CommandSource } from "../kernel/heuristic.js";
import { fill } from "../kernel/heuristic.js";
import type { VoiceFile } from "./file.js";
import type { VoiceHandled } from "./journal.js";
import type { ChatClient } from "./llm.js";
import { understand, type Understood } from "./loop.js";
import type { Transcriber } from "./stt.js";
import { commandLine, surfacesOf } from "./surfaces.js";

/** A voice message from a configured chat. */
export interface VoiceMessage {
  chat: string;
  messageId: number;
  /** Who spoke, as the chat names them. */
  by: string;
  /** Seconds of audio, as the chat says. */
  seconds: number;
  /** When it was sent, ms epoch. */
  at: number;
}

/** What the lane may do in the chat about one message. */
export interface VoiceIo {
  download(): Promise<Uint8Array>;
  /** An answer to the message. */
  reply(text: string): Promise<void>;
  /** A reaction on the message (👀 while it is heard); failures are the lane's to ignore. */
  react(emoji: string): Promise<void>;
}

export interface VoiceLaneDeps {
  file: () => VoiceFile;
  /** Speech to text; none: voice is unavailable. */
  transcriber: Transcriber | undefined;
  /** The model for this file's model name; none: no LLM configured (the transcript is still answered). */
  llm: (model: string) => ChatClient | undefined;
  /** The typed commands of the instances that run now. */
  schemas: () => Record<string, CommandSchema>;
  /** What the commands act on, now: one line each (the cards of the instances answering them). */
  context: (commands: string[]) => string[];
  /** Send a command through the command lane; the instances it reached. */
  dispatch: (name: string, args: string[], from: CommandSource) => string[];
  /** "Tuesday 2026-10-27 11:50", house time. */
  houseTime: (at: number) => string;
  /** USD spent on the model this month, and the month's budget (0 or less: none). */
  spent: () => number;
  budgetUsd: number;
  record: (e: Omit<VoiceHandled, "tag">) => void;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
}

/** A phrase tried as if it had been heard (voice_try): what would run, nothing runs. */
export interface VoiceTrial {
  say: string;
  kind: string;
  calls: string[];
  reply?: string;
  reason?: string;
  turns?: number;
  model?: string;
  cost?: number;
  trace?: Understood["trace"];
}

export interface VoiceLane {
  /** Take a message: queued behind the ones before it; resolves when it is handled. */
  take(msg: VoiceMessage, io: VoiceIo): Promise<void>;
  enabled(): boolean;
  /**
   * A phrase as if heard, in any mode: understood, never run, journaled (its cost counts).
   * For the agent: try what people will say before voice goes active.
   */
  trial(say: string, by: string): Promise<VoiceTrial>;
}

export function createVoiceLane(d: VoiceLaneDeps): VoiceLane {
  const now = d.now ?? Date.now;
  let chain: Promise<void> = Promise.resolve();

  async function handle(msg: VoiceMessage, io: VoiceIo): Promise<void> {
    const t0 = now();
    const file = d.file();
    if (file.mode === "off") return;
    const mode = file.mode;
    const t = file.texts;
    const voiceId = ulid();
    const base = { at: t0, voiceId, by: msg.by, chat: msg.chat, seconds: msg.seconds, mode } as const;
    const finish = async (rest: Partial<Omit<VoiceHandled, "tag">> & { kind: string; calls?: string[] }, answer: string | undefined): Promise<void> => {
      if (answer !== undefined) await io.reply(answer).catch((err) => d.log("warn", `voice: answer not sent: ${String(err)}`));
      d.record({ ...base, calls: [], ...rest, ...(answer !== undefined ? { reply: answer } : {}), ms: now() - t0 });
    };

    if (msg.seconds > file.maxSeconds) return finish({ kind: "too_long" }, fill(t.tooLong, { seconds: file.maxSeconds }));
    if (d.transcriber === undefined) return finish({ kind: "unavailable", reason: "no speech to text" }, t.unavailable);
    void io.react("👀").catch(() => undefined);

    let transcript: string;
    let stt: VoiceHandled["stt"];
    try {
      const audio = await io.download();
      const heard = await d.transcriber.transcribe(audio, { filename: "voice.ogg", ...(file.language ? { language: file.language } : {}), ...(file.vocabulary ? { prompt: file.vocabulary } : {}) });
      transcript = heard.text;
      stt = { ms: heard.ms, ...(heard.model !== undefined ? { model: heard.model } : {}) };
    } catch (err) {
      d.log("warn", `voice: speech to text failed: ${String(err)}`);
      return finish({ kind: "unavailable", reason: String(err) }, t.unavailable);
    }
    const heardLine = fill(t.heard, { by: msg.by, text: transcript });
    if (transcript === "") return finish({ kind: "nothing_heard", stt }, t.nothingHeard);

    const llm = d.llm(file.model);
    if (llm === undefined) return finish({ kind: "unavailable", transcript, stt, reason: "no model configured" }, `${heardLine}\n${t.unavailable}`);
    if (d.budgetUsd > 0 && d.spent() >= d.budgetUsd) return finish({ kind: "budget", transcript, stt }, `${heardLine}\n${t.budget}`);

    let u: Understood;
    try {
      u = await interpret(file, llm, transcript, msg.by, msg.at);
    } catch (err) {
      d.log("warn", `voice: the model failed: ${String(err)}`);
      return finish({ kind: "unavailable", transcript, stt, reason: String(err) }, `${heardLine}\n${t.unavailable}`);
    }

    const lines = u.calls.map((c) => commandLine(c.command, c.args));
    const reached: string[][] = [];
    if (mode === "active") {
      for (const c of u.calls) {
        const to = d.dispatch(c.command, c.args, { channel: "voice", user: msg.by, ref: `voice:${voiceId}` });
        reached.push(to);
        d.log("info", `voice: ${commandLine(c.command, c.args)} by ${msg.by} → ${to.length ? to.join(", ") : "nobody"}`);
      }
    }
    const answer = [
      heardLine,
      ...(lines.length > 0 ? [fill(t.ran, { calls: lines.join("\n→ ") })] : []),
      ...(lines.length > 0 && mode === "shadow" ? [t.shadow] : []),
      ...(u.reply !== undefined ? [u.reply] : u.kind === "failed" ? [t.failed] : []),
    ].join("\n");
    d.log("info", `voice: ${msg.by} (${msg.seconds} s) "${transcript}" → ${u.kind}${lines.length ? ": " + lines.join(", ") : ""} (${u.model}, ${u.turns} turn${u.turns === 1 ? "" : "s"})`);
    return finish(
      {
        kind: u.kind,
        transcript,
        stt,
        calls: lines,
        ...(mode === "active" ? { reached } : {}),
        ...(u.reason !== undefined ? { reason: u.reason } : {}),
        model: u.model,
        turns: u.turns,
        usage: u.usage,
        trace: u.trace,
      },
      answer,
    );
  }

  /** The model's reading of a transcript, within the surfaces voice.json lists. */
  function interpret(file: VoiceFile, llm: ChatClient, transcript: string, by: string, at: number): Promise<Understood> {
    const { surfaces, missing } = surfacesOf(file.commands, d.schemas());
    if (missing.length > 0) d.log("warn", `voice: ${missing.map((c) => "/" + c).join(", ")} in voice.json, but no running instance gives a schema for it`);
    return understand(llm, {
      transcript,
      speaker: by,
      surfaces,
      language: file.language,
      glossary: file.glossary,
      context: d.context(surfaces.map((s) => s.command)),
      now: d.houseTime(at),
      maxCalls: file.maxCalls,
    });
  }

  async function trial(say: string, by: string): Promise<VoiceTrial> {
    const file = d.file();
    const llm = d.llm(file.model);
    if (llm === undefined) throw new Error("no model configured (llm_provider and its key or URL)");
    if (d.budgetUsd > 0 && d.spent() >= d.budgetUsd) throw new Error("the month's LLM budget is spent");
    const t0 = now();
    const u = await interpret(file, llm, say, by, t0);
    const calls = u.calls.map((c) => commandLine(c.command, c.args));
    d.record({
      at: t0,
      voiceId: ulid(),
      by,
      chat: "mcp",
      seconds: 0,
      mode: "shadow",
      kind: u.kind,
      transcript: say,
      calls,
      ...(u.reply !== undefined ? { reply: u.reply } : {}),
      ...(u.reason !== undefined ? { reason: u.reason } : {}),
      model: u.model,
      turns: u.turns,
      usage: u.usage,
      trace: u.trace,
      ms: now() - t0,
    });
    return {
      say,
      kind: u.kind,
      calls,
      ...(u.reply !== undefined ? { reply: u.reply } : {}),
      ...(u.reason !== undefined ? { reason: u.reason } : {}),
      turns: u.turns,
      model: u.model,
      ...(u.usage.cost !== undefined ? { cost: u.usage.cost } : {}),
      trace: u.trace,
    };
  }

  return {
    trial,
    enabled: () => d.file().mode !== "off",
    take(msg, io) {
      const run = chain.then(() => handle(msg, io));
      chain = run.catch((err) => d.log("error", `voice: ${String(err)}`));
      return chain;
    },
  };
}
