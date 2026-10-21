// telegram: the command lane — parsing, the chat filter, stale commands, a busy bot.

import { describe, expect, it, vi } from "vitest";
import { createTelegramReceiver, parseCommand } from "../src/telegram.js";
import { createSafeActuator, createTelegramNotifier } from "../src/kernel/actuator.js";
import { createHeuristicHost, type CommandKeyboard, type MenuCommand } from "../src/kernel/host.js";
import { defineHeuristic } from "../src/kernel/heuristic.js";

/** A command that takes any of several words, with a keyboard of two of them (as a pet's whereabouts would). */
const whereabouts = defineHeuristic<{ command: string }, Record<string, never>, { tag: "Noted" }>({
  id: "whereabouts",
  title: "Whereabouts",
  description: "Where the pet is, as people say.",
  watch: () => [],
  actuates: () => [],
  commands: (p) => [p.command],
  commandArg: (p) => ({ [p.command]: ["home", "in", "inside", "away", "out", "outside"] }),
  commandHelp: (p) => ({ [p.command]: "Tell where the cat is: home or away" }),
  commandButtons: (p) => ({ [p.command]: ["home", "away"] }),
  initial: () => ({}),
  decide: () => undefined,
  evolve: (s) => s,
});

describe("parseCommand", () => {
  it("takes /name, an @bot suffix and arguments", () => {
    expect(parseCommand("/shed_open")).toEqual({ name: "shed_open", args: [] });
    expect(parseCommand("/Shed_Open@house_bot  now please")).toEqual({ name: "shed_open", args: ["now", "please"] });
    expect(parseCommand("open the shed")).toBeUndefined();
    expect(parseCommand(undefined)).toBeUndefined();
  });
});

const T0 = Date.UTC(2026, 0, 5, 12);
const CHAT = -1001;

/** A fake Bot API: each getUpdates answers with the next batch, then the receiver is stopped. */
function harness(
  batches: Array<{ status?: number; updates?: unknown[]; before?: () => void }>,
  opts: {
    known?: string[];
    reach?: (name: string) => string[];
    menu?: () => MenuCommand[];
    keyboard?: (name: string) => CommandKeyboard | undefined;
    /** Status of a Bot API method other than getUpdates (default 200). */
    status?: (method: string) => number;
    now?: () => number;
  } = {},
) {
  const urls: string[] = [];
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const dispatched: Array<{ name: string; args: string[]; user?: string }> = [];
  const replies: string[] = [];
  const logs: string[] = [];
  let i = 0;
  let done: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const rx = createTelegramReceiver({
    token: "TEST",
    chatIds: [String(CHAT)],
    dispatch: (name, args, from) => {
      dispatched.push({ name, args, ...(from.user !== undefined ? { user: from.user } : {}) });
      return (opts.reach ?? ((n: string) => ((opts.known ?? ["shed_open"]).includes(n) ? [`shed/${n}`] : [])))(name);
    },
    commandNames: () => opts.known ?? ["shed_open"],
    ...(opts.menu !== undefined ? { menu: opts.menu } : {}),
    ...(opts.keyboard !== undefined ? { keyboard: opts.keyboard } : {}),
    reply: async (text) => {
      replies.push(text);
    },
    fetchImpl: (async (url: string, init?: { body?: string }) => {
      urls.push(url);
      const method = url.split("/").at(-1)!.split("?")[0]!;
      if (method !== "getUpdates") {
        calls.push({ method, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
        const status = opts.status?.(method) ?? 200;
        return new Response(JSON.stringify({ ok: status === 200, result: true }), { status });
      }
      const b = batches[i++];
      if (b === undefined) {
        rx.stop();
        done();
        return new Response(JSON.stringify({ ok: true, result: [] }));
      }
      b.before?.();
      return new Response(JSON.stringify({ ok: (b.status ?? 200) === 200, result: b.updates ?? [] }), { status: b.status ?? 200 });
    }) as unknown as typeof fetch,
    log: (_l, m) => logs.push(m),
    now: opts.now ?? (() => T0),
    sleep: async () => {},
  });
  rx.start();
  const sent = (method: string) => calls.filter((c) => c.method === method).map((c) => c.body);
  return { finished, urls, calls, sent, dispatched, replies, logs, rx };
}

const msg = (id: number, text: string, opts: { chat?: number; ageSec?: number; user?: string } = {}) => ({
  update_id: id,
  message: { date: Math.floor((T0 - (opts.ageSec ?? 1) * 1000) / 1000), text, chat: { id: opts.chat ?? CHAT }, from: { id: 7, username: opts.user ?? "alex" } },
});

describe("telegram receiver", () => {
  it("routes a command from the chat, and acknowledges it with the next poll", async () => {
    const h = harness([{ updates: [msg(41, "/shed_open@house_bot")] }]);
    await h.finished;
    expect(h.dispatched).toEqual([{ name: "shed_open", args: [], user: "alex" }]);
    expect(h.replies).toEqual([]);
    expect(h.urls[1]).toContain("offset=42");
  });

  it("ignores other chats and plain messages", async () => {
    const h = harness([{ updates: [msg(1, "/shed_open", { chat: 555 }), msg(2, "hello")] }]);
    await h.finished;
    expect(h.dispatched).toEqual([]);
    expect(h.replies).toEqual([]);
    expect(h.logs.some((l) => l.includes("chat 555 ignored"))).toBe(true);
  });

  it("does not run a command that arrives late (a backlog after downtime), and says so", async () => {
    const h = harness([{ updates: [msg(1, "/shed_open", { ageSec: 600 })] }]);
    await h.finished;
    expect(h.dispatched).toEqual([]);
    expect(h.replies[0]).toContain("was not run");
  });

  it("answers an unknown command with the ones the house knows", async () => {
    const h = harness([{ updates: [msg(1, "/fly_away")] }]);
    await h.finished;
    expect(h.replies).toEqual(["Unknown command /fly_away. Commands: /shed_open"]);
  });

  it("another client polling the bot (409): waits and keeps trying", async () => {
    const h = harness([{ status: 409 }, { status: 409 }, { updates: [msg(5, "/shed_open")] }]);
    await h.finished;
    expect(h.dispatched).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes("another client")).length).toBe(1);
  });
});

