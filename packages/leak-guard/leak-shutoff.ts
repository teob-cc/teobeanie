// leak-shutoff — closing the valve is automatic; reopening it is never
// automated: the heuristic forbids it in the SafeActuator for every instance.

import { call, defineHeuristic, notify, param, type Infer } from "teobeanie";

const FORBID_REASON = "reopening the water valve after a leak is human-only";

const LEAK_SHUTOFF_PARAMS = param.object({
  sensors: param.entities().doc("Leak sensors: any of them wet closes the valve."),
  valve: param.entity("valve", "switch").doc("The main water valve (a valve, or a switch that is on while open)."),
  text: param.text().doc("The alert; the wet sensor is appended."),
  forbidReason: param.text().default(FORBID_REASON).doc("Why reopening the valve is refused."),
});

export type LeakShutoffParams = Infer<typeof LEAK_SHUTOFF_PARAMS>;

type Event = { tag: "LeakDetected"; sensor: string } | { tag: "LeakCleared"; sensor: string };

interface State {
  wet: string[];
}

export const leakShutoff = defineHeuristic<LeakShutoffParams, State, Event>({
  id: "leak-shutoff",
  pattern: "guard",
  title: "Water leak shutoff",
  description: "Any leak sensor going wet closes the main water valve and alerts the household. Reopening stays manual.",
  guarantees:
    "Any leak closes the valve and tells the household. Reopening is never automatic: it is refused for every instance, whatever the rest of the configuration says.",
  params: LEAK_SHUTOFF_PARAMS,
  watch: (p) => p.sensors,
  reads: (p) => [p.valve],
  actuates: (p) => [p.valve],
  forbids: (p) => {
    const reason = p.forbidReason ?? FORBID_REASON;
    return [
      { entity: p.valve, service: `${p.valve.split(".")[0]}.turn_on`, reason },
      { entity: p.valve, service: "valve.open_valve", reason },
    ];
  },
  initial: () => ({ wet: [] }),

  decide(state, input, ctx) {
    const p = ctx.params;
    const shut = (sensor: string, why: string) => ({
      why,
      events: state.wet.includes(sensor) ? [] : [{ tag: "LeakDetected" as const, sensor }],
      // Always send the close, even if the valve already reads closed: it is idempotent and the state may lie.
      actions: [call(p.valve.startsWith("valve.") ? "valve.close_valve" : "switch.turn_off", p.valve), notify(`${p.text} ${sensor}`)],
    });
    switch (input.kind) {
      case "signal":
        if (input.value === true) return shut(input.entity, `${input.entity} reports water`);
        if (input.value === false && state.wet.includes(input.entity)) {
          return { why: `${input.entity} dry again (valve stays closed)`, events: [{ tag: "LeakCleared", sensor: input.entity }] };
        }
        return undefined;
      case "start": {
        const wet = p.sensors.find((s) => ctx.value(s) === true && !state.wet.includes(s));
        return wet === undefined ? undefined : shut(wet, `${wet} wet at start`);
      }
      default:
        return undefined;
    }
  },

  evolve(state, event) {
    return event.tag === "LeakDetected"
      ? { wet: [...state.wet, event.sensor] }
      : { wet: state.wet.filter((s) => s !== event.sensor) };
  },
});

export default leakShutoff;
