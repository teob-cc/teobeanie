// telegram.ts — the bot's command lane. Long-polls getUpdates, takes "/command args"
// messages from the configured chat only, and hands them to the heuristic host, which
// routes each to the instances that answer to it. Replies come from the instances
// themselves (notify actions), so they are journaled like any other action.
//
// People find the commands in the bot's menu (setMyCommands, scoped to the chat; set
// at start and after a reload that changes it). A command with arguments (commandArg)
// sent without one, or with one nobody answers for, gets a keyboard of the arguments
// instead: a press runs the command as the person who pressed it.
//
// Voice messages from the chat go to the voice lane (src/voice/lane.ts) when voice.json
// switches it on; the bot then needs to see every message of the group (an admin, or
// privacy mode off), not only commands.
//
// A bot has one update stream: only one client may poll it. This runs only when the
// add-on option telegram_commands is on, at the cut-over from another bot client
// (Node-RED). Until then Teobeanie sends through the same bot without reading it.

import type { CommandSource } from "./kernel/heuristic.js";
import type { CommandKeyboard, MenuCommand } from "./kernel/host.js";
import type { VoiceIo, VoiceMessage } from "./voice/lane.js";

export interface TelegramReceiverOptions {
  token: string;
  /** Chats whose commands are taken; anything else is ignored (and logged). */
  chatIds: string[];
  /** Route a command; returns the instances it reached (none: nobody answers to it). */
  dispatch: (name: string, args: string[], from: CommandSource) => string[];
  /** Command names the house answers to, for the reply to an unknown one. */
  commandNames: () => string[];
  /** The bot's command menu; none: the menu is left as it is. */
  menu?: () => MenuCommand[];
  /** The keyboard for a command with arguments, as the house stands now. */
  keyboard?: (name: string) => CommandKeyboard | undefined;
  /** A reply Teobeanie itself sends (unknown or stale commands), not an instance's. */
  reply: (text: string) => Promise<void>;
  /** The voice lane: voice messages of the configured chats, while it is on. */
  voice?: { enabled(): boolean; take(msg: VoiceMessage, io: VoiceIo): Promise<void> };
  /** Commands older than this are not run: a backlog after downtime (default 120 s). */
  maxAgeSec?: number;
  /** Long-poll timeout (default 50 s). */
  pollTimeoutSec?: number;
  fetchImpl?: typeof fetch;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramReceiver {
  start(): void;
  stop(): void;
  /** Set the bot's menu again if the commands changed (after a reload). */
  refreshMenu(): void;
  stats(): { polling: boolean; updates: number; commands: number; voices: number; lastError?: string };
}

interface Chat {
  id: number;
  title?: string;
}

interface User {
  id: number;
  username?: string;
  first_name?: string;
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    /** A voice message (OGG/Opus). */
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
    chat: Chat;
    from?: User;
    /** The group became a supergroup, with a new id. */
    migrate_to_chat_id?: number;
  };
  /** The bot was added to a chat, or removed. */
  my_chat_member?: { chat: Chat; new_chat_member: { status: string } };
  /** A keyboard button was pressed; data is the command it runs. */
  callback_query?: { id: string; from: User; message?: { message_id: number; chat: Chat }; data?: string };
}

/** Telegram takes up to 100 commands: 1-32 lowercase letters, digits and underscores, 1-256 characters of description. */
const MENU_NAME = /^[a-z0-9_]{1,32}$/;
/** callback_data is at most 64 bytes. */
const MAX_DATA = 64;

/** "/garage_open@some_bot now" → { name: "garage_open", args: ["now"] }; not a command → undefined. */
export function parseCommand(text: string | undefined): { name: string; args: string[] } | undefined {
  const m = text?.trim().match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+(.*))?$/s);
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? "").split(/\s+/).filter(Boolean) };
}

