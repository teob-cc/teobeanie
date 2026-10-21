// garage-door — the command pattern: a named command (from Telegram, later the panel
// or an agent) checks the house, acts, and confirms. "Open" or "close" presses the
// opener's step button only when that gets the door where it was asked to go, then
// waits for the door contact and reports what happened. The press goes through the
// momentary relay another instance owns (relay-pulse shares it): that instance
// releases it, whoever pressed it.
//
// Optional auto-close: a door left open with nobody there is announced ("I'll close it
// in 5 min"), reminded once, then closed the same way a close command does. Someone
// showing up, the door closing, or the keep-open command stops the countdown; after a
// keep-open the door is left alone until it next closes.

import { cancelTimer, defineHeuristic, fill, heldSince, minutes, notify, param, seconds, setTimer, type CardField, type DecideCtx, type Infer } from "teobeanie";

/** The messages of a garage-door instance; {slots} are filled in. */
export interface GarageDoorTexts {
  open: string;
  closed: string;
  alreadyOpen: string;
  alreadyClosed: string;
  /** {state}: what the contact reports. */
  sensorDown: string;
  busy: string;
  /** {s}: seconds since it opened. */
  stillMoving: string;
  opening: string;
  closing: string;
  keepOpen: string;
  /** {s}: the confirmation deadline in seconds. */
  didNotOpen: string;
  didNotClose: string;
  /** {min}: minutes to closing; {keep}: the keepHint, when there is a keep-open command. */
  autoAnnounce: string;
  autoRemind: string;
  /** {command}: the keep-open command. */
  keepHint: string;
  autoClosing: string;
  /** Someone showed up after the countdown was announced. */
  autoStopped: string;
}

export const GARAGE_DOOR_TEXTS: GarageDoorTexts = {
  open: "Garage is open.",
  closed: "Garage is closed.",
  alreadyOpen: "Garage is already open.",
  alreadyClosed: "Garage is already closed.",
  sensorDown: "Garage door sensor is {state}, not pressing the button.",
  busy: "Still handling the previous garage command, try again shortly.",
  stillMoving: "Garage opened {s} s ago and may still be moving, try again shortly.",
  opening: "Opening the garage...",
  closing: "Closing the garage...",
  keepOpen: "OK, I'll leave the garage open until it is closed.",
  didNotOpen: "Garage did not open within {s} s, please check it.",
  didNotClose: "Garage did not close within {s} s, please check it.",
  autoAnnounce: "Garage is open and no one is in it. I'll close it in {min} min.{keep}",
  autoRemind: "Closing the garage in {min} min.{keep}",
  keepHint: " /{command} keeps it open.",
  autoClosing: "Closing the garage now.",
  autoStopped: "Someone is in the garage, not closing it.",
};

const GARAGE_DOOR_PARAMS = param.object({
  button: param.entity("switch").doc("The momentary relay on the opener's step input (shared by a relay-pulse instance)."),
  contact: param.entity().doc("Door contact: on = open."),
  commands: param
    .object({ open: param.string(), close: param.string() })
    .doc('Command names, e.g. { "open": "garage_open", "close": "garage_close" }.'),
  confirmSec: param.duration("s").default(30).doc("How long the door may take to get there."),
  settleSec: param.duration("s").default(30).doc("Do not close sooner than this after it opened: it may still be moving."),
  autoClose: param
    .object({
      presence: param.entity().doc("Someone there (an occupancy sensor): no countdown while it is on, nor while it reports nothing."),
      noticeAfterMin: param.duration("min").default(3).doc("Open with nobody there this long before the announcement."),
      closeInMin: param.duration("min").default(5).doc("From the announcement to closing."),
      remindBeforeMin: param.duration("min").default(1).doc("One reminder this long before closing (0 = none)."),
      keepOpenCommand: param.string().optional().doc('A command that keeps the door open until it next closes, e.g. "garage_keep_open".'),
    })
    .optional()
    .doc("Close a door left open with nobody there, after saying so."),
  texts: param
    .texts(GARAGE_DOOR_TEXTS, {
      sensorDown: "{state}: what the contact reports.",
      stillMoving: "{s}: seconds since it opened.",
      didNotOpen: "{s}: the confirmation deadline in seconds.",
      didNotClose: "{s}: the confirmation deadline in seconds.",
      autoAnnounce: "{min}: minutes to closing; {keep}: the keepHint, when there is a keep-open command.",
      autoRemind: "{min}: minutes to closing; {keep}: the keepHint, when there is a keep-open command.",
      keepHint: "{command}: the keep-open command.",
      autoStopped: "Someone showed up after the countdown was announced.",
    })
    .doc("Override any of the messages (the English defaults stay for the rest)."),
});

