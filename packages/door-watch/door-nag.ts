// door-nag — while a door stays open, send a reminder every N minutes; optionally
// stay quiet while someone is around.

import { cancelTimer, defineHeuristic, heldSince, minutes, notify, param, setTimer, type Infer } from "teobeanie";

const DOOR_NAG_PARAMS = param.object({
  door: param.entity().doc("The door contact: on = open."),
  everyMin: param.duration("min", { positive: true }).doc("Minutes between reminders, the first one after the door opened."),
  text: param.text().doc("The reminder."),
  quietWhileOn: param.entity().optional().doc("Skip a reminder (but keep counting) while this entity is on."),
});

export type DoorNagParams = Infer<typeof DOOR_NAG_PARAMS>;

type Event =
  | { tag: "Opened"; at: number }
  | { tag: "Nagged"; n: number; openMin: number }
  | { tag: "Closed"; openMin: number; nags: number };

interface State {
  openSince: number | null;
  nags: number;
}

const NAG = "nag";

export const doorNag = defineHeuristic<DoorNagParams, State, Event>({
  id: "door-nag",
  pattern: "notice",
  title: "Door left open",
  description: "Reminds the household every few minutes while a door stays open.",
  guarantees:
    "Only tells people, never switches anything; the reminders stop as soon as the door closes.",
  params: DOOR_NAG_PARAMS,
  watch: (p) => [p.door],
  reads: (p) => (p.quietWhileOn ? [p.quietWhileOn] : []),
  actuates: () => [],
  notifyPerHour: 60,
  initial: () => ({ openSince: null, nags: 0 }),

  // Open since when and how many reminders went out; closed since when.
  view(state, ctx) {
    const p = ctx.params;
    const door = ctx.get(p.door);
    const open = door?.value === true;
    const name = door?.attributes["friendly_name"];
    const since = open ? (state.openSince ?? door?.since) : door?.since;
    return {
      // HA names a contact "<device> Door" ("Front door Door"): keep the device's name.
      title: typeof name === "string" && name !== "" ? name.replace(/(\bdoor\b.*?)\s+door$/i, "$1") : "Door",
      fields: [
        {
          label: "Door",
          value: door === undefined ? "not reporting" : open ? "open" : door.value === false ? "closed" : door.state,
          ...(since !== undefined && since > 0 ? { since } : {}),
          ...(open ? { tone: "warn" as const } : door === undefined || door.value === null ? { tone: "bad" as const } : {}),
        },
        ...(open ? [{ label: "Reminders sent", value: state.nags }] : []),
      ],
    };
  },

  decide(state, input, ctx) {
    const p = ctx.params;
    const arm = () => setTimer(NAG, ctx.now + minutes(p.everyMin));
    switch (input.kind) {
      case "signal":
        if (input.value === true && ctx.timer(NAG) === undefined) {
          return {
            why: `${p.door} opened, first reminder in ${p.everyMin} min`,
            events: [{ tag: "Opened", at: ctx.now }],
            timers: [arm()],
          };
        }
        if (input.value === false && (state.openSince !== null || ctx.timer(NAG) !== undefined)) {
          const openMin = state.openSince === null ? 0 : Math.round((ctx.now - state.openSince) / 60_000);
          return {
            why: `${p.door} closed`,
            events: [{ tag: "Closed", openMin, nags: state.nags }],
            timers: ctx.timer(NAG) !== undefined ? [cancelTimer(NAG)] : [],
          };
        }
        return undefined;
      case "timer": {
        if (ctx.value(p.door) !== true) return { why: `${p.door} no longer open` };
        if (p.quietWhileOn && ctx.value(p.quietWhileOn) === true) {
          return { why: `${p.quietWhileOn} on, staying quiet`, timers: [arm()] };
        }
        const openMin = Math.round((ctx.now - (state.openSince ?? ctx.now)) / 60_000);
        return {
          why: `${p.door} open for ${openMin} min`,
          events: [{ tag: "Nagged", n: state.nags + 1, openMin }],
          actions: [notify(p.text)],
          timers: [arm()],
        };
      }
      case "start":
        if (ctx.value(p.door) === true && ctx.timer(NAG) === undefined) {
          const openedAt = state.openSince ?? heldSince(ctx, [p.door]);
          // Keep the cadence the door has been on since it opened.
          const every = minutes(p.everyMin);
          const next = openedAt + every * Math.max(1, Math.ceil((ctx.now - openedAt) / every));
          return {
            why: `${p.door} open at start`,
            events: state.openSince === null ? [{ tag: "Opened", at: openedAt }] : [],
            timers: [setTimer(NAG, next)],
          };
        }
        return undefined;
      default:
        return undefined;
    }
  },

  evolve(state, event) {
    switch (event.tag) {
      case "Opened":
        return { openSince: event.at, nags: 0 };
      case "Nagged":
        return { ...state, nags: event.n };
      case "Closed":
        return { openSince: null, nags: 0 };
    }
  },
});

export default doorNag;