describe("telegram receiver: the command menu", () => {
  it("sets the menu for the chat at start, and again only when the commands change", async () => {
    let menu: MenuCommand[] = [
      { command: "garage_open", description: "Open the garage door" },
      { command: "climate_waive", description: "  " },
      { command: "Not-A-Name", description: "dropped: Telegram refuses it" },
    ];
    const h = harness([{}, { before: () => h.rx.refreshMenu() }, { before: () => ((menu = []), h.rx.refreshMenu()) }], { menu: () => menu });
    await h.finished;
    await vi.waitFor(() => expect(h.sent("deleteMyCommands")).toHaveLength(1));
    expect(h.sent("setMyCommands")).toEqual([
      {
        commands: [
          { command: "garage_open", description: "Open the garage door" },
          { command: "climate_waive", description: "climate_waive" },
        ],
        scope: { type: "chat", chat_id: CHAT },
      },
    ]);
    expect(h.sent("deleteMyCommands")).toEqual([{ scope: { type: "chat", chat_id: CHAT } }]);
  });

  it("a menu Telegram refused is tried again after a later poll, a minute on", async () => {
    let t = T0;
    let refuse = true;
    // Refused at start; a poll 30 s on does not try again, one 90 s on does.
    const h = harness([{}, { before: () => (t += 30_000) }, { before: () => ((t += 60_000), (refuse = false)) }], {
      menu: () => [{ command: "garage_open", description: "Open the garage door" }],
      status: (m) => (m === "setMyCommands" && refuse ? 502 : 200),
      now: () => t,
    });
    await h.finished;
    await vi.waitFor(() => expect(h.logs.some((l) => l.startsWith("telegram: command menu: /garage_open"))).toBe(true));
    expect(h.sent("setMyCommands")).toHaveLength(2);
    expect(h.logs.filter((l) => l.includes("command menu not set"))).toHaveLength(1);
  });
});

