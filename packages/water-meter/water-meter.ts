// water-meter — notices from a pulse water meter: water that keeps running at night
// (a leak), and a hot-water use (a shower) summed up with its gas and what it cost.
//
// Both read a meter total in litres that only ever counts up. Neither journals a
// reading: a use is journaled when it starts and ends, and its litres are the
// difference of the totals. Each reading re-arms a quiet timer, so the use is over
// when that timer fires. The meter's last_changed is no sign of water: a meter that
// writes the same total again (force_update) moves it every few seconds. A total that
// jumps (the meter's value set by hand) is a counter correction, never water used.

import { cancelTimer, defineHeuristic, fill, houseZone, localMinutes, minutes, notify, param, parseHhMm, setTimer, type Infer } from "teobeanie";

const MAX_STEP_L = 100;

const fixed = (n: number, digits: number): string => n.toFixed(digits);

// ---- night-leak: the meter keeps counting through the night ----

const NIGHT_LEAK_TEXT = "Water keeps running at night: {litres} L in {minutes} min ({rate} L/h). A leaking tap or toilet?";

const NIGHT_LEAK_PARAMS = param.object({
  meter: param.entity("sensor").doc("The water meter's total in litres."),
  from: param.time().default("00:30").doc("The night starts (house time)."),
  to: param.time().default("05:30").doc("The night ends."),
  persistMin: param.duration("min", { positive: true }).default(60).doc("Water counted this long without a break is a leak."),
  gapMin: param.duration("min", { positive: true }).default(15).doc("A break this long ends a run: a flush or a glass of water stops there."),
  maxLitres: param.number({ unit: "L", positive: true }).default(1000).doc("More in one run is a counter correction, not water used."),
  text: param.text().default(NIGHT_LEAK_TEXT).doc("The notice; {litres}, {minutes} and {rate} (L/h) are filled in."),
});

export type NightLeakParams = Infer<typeof NIGHT_LEAK_PARAMS>;

type NightLeakEvent =
  | { tag: "RunStarted"; at: number; startL: number }
  | { tag: "LeakSuspected"; litres: number; minutes: number }
  | { tag: "RunEnded"; litres: number; minutes: number };

interface NightLeakState {
  run: { at: number; startL: number; alerted: boolean } | null;
}

const GAP = "gap";

const inWindow = (at: number, from: string, to: string, timeZone: string): boolean => {
  const m = localMinutes(at, timeZone);
  const f = parseHhMm(from);
  const t = parseHhMm(to);
  return f <= t ? m >= f && m < t : m >= f || m < t;
};

