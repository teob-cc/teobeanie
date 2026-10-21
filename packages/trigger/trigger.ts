// trigger — the trigger pattern: targets are on while any of their inputs is active,
// and go off once every input has been quiet for a while (the run-on). Switching on
// can wait for a gate (dark enough); switching off never does. A person who switches
// a target by hand is not overruled until the trigger changes its mind.
//
// occupancy-light (lights follow presence) and follow-with-run-on (a pump follows the
// boiler's demand) are this pattern under their own parameter names.

import { keep, minutes, param, rule, type Desired, type Infer, type World } from "teobeanie";

const TRIGGER_PARAMS = param.object({
  when: param.entities().doc("Any of these active triggers."),
  activeStates: param.strings().default(["on"]).doc("The states that count as active (binary sensors, switches)."),
  targets: param.entities().doc("On while triggered, off after the run-on: light.*, switch.*, fan.*, ..."),
  offAfterMin: param.duration("min").doc("Minutes every input must have been quiet before the targets go off."),
  onlyBelow: param
    .object({ sensor: param.entity(), below: param.number() })
    .optional()
    .doc("Switch on only while this sensor reads below the threshold (e.g. illuminance)."),
  brightnessPct: param.number({ unit: "%", min: 0, max: 100 }).optional().doc("Brightness for lights when switching on."),
});

export type TriggerParams = Infer<typeof TRIGGER_PARAMS>;

function triggered({ entity, held }: World, p: TriggerParams) {
  const states = (p.activeStates ?? ["on"]) as never[];
  const active = () => p.when.some((e) => entity(e).is(...states));
  let want: "on" | "off" | typeof keep;
  if (active()) {
    const gate = p.onlyBelow;
    // No reading (unavailable, not a number) does not block switching on.
    const open = gate === undefined || typeof entity(gate.sensor).value !== "number" || entity(gate.sensor).below(gate.below);
    want = open ? "on" : keep;
  } else {
    want = held(() => !active(), minutes(p.offAfterMin)) ? "off" : keep;
  }
  return p.targets.map((t) =>
    entity(t).to((want === "on" && t.startsWith("light.") && p.brightnessPct !== undefined ? { state: "on", brightness_pct: p.brightnessPct } : want) as Desired),
  );
}

const inputs = (p: TriggerParams) => [...p.when, ...(p.onlyBelow ? [p.onlyBelow.sensor] : [])];

export const trigger = rule<TriggerParams>("trigger", triggered, {
  title: "Trigger",
  description: "Targets on while any input is active (optionally only below a threshold), off once all inputs have been quiet for a run-on.",
  guarantees:
    "A target switched by hand is not overruled until the inputs change their mind; switching off never waits for the gate, and a gate sensor without a reading never blocks switching on.",
  params: TRIGGER_PARAMS,
  watch: inputs,
  owns: (p) => p.targets,
  pattern: "trigger",
});

// ---- presets ----

const OCCUPANCY_LIGHT_PARAMS = param.object({
  occupancy: param.entities().doc("Any of these on = occupied."),
  lights: param.entities("light", "switch").doc("light.* and/or switch.* entities."),
  offAfterMin: param.duration("min").doc("Minutes the zone must have been vacant before the lights go off."),
  darkness: param
    .object({ sensor: param.entity(), below: param.number() })
    .optional()
    .doc("Only switch on when this illuminance sensor reads below the threshold. Off never checks it."),
  brightnessPct: param.number({ unit: "%", min: 0, max: 100 }).optional().doc("Brightness for lights when switching on."),
});

export type OccupancyLightParams = Infer<typeof OCCUPANCY_LIGHT_PARAMS>;

const fromOccupancy = (p: OccupancyLightParams): TriggerParams => ({
  when: p.occupancy,
  targets: p.lights,
  offAfterMin: p.offAfterMin,
  ...(p.darkness ? { onlyBelow: p.darkness } : {}),
  ...(p.brightnessPct !== undefined ? { brightnessPct: p.brightnessPct } : {}),
});

export const occupancyLight = rule<OccupancyLightParams>("occupancy-light", (w, p) => triggered(w, fromOccupancy(p)), {
  title: "Occupancy light",
  description: "Lights on while a zone is occupied (optionally only when dark); off after it has been vacant for a while.",
  guarantees:
    "A light switched by hand is not overruled until the zone's occupancy changes; it goes off only after the zone has been vacant for the whole run-on.",
  params: OCCUPANCY_LIGHT_PARAMS,
  watch: (p) => inputs(fromOccupancy(p)),
  owns: (p) => p.lights,
  pattern: "trigger",
});

const FOLLOW_PARAMS = param.object({
  demand: param.entity().doc("The demand signal: on = demand."),
  target: param.entity().doc("On while there is demand, and for the run-on after it."),
  runOnMin: param.duration("min").doc("Minutes the target stays on after the demand stops."),
});

export type FollowParams = Infer<typeof FOLLOW_PARAMS>;

const fromFollow = (p: FollowParams): TriggerParams => ({ when: [p.demand], targets: [p.target], offAfterMin: p.runOnMin });

export const followWithRunOn = rule<FollowParams>("follow-with-run-on", (w, p) => triggered(w, fromFollow(p)), {
  title: "Follow with run-on",
  description: "A switch is on while a demand signal is on, and stays on for a run-on period after it stops.",
  guarantees:
    "The switch follows the demand and keeps running for the run-on after it stops; a person switching it by hand is not overruled until the demand changes.",
  params: FOLLOW_PARAMS,
  watch: (p) => [p.demand],
  owns: (p) => [p.target],
  pattern: "trigger",
});

export default [trigger, occupancyLight, followWithRunOn];
