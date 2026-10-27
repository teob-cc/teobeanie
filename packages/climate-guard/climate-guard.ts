// climate-guard — one climate unit (an air conditioner, a heat pump) kept within limits:
//
//   - while it heats or cools, its setpoint is the one for that mode; the unit's own
//     drift (an app schedule, a reset) is set back, a change made through HA by a user
//     stands until the next run;
//   - a run (heating or cooling, however it started) stops after maxRunMin; a cloud
//     unit that still reports the old run for a while after it was switched off (its
//     state catching up) is not a new run, for settleMin;
//   - switched off, it starts heating when the room is colder than startHeatBelow, and
//     cooling when it is warmer than startCoolAbove.
//
// Other modes (dry, fan only, auto) are left alone.
//
// Optional waiver: a command (`/climate_waive bedroom`) lifts the guard for one room
// for a while (default 3 h), to heat or cool beyond its limits. Meanwhile the unit is
// left alone: no setpoint, no longest run, no start. Then the guard takes the unit over
// as it finds it, as at a start: a run under way gets the mode's setpoint and counts
// from the waiver's end. Several instances share the command, each for its own room.
//
// Optional wish: a command (`/warm bedroom 21 2h`) heats one room to a temperature for
// a while (default 3 h), within the house's bounds for the unit's setpoint. Meanwhile
// the unit heats at that setpoint (switched to heat if it was off or cooling), with no
// longest run; its drift is set back, a person's change through HA becomes the wish's.
// Then the unit goes back to how it was: off stays off, another mode comes back, and a
// heating unit gets the guard's setpoint (a fresh longest run from the wish's end) or,
// where the guard holds none (a boiler's thermostat), the setpoint it had before. Someone
// switching the unit off or to another mode ends the wish. A wish and a waiver never run
// together: either ends the other. Several instances share the command, as the waiver.

import {
  boundFor,
  cancelTimer,
  EVAL,
  fill,
  hours,
  houseZone,
  keep,
  localMinutes,
  minutes,
  notify,
  param,
  parseDuration,
  release,
  rule,
  setTimer,
  call,
  type Action,
  type Card,
  type CommandSchema,
  type DecideCtx,
  type Decision,
  type HeuristicDef,
  type Infer,
  type Input,
  type RuleEvent,
  type RuleState,
} from "teobeanie";

/** The messages of a climate-guard waiver and wish; {slots} are filled in. */
export interface ClimateGuardTexts {
  /** {room}; {until}: house-local HH:MM. */
  waived: string;
  /** {room}: the waiver ran out, or was ended early. */
  resumed: string;
  /** {room}: "off" with no waiver running. */
  notWaived: string;
  /** {rooms}: the command for each room. */
  pick: string;
  /** {room}: what was asked; {rooms}: as in pick. */
  unknownRoom: string;
  /** {command}, {room}, {hours}: something after the room other than "off". */
  usage: string;
  /** {room}, {temperature}; {until}: house-local HH:MM. */
  wished: string;
  /** {room}: the wish ran out, or was ended early; the unit is back as it was. */
  wishEnded: string;
  /** {room}; {mode}: someone switched the unit off (or to another mode), which ends the wish. */
  wishStopped: string;
  /** {room}: "off" with no wish running. */
  notWished: string;
  /** {room}, {temperature}: what was asked; {min}, {max}: the house's bounds. */
  outOfRange: string;
  /** {hours}: the longest wish. */
  tooLong: string;
  /** {command}, {room}, {hours}: no temperature, or something that is not one. */
  wishUsage: string;
  /** {room}: the unit gives no state now. */
  unavailable: string;
  /** {room}: added to the wish's reply when it ended a waiver. */
  wishEndsWaiver: string;
  /** {room}: added to the waiver's reply when it ended a wish. */
  waiverEndsWish: string;
}