describe("telegram receiver: a keyboard for a command's arguments", () => {
  const rooms = (waived: string[] = []): CommandKeyboard => ({
    choices: ["bedroom", "den", "study"],
    rows: ["bedroom", "study"].map((r) => [r, ...(waived.includes(r) ? [`${r} off`] : [])]),
  });
  const keyboard = (name: string) => (name === "climate_waive" ? rooms(["study"]) : undefined);
  const known = ["climate_waive", "shed_open"];
  const press = (id: number, data: string, opts: { chat?: number; user?: string } = {}) => ({
    update_id: id,
    callback_query: { id: `q${id}`, from: { id: 9, username: opts.user ?? "sam" }, message: { message_id: 77, chat: { id: opts.chat ?? CHAT } }, data },
  });

  it("asks for callback queries too", async () => {
    const h = harness([]);
    await h.finished;
    expect(decodeURIComponent(h.urls[0]!)).toContain('"callback_query"');
  });

  it("the command alone, or with an argument nobody answers for: the choices as buttons, nothing run", async () => {
    const h = harness([{ updates: [msg(1, "/climate_waive"), msg(2, "/climate_waive kitchen"), msg(3, "/shed_open")] }], { known, keyboard });
    await h.finished;
    expect(h.dispatched).toEqual([{ name: "shed_open", args: [], user: "alex" }]);
    const [alone, unknown] = h.sent("sendMessage");
    expect(alone).toEqual({
      chat_id: CHAT,
      text: "/climate_waive: which one?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "bedroom", callback_data: "/climate_waive bedroom" }],
          [
            { text: "study", callback_data: "/climate_waive study" },
            { text: "study off", callback_data: "/climate_waive study off" },
          ],
        ],
      },
    });
    expect(unknown?.text).toBe('/climate_waive: nobody answers for "kitchen". Which one?');
    expect(h.replies).toEqual([]);
  });

  it("a choice in any case is run as typed (the instances match it the same way)", async () => {
    const h = harness([{ updates: [msg(1, "/climate_waive BEDROOM"), msg(2, "/climate_waive Den off")] }], { known, keyboard });
    await h.finished;
    expect(h.dispatched).toEqual([
      { name: "climate_waive", args: ["BEDROOM"], user: "alex" },
      { name: "climate_waive", args: ["Den", "off"], user: "alex" },
    ]);
    expect(h.sent("sendMessage")).toEqual([]);
  });

  it("a press runs the command as the person who pressed, answers it and replaces the keyboard", async () => {
    const h = harness([{ updates: [press(5, "/climate_waive study off")] }], { known, keyboard });
    await h.finished;
    expect(h.dispatched).toEqual([{ name: "climate_waive", args: ["study", "off"], user: "sam" }]);
    expect(h.sent("answerCallbackQuery")).toEqual([{ callback_query_id: "q5" }]);
    expect(h.sent("editMessageText")).toEqual([{ chat_id: CHAT, message_id: 77, text: "/climate_waive study off (sam)" }]);
    expect(h.logs).toContain("telegram: /climate_waive study off pressed by sam → shed/climate_waive");
  });

  it("a press in another chat is ignored; one Telegram will not answer (long ago) is not run", async () => {
    const foreign = harness([{ updates: [press(1, "/climate_waive bedroom", { chat: 555 })] }], { known, keyboard });
    await foreign.finished;
    expect(foreign.dispatched).toEqual([]);
    expect(foreign.calls).toEqual([]);
    expect(foreign.logs.some((l) => l.includes("button in chat 555 ignored"))).toBe(true);
    const old = harness([{ updates: [press(2, "/climate_waive bedroom")] }], { known, keyboard, status: (m) => (m === "answerCallbackQuery" ? 400 : 200) });
    await old.finished;
    expect(old.dispatched).toEqual([]);
    expect(old.logs.some((l) => l.includes("button /climate_waive bedroom not run"))).toBe(true);
  });

  it("a press for a choice that is gone (a reload): the buttons as they stand now", async () => {
    const h = harness([{ updates: [press(3, "/climate_waive attic")] }], { known, keyboard });
    await h.finished;
    expect(h.dispatched).toEqual([]);
    expect(h.sent("sendMessage")[0]?.text).toBe('/climate_waive: nobody answers for "attic". Which one?');
    expect(h.sent("editMessageText")).toEqual([]);
  });
});

const press = (id: number, data: string, opts: { chat?: number; user?: string } = {}) => ({
  update_id: id,
  callback_query: { id: `q${id}`, from: { id: 9, username: opts.user ?? "sam" }, message: { message_id: 77, chat: { id: opts.chat ?? CHAT } }, data },
});

