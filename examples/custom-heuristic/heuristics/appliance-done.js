// appliance-done — "the washing machine is done": a power sensor rises above
// `runningAbove` W (a cycle started), then stays below `idleBelow` W for `quietMin`
// minutes (the cycle ended) → one notification.
//
// A custom heuristic is plain JavaScript in the config folder's heuristics/ directory.
// The default export receives the toolkit, so no imports are needed. The shape is the
// same as the packages' (see docs/heuristics.md): decide() is pure and returns data,
// evolve() folds this heuristic's own events into its state.

export default ({ defineHeuristic, notify, setTimer, cancelTimer, minutes }) =>
  defineHeuristic({
    id: "appliance-done",
    title: "Appliance cycle done",
    description: "Notify once when an appliance's power draw shows a finished cycle.",
    watch: (p) => [p.power],
    actuates: () => [],
    notifyPerHour: 6,
    initial: () => ({ running: false, startedAt: null }),

    decide(state, input, ctx) {
      const p = ctx.params;
      if (input.kind === "signal" && typeof input.value === "number") {
        const watts = input.value;
        if (!state.running && watts > p.runningAbove) {
          return { why: `${watts} W > ${p.runningAbove} W: cycle started`, events: [{ tag: "CycleStarted", at: ctx.now }] };
        }
        if (state.running && watts < p.idleBelow && ctx.timer("quiet") === undefined) {
          return { why: `${watts} W, done if it stays quiet ${p.quietMin} min`, timers: [setTimer("quiet", ctx.now + minutes(p.quietMin))] };
        }
        if (state.running && watts >= p.idleBelow && ctx.timer("quiet") !== undefined) {
          return { why: `${watts} W: still running`, timers: [cancelTimer("quiet")] };
        }
        return undefined;
      }
      if (input.kind === "timer" && state.running) {
        const tookMin = Math.round((ctx.now - state.startedAt) / 60_000);
        return {
          why: `quiet for ${p.quietMin} min after a ${tookMin} min cycle`,
          events: [{ tag: "CycleDone", tookMin }],
          actions: [notify(p.text)],
        };
      }
      return undefined;
    },

    evolve(state, event) {
      if (event.tag === "CycleStarted") return { running: true, startedAt: event.at };
      if (event.tag === "CycleDone") return { running: false, startedAt: null };
      return state;
    },
  });
