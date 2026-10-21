// sustained-notice — one message when an entity has been on for a while: someone
// lingering at a door. It only tells people; it never switches anything.

import { cancelTimer, defineHeuristic, minutes, notify, param, setTimer, type Infer } from "teobeanie";

const SUSTAINED_NOTICE_PARAMS = param.object({
  entity: param.entity().doc("Noticed once it has been on this long."),
  forMin: param.duration("min").doc("Minutes it must stay on."),
  text: param.text().doc("The message."),
});

export type SustainedNoticeParams = Infer<typeof SUSTAINED_NOTICE_PARAMS>;

type NoticeEvent = { tag: "Noticed" };

const SUSTAIN = "sustain";

export const sustainedNotice = defineHeuristic<SustainedNoticeParams, Record<string, never>, NoticeEvent>({
  id: "sustained-notice",
  pattern: "notice",
  title: "Sustained presence notice",
  description: "One message when an entity has been on for a while (someone lingering at a door).",
  guarantees:
    "Only tells people, never switches anything; one message each time the entity stays on long enough.",
  params: SUSTAINED_NOTICE_PARAMS,
  watch: (p) => [p.entity],
  actuates: () => [],
  initial: () => ({}),

  decide(_state, input, ctx) {
    const p = ctx.params;
    if (input.kind === "signal") {
      if (input.value === true && ctx.timer(SUSTAIN) === undefined) {
        return { why: `${p.entity} on, notice if it stays on ${p.forMin} min`, timers: [setTimer(SUSTAIN, ctx.now + minutes(p.forMin))] };
      }
      if (input.value !== true && ctx.timer(SUSTAIN) !== undefined) {
        return { why: `${p.entity} off before ${p.forMin} min`, timers: [cancelTimer(SUSTAIN)] };
      }
      return undefined;
    }
    if (input.kind === "timer") {
      if (ctx.value(p.entity) !== true) return { why: `${p.entity} no longer on` };
      return { why: `${p.entity} on for ${p.forMin} min`, events: [{ tag: "Noticed" }], actions: [notify(p.text)] };
    }
    return undefined;
  },

  evolve: (state) => state,
});

export default sustainedNotice;