export const CLIMATE_GUARD_TEXTS: ClimateGuardTexts = {
  waived: "Climate guard lifted for {room} until {until}.",
  resumed: "Climate guard is back on for {room}.",
  notWaived: "The climate guard is on for {room}, nothing to end.",
  pick: "Which room? {rooms} (add off to end it early).",
  unknownRoom: 'No room "{room}". Rooms: {rooms}.',
  usage: "/{command} {room} lifts the climate guard there for {hours} h; /{command} {room} off ends it.",
  wished: "{room} heats to {temperature}° until {until}.",
  wishEnded: "{room} is back as it was before the wish.",
  wishStopped: "The wish for {room} has ended: the unit was switched {mode}.",
  notWished: "No wish runs for {room}, nothing to end.",
  outOfRange: "{room} can be set between {min}° and {max}°, not {temperature}°.",
  tooLong: "A wish lasts at most {hours} h.",
  wishUsage: "/{command} {room} 21 heats {room} to 21° for {hours} h; add a duration (2h, 90m) for another; /{command} {room} off ends it.",
  unavailable: "{room} does not answer now; try again later.",
  wishEndsWaiver: "The waiver for {room} has ended.",
  waiverEndsWish: "The wish for {room} has ended.",
};

const CLIMATE_GUARD_PARAMS = param.object({
  climate: param.entity("climate").doc("The climate entity."),
  setpoints: param
    .object({ heat: param.number({ unit: "°" }).optional(), cool: param.number({ unit: "°" }).optional() })
    .doc("Setpoint while running, per mode; {} holds none (a thermostat the guard only answers wishes for)."),
  maxRunMin: param.duration("min", { positive: true }).optional().doc("Longest heating or cooling run, minutes; then the unit is switched off."),
  startHeatBelow: param.number({ unit: "°" }).optional().doc("Switched off: start heating below this room temperature."),
  startCoolAbove: param.number({ unit: "°" }).optional().doc("Switched off: start cooling above this room temperature."),
  temperature: param.entity("sensor", "input_number").optional().doc("A room temperature sensor; default the unit's own current_temperature."),
  graceSec: param.duration("s").default(300).doc("Least time between two setpoint sends while the unit reports back, seconds."),
  settleMin: param
    .duration("min")
    .default(15)
    .doc("After a run is stopped at maxRunMin, a report of the unit running is the old state for this long, minutes."),
  waive: param
    .object({
      command: param.string().doc("Shared by the instances of the house's rooms; each answers for its own."),
      room: param.string().doc("`/climate_waive bedroom` (any case); `/climate_waive bedroom off` ends it early."),
      hours: param.duration("h", { positive: true }).default(3).doc("How long a waiver lasts."),
    })
    .optional()
    .doc('A command that lifts the guard for this room, e.g. { "command": "climate_waive", "room": "bedroom" }.'),
  warm: param
    .object({
      command: param.string().doc("Shared by the instances of the house's rooms; each answers for its own."),
      room: param.string().doc("`/warm bedroom 21` (any case), `/warm bedroom 21 2h`; `/warm bedroom off` ends it early."),
      defaultHours: param.duration("h", { positive: true }).default(3).doc("How long a wish lasts when no duration is given."),
      maxHours: param.duration("h", { positive: true }).default(12).doc("The longest wish."),
    })
    .optional()
    .doc('A command that heats this room to a temperature for a while, within the house\'s bounds, e.g. { "command": "warm", "room": "bedroom" }.'),
  texts: param
    .texts(CLIMATE_GUARD_TEXTS, {
      waived: "{room}; {until}: house-local HH:MM.",
      resumed: "{room}: the waiver ran out, or was ended early.",
      notWaived: '{room}: "off" with no waiver running.',
      pick: "{rooms}: the command for each room.",
      unknownRoom: "{room}: what was asked; {rooms}: as in pick.",
      usage: '{command}, {room}, {hours}: something after the room other than "off".',
      wished: "{room}, {temperature}; {until}: house-local HH:MM.",
      wishEnded: "{room}: the wish ran out, or was ended early.",
      wishStopped: "{room}; {mode}: what someone switched the unit to.",
      notWished: '{room}: "off" with no wish running.',
      outOfRange: "{room}, {temperature}: what was asked; {min}, {max}: the house's bounds.",
      tooLong: "{hours}: the longest wish.",
      wishUsage: "{command}, {room}, {hours}: no temperature, or not one.",
      unavailable: "{room}: the unit gives no state now.",
      wishEndsWaiver: "{room}: added to the wish's reply when it ended a waiver.",
      waiverEndsWish: "{room}: added to the waiver's reply when it ended a wish.",
    })
    .doc("Override any of the waiver's and the wish's messages (the English defaults stay for the rest)."),
});