export const nightLeak = defineHeuristic<NightLeakParams, NightLeakState, NightLeakEvent>({
  id: "night-leak",
  pattern: "notice",
  title: "Water running at night",
  description: "Tells the household when the water meter keeps counting through the night, a little at a time: a dripping tap, a running toilet.",
  guarantees:
    "Only tells people, never closes anything; one notice per run of water, however long it lasts.",
  params: NIGHT_LEAK_PARAMS,
  watch: (p) => [p.meter],
  actuates: () => [],
  initial: () => ({ run: null }),

  decide(state, input, ctx) {
    const p = ctx.params;
    const from = p.from ?? "00:30";
    const to = p.to ?? "05:30";
    const persist = minutes(p.persistMin ?? 60);
    const gap = minutes(p.gapMin ?? 15);
    const night = inWindow(ctx.now, from, to, houseZone(ctx.house));
    const total = ctx.value(p.meter);
    switch (input.kind) {
      case "signal": {
        if (!night || typeof input.value !== "number") return undefined;
        const v = input.value;
        const run = state.run;
        if (run === null || v - run.startL > (p.maxLitres ?? 1000) || v < run.startL) {
          return {
            why: run === null ? `${p.meter} counting at night` : `${p.meter} jumped to ${v} L: a counter correction, counting from here`,
            events: [{ tag: "RunStarted", at: ctx.now, startL: v }],
            timers: [setTimer(GAP, ctx.now + gap)],
          };
        }
        // Still counting: the break starts again from this reading.
        const rearm = setTimer(GAP, ctx.now + gap);
        if (run.alerted || ctx.now - run.at < persist) return { timers: [rearm] };
        const litres = v - run.startL;
        const min = Math.round((ctx.now - run.at) / 60_000);
        const rate = fixed(litres / ((ctx.now - run.at) / 3_600_000), 1);
        return {
          why: `${p.meter} counting for ${min} min without a ${p.gapMin ?? 15} min break`,
          events: [{ tag: "LeakSuspected", litres, minutes: min }],
          actions: [notify(fill(p.text ?? NIGHT_LEAK_TEXT, { litres, minutes: min, rate }))],
          timers: [rearm],
        };
      }
      case "timer": {
        const run = state.run;
        if (run === null) return undefined;
        // The timer is set gapMin after the last reading: it fires once the meter has stopped.
        const last = Math.max(run.at, ctx.now - gap);
        const litres = typeof total === "number" ? Math.max(0, total - run.startL) : 0;
        const min = Math.round((last - run.at) / 60_000);
        return {
          why: night ? `${p.meter} quiet for ${p.gapMin ?? 15} min` : "the night is over",
          events: [{ tag: "RunEnded", litres, minutes: Math.max(0, min) }],
        };
      }
      case "start":
        // A run left from before a restart without its timer: let the timer decide.
        return state.run !== null && ctx.timer(GAP) === undefined ? { why: "run in progress at start", timers: [setTimer(GAP, ctx.now)] } : undefined;
      default:
        return undefined;
    }
  },

  evolve(state, event) {
    switch (event.tag) {
      case "RunStarted":
        return { run: { at: event.at, startL: event.startL, alerted: false } };
      case "LeakSuspected":
        return state.run === null ? state : { run: { ...state.run, alerted: true } };
      case "RunEnded":
        return { run: null };
    }
  },
});

// ---- shower-summary: a hot-water use, its gas and its cost ----

const SHOWER_TEXT =
  "Shower over: {litres} L water and {gas} m³ gas in {minutes} min, €{cost} " +
  "(water €{waterCost} at €{waterPrice}/m³, gas €{gasCost} at €{gasPrice}/m³)";

const SHOWER_PARAMS = param.object({
  water: param.entity("sensor").doc("The water meter's total in litres."),
  gas: param.entity("sensor").doc("The gas meter's total in m³."),
  hotWater: param
    .entity("binary_sensor")
    .optional()
    .doc("On while the boiler heats tap water. Given: a use is hot only if it came on. Without: a use is hot when the gas meter moved by minGasM3."),
  minLitres: param.number({ unit: "L", positive: true }).default(30).doc("A use smaller than this is a tap, not a shower."),
  maxLitres: param.number({ unit: "L", positive: true }).default(1000).doc("A use larger than this is a counter correction, not water used."),
  minGasM3: param.number({ unit: "m³", min: 0 }).default(0.05).doc("Without hotWater: the gas a hot use takes at least."),
  quietMin: param.duration("min", { positive: true }).default(2).doc("The use is over once the meter has been still this long."),
  maxMin: param.duration("min", { positive: true }).default(60).doc("A use longer than this is no shower: a garden hose, a leak."),
  gasWaitMin: param.duration("min", { positive: true }).default(6).doc("How long to wait for the gas meter's next reading (a smart meter reports every 5 min)."),
  waterPricePerM3: param.number({ unit: "€/m³", min: 0 }).optional().doc("What a m³ of water costs, all in."),
  gasPrice: param.entity("sensor", "input_number").optional().doc("The gas price now, in €/m³."),
  gasPricePerM3: param.number({ unit: "€/m³", min: 0 }).optional().doc("What a m³ of gas costs, when gasPrice is not given or not available."),
  text: param
    .text()
    .default(SHOWER_TEXT)
    .doc("The summary; {litres}, {gas}, {minutes}, {cost}, {waterCost}, {gasCost}, {waterPrice} and {gasPrice} are filled in (? when unknown)."),
});

export type ShowerSummaryParams = Infer<typeof SHOWER_PARAMS>;

interface Use {
  at: number;
  startL: number;
  gasStart: number | null;
  hot: boolean;
}