export function createTelegramReceiver(o: TelegramReceiverOptions): TelegramReceiver {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAgeMs = (o.maxAgeSec ?? 120) * 1000;
  const timeout = o.pollTimeoutSec ?? 50;
  const allowed = new Set(o.chatIds.map(String));
  let running = false;
  let offset: number | undefined;
  let abort: AbortController | undefined;
  let updates = 0;
  let commands = 0;
  let voices = 0;
  let lastError: string | undefined;
  let conflictLogged = false;
  /** Chats the bot is in that are not configured, said once each (how to find a new chat's id). */
  const seen = new Set<string>();
  const unknownChat = (chat: Chat, how: string): void => {
    const id = String(chat.id);
    if (allowed.has(id) || seen.has(id)) return;
    seen.add(id);
    o.log("info", `telegram: ${how} chat ${id}${chat.title ? ` "${chat.title}"` : ""}, which is not a configured chat`);
  };

  /** A Bot API call and its result; errors name the method, never the URL (it holds the token). */
  const api = async (method: string, body: object): Promise<unknown> => {
    const res = await f(`https://api.telegram.org/bot${o.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${res.status}: ${await res.text()}`);
    return ((await res.json().catch(() => ({}))) as { result?: unknown }).result;
  };

  /** A file the chat holds (a voice message), by its id: getFile, then the download. */
  const download = async (fileId: string): Promise<Uint8Array> => {
    const file = (await api("getFile", { file_id: fileId })) as { file_path?: string } | undefined;
    if (!file?.file_path) throw new Error("getFile: no file_path");
    const res = await f(`https://api.telegram.org/file/bot${o.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`file download ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const chatRef = (id: string): number | string => (/^-?\d+$/.test(id) ? Number(id) : id);
  const source = (u: User | undefined): CommandSource => ({ channel: "telegram", ...(u ? { user: u.username ?? u.first_name ?? String(u.id) } : {}) });

  // ---- the menu ----

  /** The menu Telegram has (JSON), once set; dirty until then, tried again after a poll. */
  let menuSet: string | undefined;
  let menuDirty = false;
  let menuTriedAt = -Infinity;
  let menuChain: Promise<void> = Promise.resolve();
  const syncMenu = (): Promise<void> =>
    (menuChain = menuChain.then(async () => {
      if (o.menu === undefined) return;
      const entries = o
        .menu()
        .filter((c) => MENU_NAME.test(c.command))
        .slice(0, 100)
        .map((c) => ({ command: c.command, description: (c.description.trim() || c.command).slice(0, 256) }));
      const json = JSON.stringify(entries);
      menuDirty = json !== menuSet;
      if (!menuDirty) return;
      menuTriedAt = now();
      try {
        for (const chat of allowed) {
          const scope = { type: "chat", chat_id: chatRef(chat) };
          await (entries.length > 0 ? api("setMyCommands", { commands: entries, scope }) : api("deleteMyCommands", { scope }));
        }
        menuSet = json;
        menuDirty = false;
        o.log("info", `telegram: command menu: ${entries.map((c) => "/" + c.command).join(", ") || "none"}`);
      } catch (err) {
        o.log("warn", `telegram: command menu not set: ${String(err)}; trying again later`);
      }
    }));

  // ---- commands and their keyboards ----

  /** Arguments to pick from instead of running the command: none given, or one nobody answers for. */
  const toPick = (name: string, args: string[]): CommandKeyboard | undefined => {
    const kb = o.keyboard?.(name);
    const asked = args[0]?.toLowerCase();
    return kb !== undefined && (asked === undefined || !kb.choices.some((c) => c.toLowerCase() === asked)) ? kb : undefined;
  };

  async function offer(chatId: number, name: string, args: string[], kb: CommandKeyboard): Promise<void> {
    const inline_keyboard = kb.rows
      .map((row) => row.map((a) => ({ text: a, callback_data: `/${name} ${a}` })).filter((b) => Buffer.byteLength(b.callback_data) <= MAX_DATA))
      .filter((row) => row.length > 0);
    const text = args.length === 0 ? `/${name}: which one?` : `/${name}: nobody answers for "${args[0]}". Which one?`;
    await api("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard } });
  }

  /** Run a command from the chat, typed or pressed; returns the instances it reached. */
  async function run(cmd: { name: string; args: string[] }, from: CommandSource, chatId: number, how: string): Promise<string[]> {
    const line = `/${cmd.name}${cmd.args.length ? " " + cmd.args.join(" ") : ""}`;
    const kb = toPick(cmd.name, cmd.args);
    if (kb !== undefined) {
      o.log("info", `telegram: ${line} ${how} ${from.user ?? "?"} → its choices`);
      await offer(chatId, cmd.name, cmd.args, kb);
      return [];
    }
    const reached = o.dispatch(cmd.name, cmd.args, from);
    commands++;
    o.log("info", `telegram: ${line} ${how} ${from.user ?? "?"} → ${reached.length ? reached.join(", ") : "nobody"}`);
    if (reached.length === 0) {
      const known = o.commandNames();
      await o.reply(known.length ? `Unknown command /${cmd.name}. Commands: ${known.map((c) => "/" + c).join(", ")}` : `Unknown command /${cmd.name}.`);
    }
    return reached;
  }

  async function press(q: NonNullable<Update["callback_query"]>): Promise<void> {
    const chat = q.message?.chat;
    if (chat === undefined || !allowed.has(String(chat.id))) {
      o.log("warn", `telegram: a button in chat ${chat?.id ?? "?"} ignored (not a configured chat)`);
      return;
    }
    // Answered first, which stops the button's spinner. Telegram refuses to answer a
    // press from long ago (a backlog after downtime): that one is not run.
    try {
      await api("answerCallbackQuery", { callback_query_id: q.id });
    } catch (err) {
      o.log("warn", `telegram: button ${q.data ?? "?"} not run: ${String(err)}`);
      return;
    }
    const cmd = parseCommand(q.data);
    if (cmd === undefined) return;
    const from = source(q.from);
    const reached = await run(cmd, from, chat.id, "pressed by");
    // The keyboard gives way to what was pressed; the instances reply on their own.
    if (reached.length > 0 && q.message !== undefined) {
      await api("editMessageText", { chat_id: chat.id, message_id: q.message.message_id, text: `/${cmd.name} ${cmd.args.join(" ")} (${from.user ?? "?"})` }).catch((err) =>
        o.log("warn", `telegram: keyboard not updated: ${String(err)}`),
      );
    }
  }

  async function handle(u: Update): Promise<void> {
    if (u.callback_query !== undefined) return press(u.callback_query);
    if (u.my_chat_member !== undefined) {
      const m = u.my_chat_member;
      unknownChat(m.chat, m.new_chat_member.status === "left" || m.new_chat_member.status === "kicked" ? "the bot was removed from" : "the bot is in");
      return;
    }
    const msg = u.message;
    if (msg === undefined) return;
    if (msg.migrate_to_chat_id !== undefined) {
      o.log("warn", `telegram: chat ${msg.chat.id}${msg.chat.title ? ` "${msg.chat.title}"` : ""} became a supergroup with id ${msg.migrate_to_chat_id}: update the add-on options`);
      return;
    }
    const cmd = parseCommand(msg.text);
    if (msg.voice !== undefined && allowed.has(String(msg.chat.id)) && o.voice?.enabled()) return voice(msg as VoiceUpdate);
    if (!allowed.has(String(msg.chat.id))) {
      if (cmd !== undefined) o.log("warn", `telegram: /${cmd.name} from chat ${msg.chat.id} ignored (not a configured chat)`);
      else unknownChat(msg.chat, "a message in");
      return;
    }
    if (cmd === undefined) return;
    const sent = msg.date * 1000;
    if (now() - sent > maxAgeMs) {
      o.log("warn", `telegram: /${cmd.name} sent ${Math.round((now() - sent) / 1000)} s ago, not run`);
      await o.reply(`/${cmd.name} arrived ${Math.round((now() - sent) / 1000)} s late and was not run. Send it again if it is still needed.`);
      return;
    }
    await run(cmd, source(msg.from), msg.chat.id, "from");
  }

  type VoiceUpdate = NonNullable<Update["message"]> & { voice: NonNullable<NonNullable<Update["message"]>["voice"]> };

  /** A voice message to the voice lane, not awaited: hearing it takes seconds, the commands go on meanwhile. */
  function voice(msg: VoiceUpdate): void {
    const sent = msg.date * 1000;
    const by = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "?");
    if (now() - sent > maxAgeMs) {
      o.log("warn", `telegram: a voice message from ${by} sent ${Math.round((now() - sent) / 1000)} s ago, not heard`);
      return;
    }
    voices++;
    const chat = msg.chat.id;
    void o.voice!.take(
      { chat: String(chat), messageId: msg.message_id, by, seconds: msg.voice.duration, at: sent },
      {
        download: () => download(msg.voice.file_id),
        reply: async (text) => {
          await api("sendMessage", { chat_id: chat, text, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
        },
        react: async (emoji) => {
          await api("setMessageReaction", { chat_id: chat, message_id: msg.message_id, reaction: [{ type: "emoji", emoji }] });
        },
      },
    );
  }

  async function loop(): Promise<void> {
    while (running) {
      abort = new AbortController();
      try {
        const q = new URLSearchParams({ timeout: String(timeout), allowed_updates: JSON.stringify(["message", "my_chat_member", "callback_query"]) });
        if (offset !== undefined) q.set("offset", String(offset));
        const res = await f(`https://api.telegram.org/bot${o.token}/getUpdates?${q}`, { signal: abort.signal });
        if (res.status === 409) {
          // Another client (Node-RED's bot) still polls: back off, say so once.
          lastError = "409 conflict: another client polls this bot";
          if (!conflictLogged) o.log("warn", "telegram: another client is polling this bot; commands wait until it stops");
          conflictLogged = true;
          await sleep(30_000);
          continue;
        }
        if (!res.ok) throw new Error(`getUpdates ${res.status}`);
        const body = (await res.json()) as { ok: boolean; result: Update[] };
        if (conflictLogged) o.log("info", "telegram: polling");
        conflictLogged = false;
        lastError = undefined;
        // A menu that did not get through: again, at most once a minute.
        if (menuDirty && now() - menuTriedAt >= 60_000) await syncMenu();
        for (const u of body.result) {
          // Acknowledged by the next getUpdates: a command is never run twice, even if
          // handling it fails.
          offset = u.update_id + 1;
          updates++;
          try {
            await handle(u);
          } catch (err) {
            o.log("error", `telegram: update ${u.update_id}: ${String(err)}`);
          }
        }
      } catch (err) {
        if (!running) return;
        lastError = String(err);
        o.log("warn", `telegram: ${lastError}; retrying in 10 s`);
        await sleep(10_000);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      o.log("info", `telegram: taking commands from ${[...allowed].join(", ")}`);
      void syncMenu();
      void loop();
    },
    refreshMenu() {
      if (running) void syncMenu();
    },
    stop() {
      running = false;
      abort?.abort();
    },
    stats: () => ({ polling: running, updates, commands, voices, ...(lastError !== undefined ? { lastError } : {}) }),
  };
}
