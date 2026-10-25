// screen-guard — a sun screen (an awning, a roller screen over the terrace) is out for
// the sun and comes in for everything else: after sundown, in a strong wind, and before
// rain. The dark and the wind close it at once and say so; rain is announced first, as
// an alert (whoever sits under it has time), and the screen comes in closeAfterMin
// later, raining or not: it was announced.
//
// It only ever closes. Opening is the people's (a wall button, the app); a screen opened
// while it is dark or windy comes in again, and they are told why. A close has settleMin
// to arrive (the motor runs for minutes, and a Fibaro roller-shutter module reports
// late); still open after that, the close is sent once more, then the household is
// alerted and the screen left alone until it reads closed.
//
// The wind and the weather are the house's outdoor conditions (allowlist.json "outdoor":
// a wind sensor when there is one, else the weather entity's wind_speed and its state as
// the condition); the sun is sun.sun's elevation. No reading never closes anything.
//
// The covers belong to the instance that moves them for people (button-cover shares
// them); this guard operates them too, through uses.

import { call, cancelTimer, defineHeuristic, fill, minutes, notify, param, readOutdoor, setTimer, type CardField, type DecideCtx, type Decision, type Infer, type Observed } from "teobeanie";

/** The messages of a screen-guard instance; {slots} are filled in. */
export interface ScreenGuardTexts {
  sunClosed: string;
  /** {wind}: the wind speed. */
  windClosed: string;
  /** {condition}: the weather condition; {min}: minutes to closing. */
  rainWarning: string;
  rainClosed: string;
  /** {n}: the closes sent. */
  stillOpen: string;
  /** {error}: what Home Assistant said. */
  closeFailed: string;
}

export const SCREEN_GUARD_TEXTS: ScreenGuardTexts = {
  sunClosed: "Sun screen closed: the sun is down.",
  windClosed: "Sun screen closed: wind {wind} km/h.",
  rainWarning: "Rain is coming ({condition}): closing the sun screen in {min} min.",
  rainClosed: "Sun screen closed: rain.",
  stillOpen: "Sun screen still open after {n} closes, please check it.",
  closeFailed: "Closing the sun screen failed: {error}.",
};

/** Weather conditions (the weather entity's state) that are rain, or as bad. */
export const RAIN_CONDITIONS = ["rainy", "pouring", "lightning-rainy", "hail", "snowy-rainy", "snowy"];

const SCREEN_GUARD_PARAMS = param.object({
  covers: param.entities("cover").doc("The screen: every cover entity of it (a Fibaro module has two)."),
  closedPosition: param
    .number({ unit: "%", min: 0, max: 100 })
    .default(0)
    .doc("The position that is closed (the screen in): 0 for most screens, 100 for one wired the other way round."),
  sunBelow: param
    .number({ unit: "°", min: -90, max: 90 })
    .optional()
    .doc("Close while the sun's elevation is below this (0: sundown; sun.sun must be in the house scope); absent: the sun does not close it."),
  windAbove: param
    .number({ unit: "km/h", min: 0 })
    .optional()
    .doc("Close while the wind is above this (the house's outdoor wind speed); absent: the wind does not close it."),
  rain: param
    .object({
      conditions: param.strings().default(RAIN_CONDITIONS).doc("The weather conditions that are rain."),
      closeAfterMin: param.duration("min", { positive: true }).default(10).doc("From the alert to closing, minutes."),
    })
    .optional()
    .doc("Close before rain: an alert first, the screen comes in closeAfterMin later."),
  settleMin: param.duration("min", { positive: true }).default(3).doc("A close has this long to arrive before the screen is looked at again."),
  texts: param
    .texts(SCREEN_GUARD_TEXTS, {
      windClosed: "{wind}: the wind speed.",
      rainWarning: "{condition}: the weather condition; {min}: minutes to closing.",
      stillOpen: "{n}: the closes sent.",
      closeFailed: "{error}: what Home Assistant said.",
    })
    .doc("Override any of the messages (the English defaults stay for the rest)."),
});

export type ScreenGuardParams = Infer<typeof SCREEN_GUARD_PARAMS>;

type Reason = "sun" | "wind" | "rain";

type Event =
  /** Rain: the alert went out, the countdown runs. */
  | { tag: "RainWarned"; at: number }
  /** A close was sent, the n-th since the screen last read closed. */
  | { tag: "CloseSent"; at: number; reason: Reason; attempts: number }
  /** Still open after the closes: alerted, left alone until it reads closed. */
  | { tag: "GivenUp"; at: number }
  /** The screen reads closed: whatever was under way is over. */
  | { tag: "In" };