export type ClimateGuardParams = Infer<typeof CLIMATE_GUARD_PARAMS>;

const guard = rule<ClimateGuardParams>(
  "climate-guard",
  ({ entity, held, within }, p) => {
    const unit = entity(p.climate);
    if (unit.state === undefined || unit.is("unavailable", "unknown")) return unit.to(keep);
    const running = () => unit.is("heat" as never, "cool" as never);
    // Evaluated every time, so their tracking survives the off and the stale report.
    const capped = p.maxRunMin !== undefined && held(running, minutes(p.maxRunMin));
    const justCapped = p.maxRunMin !== undefined && within(() => running() && capped, minutes(p.settleMin ?? 15));
    if (running()) {
      if (capped || justCapped) return unit.to("off" as never);
      const setpoint = p.setpoints[unit.state as "heat" | "cool"];
      return unit.to(setpoint !== undefined ? { temperature: setpoint } : release);
    }
    // Just stopped at the cap: the answer stays off, so a stale report is not a new answer.
    if (justCapped) return unit.to("off" as never);
    if (unit.is("off" as never)) {
      const reading = p.temperature !== undefined ? entity(p.temperature).value : unit.attr("current_temperature");
      const t = typeof reading === "number" ? reading : Number(reading);
      if (reading !== undefined && reading !== null && Number.isFinite(t)) {
        if (p.startHeatBelow !== undefined && t < p.startHeatBelow) return unit.to({ hvac_mode: "heat", ...withSetpoint(p.setpoints.heat) } as never);
        if (p.startCoolAbove !== undefined && t > p.startCoolAbove) return unit.to({ hvac_mode: "cool", ...withSetpoint(p.setpoints.cool) } as never);
      }
    }
    return unit.to(release);
  },
  {
    title: "Climate guard",
    description: "Setpoints per mode, a longest run, and a start below or above a room temperature; commands lift it for a room, or heat a room to a temperature, for a while.",
    guarantees:
      "A setpoint a person sets through Home Assistant stands until the next run; no run lasts longer than the longest run; a cloud unit's late report of an old run is not a new run; while a room's waiver runs, the unit is left alone; a wish keeps to the house's bounds and leaves the unit as it found it.",
    params: CLIMATE_GUARD_PARAMS,
    watch: (p) => [p.climate, ...(p.temperature !== undefined ? [p.temperature] : [])],
    owns: (p) => [p.climate],
    enforce: (p) => ({ graceSec: p.graceSec ?? 300, yieldToUsers: true }),
    pattern: "hold",
  },
);

function withSetpoint(t: number | undefined): { temperature?: number } {
  return t !== undefined ? { temperature: t } : {};
}

// ---- the waiver and the wish ----

interface Waiver {
  by: string;
  until: number;
}

/** How the unit was when a wish began: where it goes back to. */
interface Before {
  mode: string;
  temperature?: number;
}

interface Wish {
  by: string;
  /** The setpoint it heats at. */
  target: number;
  until: number;
  /** until, house-local HH:MM: what the card shows. */
  untilText: string;
  before: Before;
  /** When the setpoint was last sent (or a person set one): drift waits graceSec from here. */
  sentAt: number;
}

/** The rule's state, and the waiver or the wish while one runs. */
type GuardState = RuleState & { waiver?: Waiver; wish?: Wish };
export type ClimateGuardState = GuardState;

type GuardEvent =
  | { tag: "Waived"; by: string; until: number }
  | { tag: "WaiverEnded"; reason: string; by?: string }
  | { tag: "Wished"; by: string; target: number; until: number; untilText: string; before: Before; at: number }
  /** The setpoint sent again (drift), or taken from a person's change through HA. */
  | { tag: "WishHeld"; target: number; at: number }
  | { tag: "WishEnded"; reason: string; by?: string };
type GuardDecision = Decision<RuleEvent | GuardEvent>;

