// relay-pulse — the momentary pattern: latching relays that drive momentary inputs
// (e.g. a door opener's step button). Whenever one turns on, whoever turned it on,
// release it after a short press, and again if it is still on a few seconds later.
// It shares the relays: other instances (garage-door) press them by turning them on.

import { call, defineHeuristic, param, setTimer, type Infer } from "teobeanie";

const RELAY_PULSE_PARAMS = param.object({
  relays: param.entities("switch").doc("The latching relays, each driving a momentary input."),
  pressMs: param.duration("ms").doc("How long a press lasts: the relay is released this long after it turns on."),
  recheckMs: param.duration("ms").doc("Released again if it is still on this long after the release."),
});

export type RelayPulseParams = Infer<typeof RELAY_PULSE_PARAMS>;

type Event = { tag: "Released"; relay: string; retry: boolean };

export const relayPulse = defineHeuristic<RelayPulseParams, Record<string, never>, Event>({
  id: "relay-pulse",
  pattern: "momentary",
  title: "Momentary relay",
  description: "Turns a relay back off shortly after it turns on, so a latching relay acts as a button press.",
  guarantees:
    "A relay that turns on is released after the press, whoever turned it on, and once more if it is still on a few seconds later.",
  params: RELAY_PULSE_PARAMS,
  watch: (p) => p.relays,
  actuates: (p) => p.relays,
  shares: (p) => p.relays,
  initial: () => ({}),

  decide(_state, input, ctx) {
    const p = ctx.params;
    switch (input.kind) {
      case "signal":
        if (input.value !== true) return undefined;
        return { why: `${input.entity} pressed`, timers: [setTimer(`release:${input.entity}`, ctx.now + p.pressMs, input.entity)] };
      case "start": {
        const stuck = p.relays.filter((r) => ctx.value(r) === true && ctx.timer(`release:${r}`) === undefined);
        if (stuck.length === 0) return undefined;
        return { why: `${stuck.join(", ")} on at start`, timers: stuck.map((r) => setTimer(`release:${r}`, ctx.now, r)) };
      }
      case "timer": {
        const relay = String(input.data);
        const retry = input.timer.startsWith("recheck:");
        if (ctx.value(relay) !== true) return retry ? undefined : { why: `${relay} already released` };
        return {
          why: retry ? `${relay} still on ${p.recheckMs / 1000} s after release` : `release ${relay} after ${p.pressMs} ms`,
          events: [{ tag: "Released", relay, retry }],
          actions: [call("switch.turn_off", relay)],
          timers: retry ? [] : [setTimer(`recheck:${relay}`, ctx.now + p.recheckMs, relay)],
        };
      }
      default:
        return undefined;
    }
  },

  evolve: (state) => state,
});

export default relayPulse;