interface State {
  /** The rain alert went out at (absent: no countdown). */
  warnedAt?: number;
  /** The last close sent, and how many since the screen last read closed. */
  closing?: { at: number; reason: Reason; attempts: number };
  /** Alerted that it does not close; left alone until it reads closed. */
  givenUp?: true;
}

const RAIN = "rain";
const RECHECK = "recheck";
/** Closes sent before giving up. */
const MAX_CLOSES = 2;

const textsOf = (p: ScreenGuardParams): ScreenGuardTexts => ({ ...SCREEN_GUARD_TEXTS, ...p.texts });
const live = (o: Observed | undefined): o is Observed => o !== undefined && o.state !== "unavailable" && o.state !== "unknown";

/** Whether a cover is open (the screen out): by its position when it reports one, else by its state. */
export function isOpen(o: Observed | undefined, closedPosition: number): boolean {
  if (!live(o)) return false;
  const closedAtZero = closedPosition <= 50;
  // Moving away from closed is open already, whatever the position says yet.
  if (o.state === (closedAtZero ? "opening" : "closing")) return true;
  const pos = o.attributes["current_position"];
  if (typeof pos === "number" && Number.isFinite(pos)) return closedAtZero ? pos > closedPosition : pos < closedPosition;
  return o.state === (closedAtZero ? "open" : "closed");
}

const closeCall = (cover: string, closedPosition: number) =>
  closedPosition === 0 ? call("cover.close_cover", cover) : closedPosition === 100 ? call("cover.open_cover", cover) : call("cover.set_cover_position", cover, { position: closedPosition });

/** What the sky says now, read once per decision. */
interface Sky {
  dark: boolean;
  elevation?: number;
  windy: boolean;
  wind?: number;
  raining: boolean;
  condition?: string;
}

function sky(ctx: DecideCtx<ScreenGuardParams>): Sky {
  const p = ctx.params;
  const sun = ctx.get("sun.sun");
  const el = sun?.attributes["elevation"];
  const elevation = typeof el === "number" && Number.isFinite(el) ? el : undefined;
  const dark = p.sunBelow !== undefined && live(sun) && (elevation !== undefined ? elevation < p.sunBelow : sun.state === "below_horizon");
  const o = readOutdoor((e) => ctx.get(e), ctx.house.outdoor);
  const wind = o.windSpeed !== undefined ? Math.round(o.windSpeed * 10) / 10 : undefined;
  const windy = p.windAbove !== undefined && wind !== undefined && wind > p.windAbove;
  const raining = p.rain !== undefined && o.condition !== undefined && (p.rain.conditions ?? RAIN_CONDITIONS).includes(o.condition);
  return {
    dark,
    windy,
    raining,
    ...(elevation !== undefined ? { elevation } : {}),
    ...(wind !== undefined ? { wind } : {}),
    ...(o.condition !== undefined ? { condition: o.condition } : {}),
  };
}

const fmtMin = (ms: number): string => `${Math.round(ms / 60_000)} min`;

