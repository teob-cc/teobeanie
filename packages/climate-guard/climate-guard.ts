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

import { cancelTimer, EVAL, fill, hours, houseZone, keep, localMinutes, minutes, notify, param, release, rule, setTimer, type DecideCtx, type Decision, type HeuristicDef, type Infer, type Input, type RuleEvent, type RuleState } from "teobeanie";

/** The messages of a climate-guard waiver; {slots} are filled in. */
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
}

export const CLIMATE_GUARD_TEXTS: ClimateGuardTexts = {
  waived: "Climate guard lifted for {room} until {until}.",
  resumed: "Climate guard is back on for {room}.",
  notWaived: "The climate guard is on for {room}, nothing to end.",
  pick: "Which room? {rooms} (add off to end it early).",
  unknownRoom: 'No room "{room}". Rooms: {rooms}.',
  usage: "/{command} {room} lifts the climate guard there for {hours} h; /{command} {room} off ends it.",
};

const CLIMATE_GUARD_PARAMS = param.object({
  climate: param.entity("climate").doc("The climate entity."),
  setpoints: param
    .object({ heat: param.number({ unit: "°" }).optional(), cool: param.number({ unit: "°" }).optional() })
    .doc("Setpoint while running, per mode."),
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
  texts: param
    .texts(CLIMATE_GUARD_TEXTS, {
      waived: "{room}; {until}: house-local HH:MM.",
      resumed: "{room}: the waiver ran out, or was ended early.",
      notWaived: '{room}: "off" with no waiver running.',
      pick: "{rooms}: the command for each room.",
      unknownRoom: "{room}: what was asked; {rooms}: as in pick.",
      usage: '{command}, {room}, {hours}: something after the room other than "off".',
    })
    .doc("Override any of the waiver's messages (the English defaults stay for the rest)."),
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
    description: "Setpoints per mode, a longest run, and a start below or above a room temperature; a command lifts it for a room for a while.",
    guarantees:
      "A setpoint a person sets through Home Assistant stands until the next run; no run lasts longer than the longest run; a cloud unit's late report of an old run is not a new run; while a room's waiver runs, the unit is left alone.",
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

// ---- the waiver ----

interface Waiver {
  by: string;
  until: number;
}

/** The rule's state, and the waiver while one runs. */
type GuardState = RuleState & { waiver?: Waiver };

type WaiverEvent = { tag: "Waived"; by: string; until: number } | { tag: "WaiverEnded"; reason: string; by?: string };
type GuardDecision = Decision<RuleEvent | WaiverEvent>;

const WAIVER = "waiver";
const textsOf = (p: ClimateGuardParams): ClimateGuardTexts => ({ ...CLIMATE_GUARD_TEXTS, ...p.texts });

/** House-local HH:MM. */
function clock(at: number, ctx: DecideCtx<unknown>): string {
  const m = localMinutes(at, houseZone(ctx.house));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const climateGuard: HeuristicDef<ClimateGuardParams, GuardState, RuleEvent | WaiverEvent> = {
  ...guard,
  // Another instance may switch the unit on and off (a heating heuristic of the house's own); the guard's setpoint and longest run still apply.
  shares: (p) => [p.climate],
  commands: (p) => (p.waive !== undefined ? [p.waive.command] : []),
  commandArg: (p) => (p.waive !== undefined ? { [p.waive.command]: p.waive.room } : {}),
  commandHelp: (p) => (p.waive !== undefined ? { [p.waive.command]: "Lift the climate guard in a room for a while" } : {}),
  // A chat keyboard offers the room, and ending its waiver while one runs.
  commandButtons: (p, s) => (p.waive !== undefined ? { [p.waive.command]: [p.waive.room, ...(s.waiver !== undefined ? [`${p.waive.room} off`] : [])] } : {}),

  decide(state, input, ctx) {
    const p = ctx.params;
    if (input.kind === "command") return p.waive !== undefined && input.command === p.waive.command ? command(state, input, ctx) : undefined;
    const w = state.waiver;
    if (w === undefined) return input.kind === "timer" && input.timer === WAIVER ? undefined : guard.decide(state, input, ctx);
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
      case "WaiverEnded":
        // The guard starts over: what it wanted before the waiver, and its run tracking, are gone.
        return { desired: {}, track: {}, unwatched: state.unwatched ?? [] };
      default: {
        const next = guard.evolve(state, event) as GuardState;
        return state.waiver !== undefined ? { ...next, waiver: state.waiver } : next;
      }
    }
  },
};

function command(state: GuardState, input: Extract<Input, { kind: "command" }>, ctx: DecideCtx<ClimateGuardParams>): GuardDecision | undefined {
  const p = ctx.params;
  const w = p.waive!;
  const t = textsOf(p);
  const by = input.from.user ?? input.from.channel;
  const reply = (text: string, extra: GuardDecision = {}): GuardDecision => ({ why: `${input.command} by ${by}: ${text}`, actions: [notify(text)], ...extra });
  const [asked, sub] = input.args;
  if (asked === undefined || asked.toLowerCase() !== w.room.toLowerCase()) {
    // Another instance's room: silent. No room, or one nobody answers for: one reply,
    // from the instance first in the list.
    const choices = input.choices ?? [w.room];
    if (asked !== undefined && choices.some((c) => c.toLowerCase() === asked.toLowerCase())) return undefined;
    if (choices[0] !== w.room) return undefined;
    const rooms = choices.map((c) => `/${w.command} ${c}`).join(", ");
    return reply(asked === undefined ? fill(t.pick, { rooms }) : fill(t.unknownRoom, { room: asked, rooms }));
  }
  const hrs = w.hours ?? 3;
  if (sub !== undefined && sub.toLowerCase() !== "off") return reply(fill(t.usage, { command: w.command, room: w.room, hours: hrs }));
  if (sub !== undefined) {
    if (state.waiver === undefined) return reply(fill(t.notWaived, { room: w.room }));
    return resume(state, ctx, `ended early by ${by}`, { by });
  }
  // A new waiver, or a running one renewed from now.
  const until = ctx.now + hours(hrs);
  return reply(fill(t.waived, { room: w.room, until: clock(until, ctx) }), {
    why: `${input.command} by ${by}: guard waived for ${w.room} until ${clock(until, ctx)}, ${p.climate} left alone`,
    events: [{ tag: "Waived", by, until }],
    timers: [setTimer(WAIVER, until), ...(ctx.timer(EVAL) !== undefined ? [cancelTimer(EVAL)] : [])],
  });
}

/**
 * The waiver is over: the guard takes the unit over as it finds it, as at a start. A
 * run under way counts from now (its setpoint set back), not from when it began.
 */
function resume(state: GuardState, ctx: DecideCtx<ClimateGuardParams>, reason: string, o: { by?: string; firing?: boolean } = {}): GuardDecision {
  const p = ctx.params;
  const room = p.waive?.room ?? p.climate;
  const fresh: DecideCtx<ClimateGuardParams> = {
    ...ctx,
    get: (e) => {
      const seen = ctx.get(e);
      return e === p.climate && seen !== undefined ? { ...seen, since: ctx.now } : seen;
    },
  };
  const d = guard.decide({ desired: {}, track: {}, unwatched: state.unwatched ?? [] }, { kind: "start", at: ctx.now }, fresh) as Decision<RuleEvent> | undefined;
  return {
    why: `waiver for ${room} ${reason}, guard back on${d?.why !== undefined ? ` · ${d.why}` : ""}`,
    events: [{ tag: "WaiverEnded", reason, ...(o.by !== undefined ? { by: o.by } : {}) }, ...(d?.events ?? [])],
    actions: [notify(fill(textsOf(p).resumed, { room }), { info: true }), ...(d?.actions ?? [])],
    timers: [...(!o.firing && ctx.timer(WAIVER) !== undefined ? [cancelTimer(WAIVER)] : []), ...(d?.timers ?? [])],
  };
}

export default climateGuard;
