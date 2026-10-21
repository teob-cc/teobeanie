// appliance-auto-off — switch an appliance off once a room has been empty for a while,
// except inside a keep-on window (a room still empty when the window ends switches it
// off then); optional switch-on at a fixed time.

import { call, cancelTimer, defineHeuristic, heldSince, houseZone, localMinutes, minutes, param, parseHhMm, setTimer, type Infer } from "teobeanie";

const APPLIANCE_PARAMS = param.object({
  occupancy: param.entity().doc("The room's occupancy: on = someone there."),
  appliance: param.entity().doc("Switched off once the room has been empty for vacantMin."),
  vacantMin: param.duration("min").doc("Minutes the room must have been empty."),
  keepOn: param.object({ from: param.time(), to: param.time() }).optional().doc('Local "HH:MM" window during which vacancy does not switch the appliance off.'),
  onAt: param.time({ seconds: true }).optional().doc('Local "HH:MM:SS" daily switch-on (delivered as the "on-at" HA time trigger).'),
  timeZone: param.string().optional().doc("The keep-on window's zone; default the house's."),
});

export type ApplianceParams = Infer<typeof APPLIANCE_PARAMS>;

type Event = { tag: "SwitchedOff"; vacantMin: number } | { tag: "SwitchedOn"; at: string };

const VACANT = "vacant";

export const applianceAutoOff = defineHeuristic<ApplianceParams, Record<string, never>, Event>({
  id: "appliance-auto-off",
  pattern: "trigger",
  title: "Appliance auto-off",
  description: "An appliance goes off after its room has been empty for a while, outside a keep-on window.",
  guarantees:
    "Never switches off inside the keep-on window, and only after the room has been empty for the whole delay.",
  // The appliance too: switched on in an empty room (an app, a schedule) starts the run-on.
  params: APPLIANCE_PARAMS,
  watch: (p) => [p.occupancy, p.appliance],
  actuates: (p) => [p.appliance],
  // A remote or a schedule (button, hold) may switch it too; the auto-off still applies.
  shares: (p) => [p.appliance],
  triggers: (p): Record<string, Record<string, unknown>> => (p.onAt ? { "on-at": { platform: "time", at: p.onAt } } : {}),
  initial: () => ({}),

  decide(_state, input, ctx) {
    const p = ctx.params;
    const domain = p.appliance.split(".")[0];
    switch (input.kind) {
      case "signal":
        if (input.entity === p.appliance) {
          // Counted from the switch-on, not from when the room emptied: whoever switched it
          // on gets the whole run-on.
          if (input.value !== true || ctx.value(p.occupancy) !== false) return undefined;
          return { why: `${p.appliance} switched on in an empty room`, timers: [setTimer(VACANT, ctx.now + minutes(p.vacantMin))] };
        }
        if (input.value === false && ctx.timer(VACANT) === undefined) {
          return { why: `${p.occupancy} vacant`, timers: [setTimer(VACANT, ctx.now + minutes(p.vacantMin))] };
        }
        if (input.value === true && ctx.timer(VACANT) !== undefined) {
          return { why: `${p.occupancy} occupied again`, timers: [cancelTimer(VACANT)] };
        }
        return undefined;
      case "timer": {
        if (ctx.value(p.occupancy) === true) return { why: "occupied at the deadline" };
        if (ctx.value(p.appliance) === false) return { why: `room empty for ${p.vacantMin} min, ${p.appliance} already off` };
        if (p.keepOn) {
          const t = localMinutes(ctx.now, p.timeZone ?? houseZone(ctx.house));
          if (t >= parseHhMm(p.keepOn.from) && t < parseHhMm(p.keepOn.to)) {
            // Look again when the window ends: a room still empty then switches it off.
            const end = ctx.now - (ctx.now % 60_000) + minutes(parseHhMm(p.keepOn.to) - t);
            return { why: `inside the ${p.keepOn.from}–${p.keepOn.to} keep-on window, again at ${p.keepOn.to}`, timers: [setTimer(VACANT, end)] };
          }
        }
        return {
          why: `room empty for ${p.vacantMin} min`,
          events: [{ tag: "SwitchedOff", vacantMin: p.vacantMin }],
          actions: [call(`${domain}.turn_off`, p.appliance)],
        };
      }
      case "start": {
        if (ctx.value(p.occupancy) !== false || ctx.value(p.appliance) !== true || ctx.timer(VACANT) !== undefined) return undefined;
        const due = Math.max(ctx.now, heldSince(ctx, [p.occupancy]) + minutes(p.vacantMin));
        return { why: `${p.appliance} on in an empty room at start`, timers: [setTimer(VACANT, due)] };
      }
      case "trigger":
        if (input.trigger !== "on-at" || ctx.value(p.appliance) === true) return undefined;
        // Switched on in an empty room: no vacancy signal will come, so start the run-on now.
        const empty = ctx.value(p.occupancy) === false && ctx.timer(VACANT) === undefined;
        return {
          why: `scheduled switch-on at ${p.onAt}`,
          events: [{ tag: "SwitchedOn", at: p.onAt ?? "" }],
          actions: [call(`${domain}.turn_on`, p.appliance)],
          ...(empty ? { timers: [setTimer(VACANT, ctx.now + minutes(p.vacantMin))] } : {}),
        };
      default:
        return undefined;
    }
  },

  evolve: (state) => state,
});

export default applianceAutoOff;