export const screenGuard = defineHeuristic<ScreenGuardParams, State, Event>({
  id: "screen-guard",
  pattern: "guard",
  title: "Sun screen guard",
  description: "A sun screen comes in after sundown, at once in a strong wind, and before rain, which is announced first.",
  guarantees:
    "It only closes, never opens. The dark and the wind close the screen at once and say so; rain is announced as an alert and the screen comes in after the countdown. A close that does not arrive is sent once more, then the household is alerted. No reading never closes anything.",
  params: SCREEN_GUARD_PARAMS,
  usesOutdoor: true,
  watch: (p) => [...p.covers, ...(p.sunBelow !== undefined ? ["sun.sun"] : [])],
  // The position moves without the state; the sun's elevation is an attribute.
  watchAttributes: (p) => [...p.covers, ...(p.sunBelow !== undefined ? ["sun.sun"] : [])],
  actuates: () => [],
  uses: (p) => p.covers,
  initial: () => ({}),

  view(state, ctx) {
    const closed = ctx.params.closedPosition ?? 0;
    const covers = ctx.params.covers.map((c) => ctx.get(c));
    const known = covers.some(live);
    const open = covers.some((o) => isOpen(o, closed));
    const since = Math.max(0, ...covers.map((o) => o?.since ?? 0));
    const fields: CardField[] = [
      {
        label: "Screen",
        value: !known ? "not reporting" : open ? "open" : "closed",
        ...(since > 0 ? { since } : {}),
        ...(!known ? { tone: "bad" as const } : {}),
      },
    ];
    if (state.warnedAt !== undefined) fields.push({ label: "Rain", value: "alerted, closing soon", since: state.warnedAt, tone: "warn" });
    if (state.closing !== undefined) fields.push({ label: "Closing", value: `${state.closing.reason}, close ${state.closing.attempts}`, since: state.closing.at, tone: "warn" });
    if (state.givenUp === true) fields.push({ label: "Closing", value: "did not arrive, check the screen", tone: "bad" });
    return { title: "Sun screen", fields };
  },

  decide(state, input, ctx) {
    const p = ctx.params;
    const t = textsOf(p);
    const closed = p.closedPosition ?? 0;
    const settle = minutes(p.settleMin ?? 3);
    switch (input.kind) {
      case "outcome": {
        if (input.ok || input.action.kind !== "call") return undefined;
        const error = input.error ?? "refused";
        return { why: `${input.action.service} ${input.action.entities.join(",")} failed: ${error}`, actions: [notify(fill(t.closeFailed, { error }))] };
      }
      case "signal":
      case "timer":
      case "start":
        break;
      default:
        return undefined;
    }

    const open = p.covers.some((c) => isOpen(ctx.get(c), closed));
    const counting = ctx.timer(RAIN) !== undefined;
    const pending = [...(counting ? [cancelTimer(RAIN)] : []), ...(ctx.timer(RECHECK) !== undefined ? [cancelTimer(RECHECK)] : [])];

    if (!open) {
      if (state.warnedAt === undefined && state.closing === undefined && state.givenUp === undefined) return undefined;
      return { why: "the screen is closed", events: [{ tag: "In" }], timers: pending };
    }
    if (state.givenUp === true) return undefined;

    const close = (reason: Reason, attempts: number, why: string, said?: string): Decision<Event> => ({
      why,
      events: [{ tag: "CloseSent", at: ctx.now, reason, attempts }],
      actions: [...p.covers.map((c) => closeCall(c, closed)), ...(said !== undefined ? [notify(said, { info: true })] : [])],
      timers: [...(counting ? [cancelTimer(RAIN)] : []), setTimer(RECHECK, ctx.now + settle)],
    });

    // A close under way has settleMin to arrive; then once more; then the alert.
    if (state.closing !== undefined) {
      if (ctx.now < state.closing.at + settle) return undefined;
      const ago = fmtMin(ctx.now - state.closing.at);
      if (state.closing.attempts >= MAX_CLOSES) {
        return {
          why: `still open ${ago} after close ${state.closing.attempts}: alerting, leaving it until it reads closed`,
          events: [{ tag: "GivenUp", at: ctx.now }],
          actions: [notify(fill(t.stillOpen, { n: state.closing.attempts }))],
          timers: pending,
        };
      }
      return close(state.closing.reason, state.closing.attempts + 1, `still open ${ago} after the close: closing again`);
    }

    const s = sky(ctx);
    if (s.windy) return close("wind", 1, `wind ${s.wind} km/h, above ${p.windAbove}: closing`, fill(t.windClosed, { wind: s.wind! }));
    if (s.dark) return close("sun", 1, `the sun is down (${s.elevation !== undefined ? `${s.elevation}°` : "below the horizon"}): closing`, t.sunClosed);
    if (input.kind === "timer" && input.timer === RAIN) return close("rain", 1, "the rain countdown ran out: closing", t.rainClosed);
    if (s.raining && p.rain !== undefined && !counting && state.warnedAt === undefined) {
      const min = p.rain.closeAfterMin ?? 10;
      return {
        why: `${s.condition}: alerting, closing in ${min} min`,
        events: [{ tag: "RainWarned", at: ctx.now }],
        actions: [notify(fill(t.rainWarning, { condition: s.condition!, min }))],
        timers: [setTimer(RAIN, ctx.now + minutes(min))],
      };
    }
    return undefined;
  },

  evolve(state, event) {
    switch (event.tag) {
      case "RainWarned":
        return { ...state, warnedAt: event.at };
      case "CloseSent": {
        const { warnedAt: _warned, ...rest } = state;
        const { at, reason, attempts } = event;
        return { ...rest, closing: { at, reason, attempts } };
      }
      case "GivenUp":
        return { ...state, givenUp: true };
      case "In":
        return {};
    }
  },
});

export default screenGuard;
