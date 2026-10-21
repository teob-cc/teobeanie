// night-light — a sample rule of your own: a dim night light in the hallway from
// 22:00 to 06:00 while there is motion, off two minutes after the last motion. Say what
// the light should be; Teobeanie works out the timers and the calls, and only acts when
// the answer changes (so a light switched by hand is not fought).
//
// Files here run as they are (no build step). Run the instance in shadow first, read its
// decisions in the Decisions tab, and replace the ids with your own. Copy this file under
// a new name to start another. See docs/heuristics.md, "Your own heuristics, as code".

import { keep, minutes, rule } from "teobeanie";

export default rule(
  "night-light",
  ({ ha, held, between }) => {
    const motion = ha.binary_sensor.hallway_motion;
    return ha.light.hallway_night.to(
      between("22:00", "06:00") && motion.is("on")
        ? { state: "on", brightness_pct: 10 }
        : held(() => motion.is("off"), minutes(2))
          ? "off"
          : keep,
    );
  },
  // A light that already is off gets no needless "off" call.
  { settle: () => true },
);