const WAIVER = "waiver";
const WISH = "wish";
/** A drift seen within graceSec of the last send: looked at again then. */
const WISH_CHECK = "wish-check";
/** What a wish may ask when the house gives no bound: the SafeActuator's own for climate setpoints. */
const NO_BOUND = { min: 15, max: 27 };
const textsOf = (p: ClimateGuardParams): ClimateGuardTexts => ({ ...CLIMATE_GUARD_TEXTS, ...p.texts });

/** House-local HH:MM. */
function clock(at: number, ctx: DecideCtx<unknown>): string {
  const m = localMinutes(at, houseZone(ctx.house));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "21", "21.5", "21,5", "21°", "21c" → 21.5-steps; anything else → undefined. */
function parseTemperature(text: string): number | undefined {
  const m = text.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*°?\s*c?$/);
  return m ? Math.round(Number(m[1]!.replace(",", ".")) * 2) / 2 : undefined;
}

/** The setpoints a wish may ask for this unit. */
const rangeOf = (ctx: { house: DecideCtx<unknown>["house"] }, climate: string) => boundFor(ctx.house, climate, "temperature") ?? NO_BOUND;

export const climateGuard: HeuristicDef<ClimateGuardParams, GuardState, RuleEvent | GuardEvent> = {
  ...guard,
  // Another instance may switch the unit on and off (a heating heuristic of the house's own); the guard's setpoint and longest run still apply.
  shares: (p) => [p.climate],
  commands: (p) => [...(p.waive !== undefined ? [p.waive.command] : []), ...(p.warm !== undefined ? [p.warm.command] : [])],
  commandArg: (p) => ({ ...(p.waive !== undefined ? { [p.waive.command]: p.waive.room } : {}), ...(p.warm !== undefined ? { [p.warm.command]: p.warm.room } : {}) }),
  commandHelp: (p) => ({
    ...(p.waive !== undefined ? { [p.waive.command]: "Lift the climate guard in a room for a while" } : {}),
    ...(p.warm !== undefined ? { [p.warm.command]: "Heat a room to a temperature for a while" } : {}),
  }),
  // A chat keyboard offers the room, and ending its waiver or wish while one runs.
  commandButtons: (p, s) => ({
    ...(p.waive !== undefined ? { [p.waive.command]: [p.waive.room, ...(s.waiver !== undefined ? [`${p.waive.room} off`] : [])] } : {}),
    ...(p.warm !== undefined ? { [p.warm.command]: [p.warm.room, ...(s.wish !== undefined ? [`${p.warm.room} off`] : [])] } : {}),
  }),
  commandSchema: (p, house) => {
    const out: Record<string, CommandSchema> = {};
    if (p.waive !== undefined) {
      out[p.waive.command] = {
        doc: `Lift the climate guard in a room for ${p.waive.hours ?? 3} h, to heat or cool beyond its limits; "off" ends it early.`,
        args: [
          { name: "room", kind: "choice", choices: [p.waive.room] },
          { name: "action", kind: "choice", choices: ["off"], optional: true, doc: "off: end the waiver now." },
        ],
      };
    }
    if (p.warm !== undefined) {
      const { min, max } = rangeOf({ house }, p.climate);
      out[p.warm.command] = {
        doc: `Heat a room to a temperature for a while (default ${p.warm.defaultHours ?? 3} h), then put it back as it was; "off" instead of a temperature ends it early.`,
        args: [
          { name: "room", kind: "choice", choices: [p.warm.room] },
          { name: "temperature", kind: "number", min, max, step: 0.5, unit: "°C", or: ["off"], doc: "The setpoint, or off to end the wish." },
          { name: "duration", kind: "duration", maxMin: (p.warm.maxHours ?? 12) * 60, defaultMin: (p.warm.defaultHours ?? 3) * 60, optional: true },
        ],
      };
    }
    return out;
  },

  view(state, ctx) {
    const p = ctx.params;
    const room = p.warm?.room ?? p.waive?.room ?? ctx.instance;
    const unit = ctx.get(p.climate);
    const fields: Card["fields"] = [
      { label: "Mode", value: unit?.state ?? null },
      { label: "Setpoint", value: typeof unit?.attributes["temperature"] === "number" ? unit.attributes["temperature"] : null, unit: "°" },
      { label: "Room", value: typeof unit?.attributes["current_temperature"] === "number" ? unit.attributes["current_temperature"] : null, unit: "°" },
    ];
    const buttons: NonNullable<Card["buttons"]> = [];
    if (state.wish !== undefined && p.warm !== undefined) {
      fields.push({ label: "Wish", value: `${state.wish.target}° until ${state.wish.untilText}`, tone: "warn" });
      buttons.push({ label: "End the wish", command: p.warm.command, args: [p.warm.room, "off"] });
    }
    if (state.waiver !== undefined && p.waive !== undefined) {
      fields.push({ label: "Waiver", value: `by ${state.waiver.by}`, tone: "warn" });
      buttons.push({ label: "End the waiver", command: p.waive.command, args: [p.waive.room, "off"] });
    }
    return { title: room, fields, ...(buttons.length > 0 ? { buttons } : {}) };
  },

  decide(state, input, ctx) {
    const p = ctx.params;
    if (input.kind === "command") {
      if (p.warm !== undefined && input.command === p.warm.command) return warmCommand(state, input, ctx);
      return p.waive !== undefined && input.command === p.waive.command ? command(state, input, ctx) : undefined;
    }
    const wish = state.wish;
    if (wish !== undefined) {
      if (input.kind === "timer" && input.timer === WISH) return endWish(state, ctx, "ran out", { firing: true });
      // Ran out while the add-on was down; its timer, due already, is cancelled.
      if (input.kind === "start" && ctx.now >= wish.until) return endWish(state, ctx, "ran out");
      return holdWish(state, wish, input, ctx);
    }
    const w = state.waiver;
    if (w === undefined) return input.kind === "timer" && (input.timer === WAIVER || input.timer === WISH || input.timer === WISH_CHECK) ? undefined : guard.decide(state, input, ctx);
    if (input.kind === "timer" && input.timer === WAIVER) return resume(state, ctx, "ran out", { firing: true });
    // Ran out while the add-on was down; its timer, due already, is cancelled.
    if (input.kind === "start" && ctx.now >= w.until) return resume(state, ctx, "ran out");
    // Meanwhile the unit is the people's; said at a start (and on a stray re-evaluation).
    if (input.kind === "start" || input.kind === "timer") return { why: `waived until ${clock(w.until, ctx)} by ${w.by}: ${p.climate} left alone` };
    return undefined;
  },

  evolve(state, event) {
    switch (event.tag) {
      case "Waived":
        return { ...state, waiver: { by: event.by, until: event.until } };
      case "Wished": {
        const { by, target, until, untilText, before, at } = event;
        return { ...state, wish: { by, target, until, untilText, before, sentAt: at } };
      }
      case "WishHeld": {
        const { target, at } = event;
        return state.wish !== undefined ? { ...state, wish: { ...state.wish, target, sentAt: at } } : state;
      }
      case "WaiverEnded":
      case "WishEnded":
        // The guard starts over: what it wanted before, and its run tracking, are gone.
        return { desired: {}, track: {}, unwatched: state.unwatched ?? [] };
      default: {
        const next = guard.evolve(state, event) as GuardState;
        return { ...next, ...(state.waiver !== undefined ? { waiver: state.waiver } : {}), ...(state.wish !== undefined ? { wish: state.wish } : {}) };
      }
    }
  },
};

