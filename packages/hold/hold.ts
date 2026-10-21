// hold — the hold pattern: put an entity into a value when a condition starts (each
// time it starts), and optionally keep it there while the condition lasts. A climate
// setpoint applied whenever heating switches on; a light kept on in a time window;
// a valve kept open. Without enforce a person may change it afterwards and is left
// alone until the condition starts again; with enforce the value is set back.

import { param, release, rule, type Desired, type Infer } from "teobeanie";

const HOLD_PARAMS = param.object({
  target: param.entity().doc("The entity put into the value."),
  value: param.value<Desired>().doc('A state ("on", "heat", "open") or attributes ({ "temperature": 21 }).'),
  when: param
    .object({ entity: param.entity(), is: param.strings() })
    .optional()
    .doc("Only while this entity is in one of these states (it may be the target itself)."),
  between: param.object({ from: param.time(), to: param.time() }).optional().doc('Only between these house-time clock times ("HH:MM"; may wrap midnight).'),
  otherwise: param.value<Desired>().optional().doc('Outside the condition put the target here (e.g. "off"); default: leave it alone.'),
  enforce: param.bool().default(false).doc("Set the target back whenever it drifts while the condition holds."),
});

export type HoldParams = Infer<typeof HOLD_PARAMS>;

export const hold = rule<HoldParams>(
  "hold",
  ({ entity, between }, p) => {
    const holds = (p.when === undefined || entity(p.when.entity).is(...(p.when.is as never[]))) && (p.between === undefined || between(p.between.from, p.between.to));
    return entity(p.target).to((holds ? p.value : (p.otherwise ?? release)) as Desired);
  },
  {
    title: "Hold",
    description: "Puts an entity into a value when a condition starts and, optionally, keeps it there while the condition lasts.",
    guarantees:
      "The value is set each time the condition starts. Without enforce a person may change it afterwards and is left alone until the condition starts again; with enforce it is set back.",
    params: HOLD_PARAMS,
    watch: (p) => (p.when ? [p.when.entity] : []),
    owns: (p) => [p.target],
    enforce: (p) => p.enforce === true,
    pattern: "hold",
  },
);

export default hold;
