// file.ts — voice.json in the config folder: whether voice messages are taken, which
// commands they may run, and the house's words for the model. Part of the working set
// (a reload checks it; a revision keeps it), like energy.json.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VOICE_FILE = "voice.json";

/** The bot's own words around a voice message; {slots} are filled in. */
export interface VoiceTexts {
  /** {by}: who spoke; {text}: what was heard. */
  heard: string;
  /** {calls}: the commands run, one per line. */
  ran: string;
  /** Under the commands, in shadow. */
  shadow: string;
  /** The model gave no usable answer. */
  failed: string;
  /** {seconds}: the longest message taken. */
  tooLong: string;
  /** Nothing was heard in the message. */
  nothingHeard: string;
  /** The month's LLM budget is spent. */
  budget: string;
  /** Speech to text or the model could not be reached. */
  unavailable: string;
}

export const VOICE_TEXTS: VoiceTexts = {
  heard: "🎙 {by}: «{text}»",
  ran: "→ {calls}",
  shadow: "(voice in shadow: nothing was run)",
  failed: "I could not make out an instruction for the house. Try again, or use a /command.",
  tooLong: "Voice messages up to {seconds} s only.",
  nothingHeard: "I heard nothing in that message.",
  budget: "The month's AI budget is spent: use the /commands until next month.",
  unavailable: "Voice is unavailable right now; use the /commands.",
};

export interface VoiceFile {
  /** off: voice messages are ignored; shadow: understood and answered, nothing run; active: run. */
  mode: "off" | "shadow" | "active";
  /** The commands a voice message may run; each needs a commandSchema in its heuristic. */
  commands: string[];
  /** The speakers' language for speech to text ("ru"); empty: detected per message. */
  language: string;
  /** Words speech to text should expect (room names, the commands' words). */
  vocabulary: string;
  /** The house's words for its rooms and things, for the model: "downstairs means BG". */
  glossary: string[];
  /** The model: an OpenRouter id or an Ollama model; empty: the add-on's option. */
  model: string;
  /** At most this many commands from one message. */
  maxCalls: number;
  /** The longest voice message taken, seconds. */
  maxSeconds: number;
  texts: VoiceTexts;
}

export const NO_VOICE: VoiceFile = {
  mode: "off",
  commands: [],
  language: "",
  vocabulary: "",
  glossary: [],
  model: "",
  maxCalls: 4,
  maxSeconds: 60,
  texts: VOICE_TEXTS,
};

const MODES = ["off", "shadow", "active"] as const;
const COMMAND = /^[a-z0-9_]{1,32}$/;

/** A voice.json value checked; throws naming the first thing that will not do. */
export function parseVoiceFile(raw: unknown, where = VOICE_FILE): VoiceFile {
  const bad = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("an object");
  const o = raw as Record<string, unknown>;
  const known = ["mode", "commands", "language", "vocabulary", "glossary", "model", "maxCalls", "maxSeconds", "texts"];
  for (const k of Object.keys(o)) if (!known.includes(k)) bad(`unknown key "${k}" (known: ${known.join(", ")})`);
  const str = (k: string): string => {
    const v = o[k] ?? "";
    return typeof v === "string" ? v : bad(`${k} must be a string`);
  };
  const strings = (k: string): string[] => {
    const v = o[k] ?? [];
    return Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : bad(`${k} must be a list of strings`);
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const v = o[k] ?? def;
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : bad(`${k} must be a whole number from ${min} to ${max}`);
  };
  const mode = o.mode ?? "off";
  if (!MODES.includes(mode as never)) bad(`mode must be one of ${MODES.join(", ")}`);
  const commands = strings("commands");
  for (const c of commands) if (!COMMAND.test(c)) bad(`"${c}" is not a command name (lowercase letters, digits, _)`);
  const texts = o.texts ?? {};
  if (typeof texts !== "object" || texts === null || Array.isArray(texts)) bad("texts must be an object");
  for (const [k, v] of Object.entries(texts as object)) {
    if (!(k in VOICE_TEXTS)) bad(`texts: unknown text "${k}" (known: ${Object.keys(VOICE_TEXTS).join(", ")})`);
    if (typeof v !== "string" || v.trim() === "") bad(`texts.${k} must be a non-empty string`);
  }
  return {
    mode: mode as VoiceFile["mode"],
    commands,
    language: str("language"),
    vocabulary: str("vocabulary"),
    glossary: strings("glossary"),
    model: str("model"),
    maxCalls: int("maxCalls", NO_VOICE.maxCalls, 1, 8),
    maxSeconds: int("maxSeconds", NO_VOICE.maxSeconds, 5, 300),
    texts: { ...VOICE_TEXTS, ...(texts as Partial<VoiceTexts>) },
  };
}

/** voice.json in the config folder; voice off without one. Throws on a file that will not do. */
export function loadVoiceFile(configDir: string): VoiceFile {
  const path = join(configDir, VOICE_FILE);
  if (!existsSync(path)) return NO_VOICE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: unparseable JSON: ${(err as Error).message}`);
  }
  return parseVoiceFile(raw, path);
}