type CommandInput = Extract<Input, { kind: "command" }>;

/**
 * Whether a command is for this instance's room. Another instance's room: silent (null).
 * No room, or one nobody answers for: one reply, from the instance first in the list.
 */
function forRoom(input: CommandInput, room: string, reply: (text: string) => GuardDecision, t: ClimateGuardTexts): "mine" | GuardDecision | null {
  const asked = input.args[0];
  if (asked !== undefined && asked.toLowerCase() === room.toLowerCase()) return "mine";
  const choices = input.choices ?? [room];
  if (asked !== undefined && choices.some((c) => c.toLowerCase() === asked.toLowerCase())) return null;
  if (choices[0] !== room) return null;
  const rooms = choices.map((c) => `/${input.command} ${c}`).join(", ");
  return reply(asked === undefined ? fill(t.pick, { rooms }) : fill(t.unknownRoom, { room: asked, rooms }));
}

function command(state: GuardState, input: CommandInput, ctx: DecideCtx<ClimateGuardParams>): GuardDecision | undefined {
  const p = ctx.params;
  const w = p.waive!;
  const t = textsOf(p);
  const by = input.from.user ?? input.from.channel;
  const reply = (text: string, extra: GuardDecision = {}): GuardDecision => ({ why: `${input.command} by ${by}: ${text}`, actions: [notify(text)], ...extra });
  const mine = forRoom(input, w.room, reply, t);
  if (mine !== "mine") return mine ?? undefined;
  const sub = input.args[1];
  const hrs = w.hours ?? 3;
  if (sub !== undefined && sub.toLowerCase() !== "off") return reply(fill(t.usage, { command: w.command, room: w.room, hours: hrs }));
  if (sub !== undefined) {
    if (state.waiver === undefined) return reply(fill(t.notWaived, { room: w.room }));
    return resume(state, ctx, `ended early by ${by}`, { by });
  }
  // A new waiver, or a running one renewed from now. A wish under way ends, and the unit is left as it is.
  const until = ctx.now + hours(hrs);
  const endsWish = state.wish !== undefined;
  const text = fill(t.waived, { room: w.room, until: clock(until, ctx) }) + (endsWish ? ` ${fill(t.waiverEndsWish, { room: p.warm?.room ?? w.room })}` : "");
  return reply(text, {
    why: `${input.command} by ${by}: guard waived for ${w.room} until ${clock(until, ctx)}, ${p.climate} left alone${endsWish ? "; the wish ends" : ""}`,
    events: [...(endsWish ? [{ tag: "WishEnded" as const, reason: "a waiver", by }] : []), { tag: "Waived", by, until }],
    timers: [
      setTimer(WAIVER, until),
      ...(ctx.timer(EVAL) !== undefined ? [cancelTimer(EVAL)] : []),
      ...(ctx.timer(WISH) !== undefined ? [cancelTimer(WISH)] : []),
      ...(ctx.timer(WISH_CHECK) !== undefined ? [cancelTimer(WISH_CHECK)] : []),
    ],
  });
}