describe("telegram receiver: the cat's command", () => {
  const host = createHeuristicHost({
    library: [whereabouts],
    instances: [
      { heuristic: "whereabouts", id: "pet", mode: "active", params: { command: "pet" } },
    ],
    actuator: createSafeActuator({ ha: { callService: async () => ({ context: { id: "c" } }) } }),
    liveState: () => undefined,
    forceShadow: false,
    log: () => {},
  });
  const keyboard = (name: string) => host.commandKeyboard(name);

  it("the menu entry, and a keyboard of home and away; every word it takes is a choice", () => {
    expect(host.commandMenu()).toEqual([{ command: "pet", description: "Tell where the cat is: home or away" }]);
    expect(host.commandKeyboard("pet")).toEqual({ choices: ["away", "home", "in", "inside", "out", "outside"], rows: [["home", "away"]] });
  });

  it("/pet alone offers home and away; /pet out runs; a press runs /pet home", async () => {
    const h = harness([{ updates: [msg(1, "/pet"), msg(2, "/pet out"), press(3, "/pet home")] }], { known: ["pet"], keyboard });
    await h.finished;
    expect(h.sent("sendMessage")[0]).toEqual({
      chat_id: CHAT,
      text: "/pet: which one?",
      reply_markup: { inline_keyboard: [[{ text: "home", callback_data: "/pet home" }, { text: "away", callback_data: "/pet away" }]] },
    });
    expect(h.dispatched).toEqual([
      { name: "pet", args: ["out"], user: "alex" },
      { name: "pet", args: ["home"], user: "sam" },
    ]);
  });
});

describe("telegram receiver: chats it does not know", () => {
  it("says once which chat the bot was added to, and when a group got a new id", async () => {
    const added = { update_id: 1, my_chat_member: { chat: { id: -2002, title: "Watchers" }, new_chat_member: { status: "member" } } };
    const said = { update_id: 2, message: { date: Math.floor(T0 / 1000), text: "hello", chat: { id: -2002, title: "Watchers" } } };
    const moved = { update_id: 3, message: { date: Math.floor(T0 / 1000), chat: { id: -3003, title: "Old" }, migrate_to_chat_id: -1003003 } };
    const h = harness([{ updates: [added, said, moved] }]);
    await h.finished;
    expect(h.logs.filter((l) => l.includes("-2002"))).toEqual(['telegram: the bot is in chat -2002 "Watchers", which is not a configured chat']);
    expect(h.logs.some((l) => l.includes("became a supergroup with id -1003003"))).toBe(true);
    expect(h.dispatched).toEqual([]);
  });
});

describe("telegram notifier: the alerts chat", () => {
  const notifier = (fail: Record<string, number> = {}) => {
    const sent: Array<{ chat: string; text: string }> = [];
    const n = createTelegramNotifier({
      token: "TEST",
      chatId: "-1",
      alertsChatId: "-2",
      toAlerts: (from) => from === "door-nag/shed",
      sleep: async () => {},
      fetchImpl: (async (_url: string, init: { body: string }) => {
        const { chat_id, text } = JSON.parse(init.body) as { chat_id: string; text: string };
        if ((fail[chat_id] ?? 0) > 0) {
          fail[chat_id]!--;
          return new Response("Bad Gateway", { status: 502 });
        }
        sent.push({ chat: chat_id, text });
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    return { n, sent };
  };

  it("an alerts instance's notice goes to both chats; anything else to the chat only", async () => {
    const { n, sent } = notifier();
    await n.send("Shed door is still open!", "door-nag/shed");
    await n.send("Opening the shed...", "garage-door/shed");
    await n.send("Teobeanie: Home Assistant is reachable again");
    expect(sent).toEqual([
      { chat: "-1", text: "Shed door is still open!" },
      { chat: "-2", text: "Shed door is still open!" },
      { chat: "-1", text: "Opening the shed..." },
      { chat: "-1", text: "Teobeanie: Home Assistant is reachable again" },
    ]);
    expect(n.retriesItself).toBe(true);
  });

  it("a chat that fails once is tried again on its own; the other gets it once", async () => {
    const { n, sent } = notifier({ "-2": 1 });
    await n.send("Shed door is still open!", "door-nag/shed");
    expect(sent.filter((m) => m.chat === "-1")).toHaveLength(1);
    expect(sent.filter((m) => m.chat === "-2")).toHaveLength(1);
  });

  it("still failing: the error names the alerts chat", async () => {
    const { n } = notifier({ "-2": 2 });
    await expect(n.send("Shed door is still open!", "door-nag/shed")).rejects.toThrow(/502.*\(also after a retry\) \(alerts chat\)/);
  });
});
