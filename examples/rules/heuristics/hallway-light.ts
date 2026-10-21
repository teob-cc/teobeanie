// hallway-light — a desired-state rule: say what the light should be, given the
// house; the kernel works out the timers and the calls, and only acts when the
// answer changes (so switching the light by hand is not fought).
//
// Rules are TypeScript in the config folder's heuristics/ directory, run as-is (no
// build step). With the house's generated ha.d.ts next to them, entity ids, states
// and desired values are type-checked.

import { keep, minutes, rule } from "teobeanie";

export default rule("hallway-light", ({ ha, held, between }) => {
  const motion = ha.binary_sensor.hallway_motion;
  return ha.light.hallway.to(
    motion.is("on")
      ? { state: "on", brightness_pct: between("23:00", "06:00") ? 15 : 100 }
      : held(() => motion.is("off"), minutes(5))
        ? "off"
        : keep,
  );
});
