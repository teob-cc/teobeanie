// house-facts — facts: derived state with a value and a since when it holds. A fact
// is written like a rule, but it says what is true rather than what a device should
// be. The kernel evaluates it when what it reads changes (and when a time condition
// can flip), and journals it only when its value changes. Rules read it as
// ha.facts.<name> (camelCase or snake_case), a decider as ctx.fact("<id>"); the House
// view lists it with its timeline.
//
// Each fact is also exported by name: the generated ha.d.ts types its value from that
// name, so facts (and rules) in one file can read each other.

import { fact, minutes } from "teobeanie";

export const hallwayQuiet = fact("hallway-quiet", ({ ha, held }) => held(() => ha.binary_sensor.hallway_motion.is("off"), minutes(15)), {
  title: "Nobody in the hallway for 15 minutes",
});

// A fact may read another fact (never in a cycle: the loader refuses one).
export const heatingUnattended = fact("heating-unattended", ({ ha }) => ha.facts.hallwayQuiet.is(true) && ha.binary_sensor.boiler_heating.is("on"), {
  title: "The boiler heats while nobody is about",
});

export default [hallwayQuiet, heatingUnattended];