export type GarageDoorParams = Infer<typeof GARAGE_DOOR_PARAMS>;

type Want = "open" | "close";
type Event =
  | { tag: "Pressed"; want: Want; by: string }
  | { tag: "Arrived"; want: Want }
  | { tag: "NotArrived"; want: Want }
  | { tag: "AutoNoticed"; closeInMin: number }
  | { tag: "AutoReminded" }
  | { tag: "AutoStopped"; reason: string }
  | { tag: "KeptOpen"; by: string }
  | { tag: "DoorClosed" };

interface State {
  /** The direction a press is under way to, until the door gets there or the deadline passes. */
  pending?: Want;
  /** How far the auto-close countdown got (absent: none announced). */
  auto?: "noticed" | "reminded";
  /** Someone asked to keep it open: no auto-close until the door closes. */
  kept?: boolean;
}

const CONFIRM = "confirm";
const AUTO = "auto-close";
const textsOf = (p: GarageDoorParams): GarageDoorTexts => ({ ...GARAGE_DOOR_TEXTS, ...p.texts });

export const garageDoor = defineHeuristic<GarageDoorParams, State, Event>({
  id: "garage-door",
  pattern: "command",
  title: "Garage door commands",
  description:
    "Open and close commands press the opener's step button only when that gets the door there, then confirm from the door contact. Optionally closes a door left open with nobody there, after an announcement and a reminder.",
  guarantees:
    "The step button is pressed only when that gets the door where it was asked to go, and every command gets an answer from the door contact. An automatic close is announced first, and anyone arriving or a keep-open command stops it.",
  params: GARAGE_DOOR_PARAMS,
  watch: (p) => [p.contact, ...(p.autoClose ? [p.autoClose.presence] : [])],
  reads: (p) => [p.button],
  actuates: () => [],
  uses: (p) => [p.button],
  commands: (p) => [p.commands.open, p.commands.close, ...(p.autoClose?.keepOpenCommand ? [p.autoClose.keepOpenCommand] : [])],
  commandHelp: (p) => ({
    [p.commands.open]: "Open the garage door",
    [p.commands.close]: "Close the garage door",
    ...(p.autoClose?.keepOpenCommand ? { [p.autoClose.keepOpenCommand]: "Keep the garage door open until it next closes" } : {}),
  }),
  notifyPerHour: 30,
  initial: () => ({}),

  // The door from its contact, a press under way, the countdown; open and close as the commands do.
  view(state, ctx) {
    const p = ctx.params;
    const door = ctx.get(p.contact);
    const known = door !== undefined && (door.state === "on" || door.state === "off");
    const isOpen = known && door.state === "on";
    const fields: CardField[] = [
      {
        label: "Door",
        value: known ? (isOpen ? "open" : "closed") : (door?.state ?? "not reporting"),
        ...(door !== undefined && door.since > 0 ? { since: door.since } : {}),
        ...(!known ? { tone: "bad" as const } : isOpen ? { tone: "warn" as const } : {}),
      },
    ];
    if (state.pending !== undefined) fields.push({ label: "Under way", value: state.pending === "open" ? "opening" : "closing" });
    if (state.auto !== undefined) fields.push({ label: "Auto-close", value: state.auto === "noticed" ? "announced" : "reminded", tone: "warn" });
    if (state.kept === true) fields.push({ label: "Auto-close", value: "kept open until it closes" });
    const busy = state.pending !== undefined || !known;
    const keep = p.autoClose?.keepOpenCommand;
    return {
      title: "Garage door",
      fields,
      buttons: [
        { label: "Open", command: p.commands.open, confirm: "Open the garage door?", ...(busy || isOpen ? { disabled: true } : {}) },
        { label: "Close", command: p.commands.close, confirm: "Close the garage door?", ...(busy || !isOpen ? { disabled: true } : {}) },
        ...(keep !== undefined ? [{ label: "Keep open", command: keep, ...(!isOpen || state.kept === true ? { disabled: true } : {}) }] : []),
      ],
    };
  },

  decide(state, input, ctx) {
    const p = ctx.params;
    const ac = p.autoClose;
    const t = textsOf(p);
    const reached = (want: Want) => (want === "open" ? t.open : t.closed);
    const confirmMs = seconds(p.confirmSec ?? 30);
    const domain = p.button.slice(0, p.button.indexOf("."));
    const press = { kind: "call" as const, service: `${domain}.turn_on`, entities: [p.button] };
    const open = () => ctx.value(p.contact) === true;
    /** Nobody there, as the presence sensor reports it (no reading is not "nobody"). */
    const nobody = () => ac !== undefined && ctx.value(ac.presence) === false;
    const counting = () => ctx.timer(AUTO) !== undefined;
    /** The countdown's first step: the announcement, noticeAfterMin after `from`. */
    const arm = (from: number) => setTimer(AUTO, Math.max(ctx.now, from + minutes(ac?.noticeAfterMin ?? 3)));
    const mayCount = (s: State) => ac !== undefined && open() && nobody() && s.pending === undefined && s.kept !== true;
    /** Stop a countdown; say so only if it was announced. */
    const stop = (reason: string, say?: string) => ({
      why: `auto-close stopped: ${reason}`,
      events: [{ tag: "AutoStopped" as const, reason }],
      ...(state.auto !== undefined && say !== undefined ? { actions: [notify(say)] } : {}),
      timers: counting() ? [cancelTimer(AUTO)] : [],
    });

    switch (input.kind) {
      case "command": {
        const by = input.from.user ?? input.from.channel;
        const reply = (text: string, extra: object = {}) => ({ why: `${input.command} by ${by}: ${text}`, actions: [notify(text)], ...extra });
        if (ac?.keepOpenCommand !== undefined && input.command === ac.keepOpenCommand) {
          if (!open()) return reply(t.closed);
          return reply(t.keepOpen, {
            events: [{ tag: "KeptOpen", by }],
            timers: counting() ? [cancelTimer(AUTO)] : [],
          });
        }
        const want: Want | undefined = input.command === p.commands.open ? "open" : input.command === p.commands.close ? "close" : undefined;
        if (want === undefined) return undefined;
        const door = ctx.get(p.contact);
        if (door === undefined || (door.state !== "on" && door.state !== "off")) {
          return reply(fill(t.sensorDown, { state: door?.state ?? "missing" }));
        }
        if (state.pending !== undefined) return reply(t.busy);
        const isOpen = door.state === "on";
        if (want === "open" && isOpen) return reply(t.alreadyOpen);
        if (want === "close" && !isOpen) return reply(t.alreadyClosed);
        const age = (ctx.now - door.since) / 1000;
        if (want === "close" && age < (p.settleSec ?? 30)) {
          return reply(fill(t.stillMoving, { s: Math.round(age) }));
        }
        return {
          why: `${want} by ${by}: door ${isOpen ? "open" : "closed"}, pressing ${p.button}`,
          events: [{ tag: "Pressed", want, by }],
          actions: [press, notify(want === "open" ? t.opening : t.closing)],
          timers: [setTimer(CONFIRM, ctx.now + confirmMs), ...(counting() ? [cancelTimer(AUTO)] : [])],
        };
      }

      case "signal": {
        if (input.entity === p.contact) {
          const isOpen = input.value === true;
          if (state.pending !== undefined) {
            if (isOpen !== (state.pending === "open")) return undefined;
            const after: State = { kept: isOpen ? state.kept === true : false };
            return {
              why: `door ${isOpen ? "open" : "closed"}`,
              events: [{ tag: "Arrived", want: state.pending }],
              actions: [notify(reached(state.pending))],
              timers: [cancelTimer(CONFIRM), ...(mayCount(after) ? [arm(ctx.now)] : [])],
            };
          }
          if (!isOpen) {
            if (!counting() && state.auto === undefined && state.kept !== true) return undefined;
            return { why: `${p.contact} closed`, events: [{ tag: "DoorClosed" }], timers: counting() ? [cancelTimer(AUTO)] : [] };
          }
          if (mayCount(state) && !counting()) return { why: `${p.contact} open with nobody there, auto-close countdown`, timers: [arm(ctx.now)] };
          return undefined;
        }
        if (ac !== undefined && input.entity === ac.presence) {
          if (input.value !== false) {
            if (!counting() && state.auto === undefined) return undefined;
            return stop(`${ac.presence} ${input.value === true ? "on" : "not reporting"}`, t.autoStopped);
          }
          if (mayCount(state) && !counting()) return { why: `nobody at ${ac.presence}, garage open: auto-close countdown`, timers: [arm(ctx.now)] };
        }
        return undefined;
      }

      case "timer": {
        if (input.timer === AUTO) return autoStep(state, ctx, press, confirmMs);
        if (input.timer !== CONFIRM || state.pending === undefined) return undefined;
        const want = state.pending;
        // The contact may have got there without a signal (a restart in between).
        if ((ctx.value(p.contact) === true) === (want === "open")) {
          return { why: `door ${want === "open" ? "open" : "closed"} at the deadline`, events: [{ tag: "Arrived", want }], actions: [notify(reached(want))] };
        }
        return {
          why: `door not ${want === "open" ? "open" : "closed"} ${confirmMs / 1000} s after the press`,
          events: [{ tag: "NotArrived", want }],
          actions: [notify(fill(want === "open" ? t.didNotOpen : t.didNotClose, { s: confirmMs / 1000 }))],
        };
      }

      case "start":
        if (!mayCount(state) || counting()) return undefined;
        // Open and empty since before boot: count from then.
        return { why: "garage open with nobody there at start", timers: [arm(heldSince(ctx, [p.contact, ac!.presence]))] };

      default:
        return undefined;
    }
  },

  evolve(state, event) {
    switch (event.tag) {
      case "Pressed":
        return { pending: event.want, ...(state.kept ? { kept: true } : {}) };
      case "Arrived":
        return event.want === "open" && state.kept ? { kept: true } : {};
      case "NotArrived":
        return state.kept ? { kept: true } : {};
      case "AutoNoticed":
        return { ...state, auto: "noticed" };
      case "AutoReminded":
        return { ...state, auto: "reminded" };
      case "AutoStopped": {
        const { auto: _auto, ...rest } = state;
        return rest;
      }
      case "KeptOpen":
        return { ...(state.pending !== undefined ? { pending: state.pending } : {}), kept: true };
      case "DoorClosed":
        return state.pending !== undefined ? { pending: state.pending } : {};
    }
  },
});