/**
 * The waiver is over: the guard takes the unit over as it finds it, as at a start. A
 * run under way counts from now (its setpoint set back), not from when it began.
 */
function resume(state: GuardState, ctx: DecideCtx<ClimateGuardParams>, reason: string, o: { by?: string; firing?: boolean } = {}): GuardDecision {
  const p = ctx.params;
  const room = p.waive?.room ?? p.climate;
  const d = takeOver(state, ctx);
  return {
    why: `waiver for ${room} ${reason}, guard back on${d?.why !== undefined ? ` · ${d.why}` : ""}`,
    events: [{ tag: "WaiverEnded", reason, ...(o.by !== undefined ? { by: o.by } : {}) }, ...(d?.events ?? [])],
    actions: [notify(fill(textsOf(p).resumed, { room }), { info: true }), ...(d?.actions ?? [])],
    timers: [...(!o.firing && ctx.timer(WAIVER) !== undefined ? [cancelTimer(WAIVER)] : []), ...(d?.timers ?? [])],
  };
}

/** The guard's own rule, from scratch, as at a start: a run under way counts from now. */
function takeOver(state: GuardState, ctx: DecideCtx<ClimateGuardParams>): Decision<RuleEvent> | undefined {
  const p = ctx.params;
  const fresh: DecideCtx<ClimateGuardParams> = {
    ...ctx,
    get: (e) => {
      const seen = ctx.get(e);
      return e === p.climate && seen !== undefined ? { ...seen, since: ctx.now } : seen;
    },
  };
  return guard.decide({ desired: {}, track: {}, unwatched: state.unwatched ?? [] }, { kind: "start", at: ctx.now }, fresh) as Decision<RuleEvent> | undefined;
}

// ---- the wish ----