interface Ended extends Use {
  endedAt: number;
  litres: number;
}

type ShowerEvent =
  | { tag: "UseStarted"; at: number; startL: number; gasStart: number | null; hot: boolean }
  | { tag: "HotWater" }
  | { tag: "UseEnded"; at: number; endL: number; litres: number; waitGas: boolean }
  | { tag: "ShowerReported"; litres: number; gasM3: number | null; cost: number | null }
  | { tag: "UseSettled"; reason: string }
  /** The total at start, where the first use counts from. */
  | { tag: "Baseline"; l: number };

interface ShowerState {
  use: Use | null;
  /** Ended, waiting for the gas meter's next reading. */
  ended: Ended | null;
  /** The total when the last use ended: where the next one starts. */
  lastL: number | null;
}

const QUIET = "quiet";
const GAS = "gas";

export const showerSummary = defineHeuristic<ShowerSummaryParams, ShowerState, ShowerEvent>({
  id: "shower-summary",
  pattern: "notice",
  title: "Shower summary",
  description:
    "When a large use of hot water (a shower, a bath) is over, tells the household the water and gas it took and what they cost.",
  guarantees: "Only tells people, never switches anything; one message per hot-water use, after it is over.",
  params: SHOWER_PARAMS,
  watch: (p) => [p.water, p.gas, ...(p.hotWater ? [p.hotWater] : [])],
  reads: (p) => (p.gasPrice ? [p.gasPrice] : []),
  actuates: () => [],
  initial: () => ({ use: null, ended: null, lastL: null }),

  decide(state, input, ctx) {
    const p = ctx.params;
    const num = (e: string): number | null => {
      const v = ctx.value(e);
      return typeof v === "number" ? v : null;
    };

    // The summary of an ended use, from the gas meter as it reads now.
    const settle = (ended: Ended): { why: string; events: ShowerEvent[]; actions: ReturnType<typeof notify>[] } => {
      const gasNow = num(p.gas);
      const gasM3 = ended.gasStart !== null && gasNow !== null ? Math.max(0, gasNow - ended.gasStart) : null;
      const hot = p.hotWater ? ended.hot : gasM3 !== null && gasM3 >= (p.minGasM3 ?? 0.05);
      if (!hot) {
        const reason = p.hotWater ? `no hot water during ${ended.litres} L` : `${gasM3 ?? "?"} m³ gas with ${ended.litres} L: cold water`;
        return { why: reason, events: [{ tag: "UseSettled", reason }], actions: [] };
      }
      const gasPrice = (p.gasPrice ? num(p.gasPrice) : null) ?? p.gasPricePerM3 ?? null;
      const waterCost = p.waterPricePerM3 !== undefined ? (ended.litres / 1000) * p.waterPricePerM3 : null;
      const gasCost = gasPrice !== null && gasM3 !== null ? gasM3 * gasPrice : null;
      const cost = waterCost !== null && gasCost !== null ? waterCost + gasCost : null;
      const or = (n: number | null, digits: number): string => (n === null ? "?" : fixed(n, digits));
      const text = fill(p.text ?? SHOWER_TEXT, {
        litres: ended.litres,
        gas: or(gasM3, 3),
        minutes: Math.max(1, Math.round((ended.endedAt - ended.at) / 60_000)),
        cost: or(cost, 2),
        waterCost: or(waterCost, 2),
        gasCost: or(gasCost, 2),
        waterPrice: or(p.waterPricePerM3 ?? null, 2),
        gasPrice: or(gasPrice, 2),
      });
      return {
        why: `${ended.litres} L of hot water, ${gasM3 ?? "?"} m³ gas`,
        events: [{ tag: "ShowerReported", litres: ended.litres, gasM3, cost }],
        actions: [notify(text, { info: true })],
      };
    };

    switch (input.kind) {
      case "signal": {
        if (input.entity === p.water) {
          if (typeof input.value !== "number") return undefined;
          // Still counting: the quiet starts again from this reading.
          if (state.use !== null) return { timers: [setTimer(QUIET, ctx.now + minutes(p.quietMin ?? 2))] };
          const v = input.value;
          const step = state.lastL === null ? null : v - state.lastL;
          const startL = step !== null && step >= 0 && step <= MAX_STEP_L ? state.lastL! : v;
          const started: ShowerEvent = { tag: "UseStarted", at: ctx.now, startL, gasStart: num(p.gas), hot: p.hotWater ? ctx.value(p.hotWater) === true : false };
          // A new use while the last one waits for its gas: the last one is settled first.
          const before = state.ended !== null ? settle(state.ended) : null;
          return {
            why: `${p.water} counting${before ? `; ${before.why}` : ""}`,
            events: [...(before?.events ?? []), started],
            actions: before?.actions ?? [],
            timers: [...(before ? [cancelTimer(GAS)] : []), setTimer(QUIET, ctx.now + minutes(p.quietMin ?? 2))],
          };
        }
        if (p.hotWater && input.entity === p.hotWater) {
          return input.value === true && state.use !== null && !state.use.hot
            ? { why: `${p.hotWater} on during the use`, events: [{ tag: "HotWater" }] }
            : undefined;
        }
        if (input.entity === p.gas && state.ended !== null) {
          return { ...settle(state.ended), timers: [cancelTimer(GAS)] };
        }
        return undefined;
      }
      case "timer": {
        if (input.timer === GAS) return state.ended !== null ? settle(state.ended) : undefined;
        const use = state.use;
        if (input.timer !== QUIET || use === null) return undefined;
        // The timer is set quietMin after the last reading: it fires once the meter has stopped.
        const last = Math.max(use.at, ctx.now - minutes(p.quietMin ?? 2));
        const meter = ctx.get(p.water);
        const endL = typeof meter?.value === "number" ? meter.value : use.startL;
        const litres = Math.max(0, endL - use.startL);
        const ended: Ended = { ...use, endedAt: last, litres };
        const small = litres < (p.minLitres ?? 30);
        const correction = litres > (p.maxLitres ?? 1000);
        const long = last - use.at > minutes(p.maxMin ?? 60);
        if (small || correction || long) {
          const reason = small
            ? `${litres} L: a small use`
            : correction
              ? `${litres} L: a counter correction`
              : `${litres} L over ${Math.round((last - use.at) / 60_000)} min: too long for a shower`;
          return { why: reason, events: [{ tag: "UseEnded", at: ended.endedAt, endL, litres, waitGas: false }, { tag: "UseSettled", reason }] };
        }
        // The gas meter reports every few minutes: a reading after the water stopped has all of the use's gas.
        const gasSince = ctx.get(p.gas)?.since ?? 0;
        if (gasSince > last) {
          const done = settle(ended);
          return { ...done, events: [{ tag: "UseEnded", at: ended.endedAt, endL, litres, waitGas: false }, ...done.events] };
        }
        return {
          why: `${litres} L used, waiting for the gas meter`,
          events: [{ tag: "UseEnded", at: ended.endedAt, endL, litres, waitGas: true }],
          timers: [setTimer(GAS, ctx.now + minutes(p.gasWaitMin ?? 6))],
        };
      }
      case "start": {
        const v = num(p.water);
        return state.lastL === null && state.use === null && v !== null
          ? { why: `${p.water} reads ${v} L at start`, events: [{ tag: "Baseline", l: v }] }
          : undefined;
      }
      default:
        return undefined;
    }
  },

  evolve(state, event) {
    switch (event.tag) {
      case "Baseline":
        return { ...state, lastL: event.l };
      case "UseStarted":
        return { ...state, use: { at: event.at, startL: event.startL, gasStart: event.gasStart, hot: event.hot } };
      case "HotWater":
        return state.use === null ? state : { ...state, use: { ...state.use, hot: true } };
      case "UseEnded":
        return {
          use: null,
          ended: event.waitGas && state.use !== null ? { ...state.use, endedAt: event.at, litres: event.litres } : null,
          lastL: event.endL,
        };
      case "ShowerReported":
      case "UseSettled":
        return { ...state, ended: null };
    }
  },
});

export default [nightLeak, showerSummary];