/** The countdown: announce, remind, close — each step re-checks the door and the room. */
function autoStep(state: State, ctx: DecideCtx<GarageDoorParams>, press: { kind: "call"; service: string; entities: string[] }, confirmMs: number) {
  const p = ctx.params;
  const t = textsOf(p);
  const ac = p.autoClose!;
  const closeIn = ac.closeInMin ?? 5;
  const remind = Math.min(ac.remindBeforeMin ?? 1, closeIn);
  const stopped = (reason: string) => ({ why: `auto-close stopped: ${reason}`, events: [{ tag: "AutoStopped" as const, reason }] });
  if (ctx.value(p.contact) !== true) return stopped("door not open");
  if (state.kept) return stopped("kept open");
  if (state.pending !== undefined) return stopped("a command is under way");
  if (ctx.value(ac.presence) !== false) return stopped(`${ac.presence} is not off`);
  const keep = ac.keepOpenCommand ? fill(t.keepHint, { command: ac.keepOpenCommand }) : "";

  if (state.auto === undefined) {
    const next = remind > 0 && remind < closeIn ? closeIn - remind : closeIn;
    return {
      why: "garage open with nobody there: announcing the auto-close",
      events: [{ tag: "AutoNoticed" as const, closeInMin: closeIn }],
      actions: [notify(fill(t.autoAnnounce, { min: closeIn, keep }))],
      timers: [setTimer(AUTO, ctx.now + minutes(next))],
    };
  }
  if (state.auto === "noticed" && remind > 0 && remind < closeIn) {
    return {
      why: `auto-close in ${remind} min`,
      events: [{ tag: "AutoReminded" as const }],
      actions: [notify(fill(t.autoRemind, { min: remind, keep }))],
      timers: [setTimer(AUTO, ctx.now + minutes(remind))],
    };
  }
  return {
    why: `auto-close: open, nobody at ${ac.presence}, pressing ${p.button}`,
    events: [{ tag: "AutoStopped" as const, reason: "closing" }, { tag: "Pressed" as const, want: "close" as const, by: "auto-close" }],
    actions: [press, notify(t.autoClosing)],
    timers: [setTimer(CONFIRM, ctx.now + confirmMs)],
  };
}

export default garageDoor;