function warmCommand(state: GuardState, input: CommandInput, ctx: DecideCtx<ClimateGuardParams>): GuardDecision | undefined {
  const p = ctx.params;
  const w = p.warm!;
  const t = textsOf(p);
  const by = input.from.user ?? input.from.channel;
  const reply = (text: string, extra: GuardDecision = {}): GuardDecision => ({ why: `${input.command} by ${by}: ${text}`, actions: [notify(text)], ...extra });
  const mine = forRoom(input, w.room, reply, t);
  if (mine !== "mine") return mine ?? undefined;
  const defaultHours = w.defaultHours ?? 3;
  const maxHours = w.maxHours ?? 12;
  const [, asked, duration, ...rest] = input.args;
  const usage = (): GuardDecision => reply(fill(t.wishUsage, { command: w.command, room: w.room, hours: defaultHours }));
  if (asked === undefined || rest.length > 0) return usage();
  if (asked.toLowerCase() === "off") {
    if (duration !== undefined) return usage();
    if (state.wish === undefined) return reply(fill(t.notWished, { room: w.room }));
    return endWish(state, ctx, `ended early by ${by}`, { by, reply: true });
  }
  const target = parseTemperature(asked);
  if (target === undefined) return usage();
  const { min, max } = rangeOf(ctx, p.climate);
  if (target < min || target > max) return reply(fill(t.outOfRange, { room: w.room, temperature: target, min, max }));
  const ms = duration === undefined ? hours(defaultHours) : parseDuration(duration);
  if (ms === undefined) return usage();
  if (ms > hours(maxHours)) return reply(fill(t.tooLong, { hours: maxHours }));
  const unit = ctx.get(p.climate);
  if (unit === undefined || unit.state === "unavailable" || unit.state === "unknown") return reply(fill(t.unavailable, { room: w.room }));

  const until = ctx.now + ms;
  const untilText = clock(until, ctx);
  // A wish renewed keeps where the first one found the unit.
  const setpoint = unit.attributes["temperature"];
  const before: Before = state.wish?.before ?? { mode: unit.state, ...(typeof setpoint === "number" ? { temperature: setpoint } : {}) };
  const actions: Action[] = [];
  if (unit.state !== "heat") actions.push(call("climate.set_hvac_mode", p.climate, { hvac_mode: "heat" }));
  if (unit.state !== "heat" || setpoint !== target) actions.push(call("climate.set_temperature", p.climate, { temperature: target }));
  const endsWaiver = state.waiver !== undefined;
  const text = fill(t.wished, { room: w.room, temperature: target, until: untilText }) + (endsWaiver ? ` ${fill(t.wishEndsWaiver, { room: p.waive?.room ?? w.room })}` : "");
  return {
    why: `${input.command} by ${by}: ${p.climate} heats at ${target}° until ${untilText}${state.wish !== undefined ? " (renewed)" : ""}${endsWaiver ? "; the waiver ends" : ""}`,
    events: [
      ...(endsWaiver ? [{ tag: "WaiverEnded" as const, reason: "a wish", by }] : []),
      { tag: "Wished", by, target, until, untilText, before, at: ctx.now },
    ],
    actions: [notify(text), ...actions],
    timers: [
      setTimer(WISH, until),
      ...(ctx.timer(EVAL) !== undefined ? [cancelTimer(EVAL)] : []),
      ...(ctx.timer(WAIVER) !== undefined ? [cancelTimer(WAIVER)] : []),
      ...(ctx.timer(WISH_CHECK) !== undefined ? [cancelTimer(WISH_CHECK)] : []),
    ],
  };
}

/** While a wish runs: the unit heats at its setpoint; switched off or to another mode, the wish ends. */
function holdWish(state: GuardState, wish: Wish, input: Input, ctx: DecideCtx<ClimateGuardParams>): GuardDecision | undefined {
  const p = ctx.params;
  // The unit's reports say how it stands; a call's outcome comes before them.
  if (input.kind !== "signal" && input.kind !== "start" && input.kind !== "timer") return undefined;
  const unit = ctx.get(p.climate);
  if (unit === undefined || unit.state === "unavailable" || unit.state === "unknown") {
    return input.kind === "start" ? { why: `wish for ${p.climate} until ${wish.untilText}: the unit gives no state, waiting` } : undefined;
  }
  const graceMs = (p.graceSec ?? 300) * 1000;
  const recent = ctx.now - wish.sentAt < graceMs;
  if (unit.state !== "heat") {
    // A cloud unit's late report of the state before the switch is not someone switching it.
    if (recent && input.kind === "signal") return later(wish, ctx, `${p.climate} reports ${unit.state} within ${p.graceSec ?? 300} s of the wish's send: looked at again then`);
    const who = input.kind === "signal" ? (input.user !== undefined ? `user ${input.user}` : "the device") : "someone";
    return endWish(state, ctx, `the unit was switched ${unit.state} by ${who}`, { stopped: unit.state });
  }
  const setpoint = unit.attributes["temperature"];
  if (setpoint === wish.target) return input.kind === "start" ? { why: `wish holds: ${p.climate} heats at ${wish.target}° until ${wish.untilText}` } : undefined;
  // A person's change through HA becomes the wish's.
  if (input.kind === "signal" && input.entity === p.climate && input.user !== undefined && typeof setpoint === "number") {
    return { why: `user ${input.user} set ${setpoint}° on ${p.climate}: the wish heats at that until ${wish.untilText}`, events: [{ tag: "WishHeld", target: setpoint, at: ctx.now }] };
  }
  if (recent) return later(wish, ctx, `${p.climate} reports ${String(setpoint)}° within ${p.graceSec ?? 300} s of the last send: looked at again then`);
  return {
    why: `${p.climate} drifted to ${String(setpoint)}°: set back to the wish's ${wish.target}°`,
    events: [{ tag: "WishHeld", target: wish.target, at: ctx.now }],
    actions: [call("climate.set_temperature", p.climate, { temperature: wish.target })],
  };
}

/** Looked at again once graceSec has passed since the last send. */
function later(wish: Wish, ctx: DecideCtx<ClimateGuardParams>, why: string): GuardDecision | undefined {
  const at = wish.sentAt + (ctx.params.graceSec ?? 300) * 1000;
  if (ctx.timer(WISH_CHECK) === at) return undefined;
  return { why, timers: [setTimer(WISH_CHECK, at)] };
}

/**
 * The wish is over. Ended by the clock or by a command, the unit goes back to how it was:
 * another mode (off, cooling) comes back; heating, the guard takes it over as at a start,
 * and where the guard holds no heating setpoint, the one it had before comes back. Ended
 * by someone switching the unit (stopped), it stays as they left it.
 */
function endWish(state: GuardState, ctx: DecideCtx<ClimateGuardParams>, reason: string, o: { by?: string; firing?: boolean; reply?: boolean; stopped?: string } = {}): GuardDecision {
  const p = ctx.params;
  const wish = state.wish!;
  const room = p.warm?.room ?? p.climate;
  const t = textsOf(p);
  const unit = ctx.get(p.climate);
  const back: Action[] = [];
  let d: Decision<RuleEvent> | undefined;
  if (o.stopped === undefined && unit !== undefined && unit.state === "heat") {
    const { mode, temperature } = wish.before;
    const own = p.setpoints[mode as "heat" | "cool"];
    if (mode !== "heat") {
      back.push(call("climate.set_hvac_mode", p.climate, { hvac_mode: mode }));
      if (mode !== "off" && own === undefined && temperature !== undefined) back.push(call("climate.set_temperature", p.climate, { temperature }));
    } else {
      if (own === undefined && temperature !== undefined && unit.attributes["temperature"] !== temperature) back.push(call("climate.set_temperature", p.climate, { temperature }));
      d = takeOver(state, ctx);
    }
  }
  const text = o.stopped !== undefined ? fill(t.wishStopped, { room, mode: o.stopped }) : fill(t.wishEnded, { room });
  return {
    why: `wish for ${room} ${reason}${back.length > 0 ? `: back to ${wish.before.mode}${wish.before.temperature !== undefined ? ` at ${wish.before.temperature}°` : ""}` : ""}${d?.why !== undefined ? ` · ${d.why}` : ""}`,
    events: [{ tag: "WishEnded", reason, ...(o.by !== undefined ? { by: o.by } : {}) }, ...(d?.events ?? [])],
    // A reply to whoever ended it; otherwise a report.
    actions: [notify(text, o.reply === true ? {} : { info: true }), ...back, ...(d?.actions ?? [])],
    timers: [
      ...(!o.firing && ctx.timer(WISH) !== undefined ? [cancelTimer(WISH)] : []),
      ...(ctx.timer(WISH_CHECK) !== undefined ? [cancelTimer(WISH_CHECK)] : []),
      ...(d?.timers ?? []),
    ],
  };
}

export default climateGuard;
