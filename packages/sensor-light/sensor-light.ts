// sensor-light — the trigger pattern for lights. Lights come on when a sensor sees
// someone (only when it is dark enough, if asked), at a level that can depend on the
// time of day, and go off once every sensor has been quiet for a while. In between,
// people win:
//
//   - a light switched off by hand while someone is there stays off until the room
//     has been empty for the run-on; one switched off in an empty room comes on again
//     at the next visit;
//   - a light someone already switched on is left at the brightness they chose;
//   - a light switched on by hand in an empty room goes off after the same run-on;
//   - an unavailable sensor is no evidence of an empty room, and with every sensor
//     down the lights stay as they are.
//
// occupancy-light (trigger.ts) is the older, plainer form of this.

import { keep, minutes, param, release, rule, type Desired, type Infer, type World } from "teobeanie";

const LEVEL = {
  brightnessPct: param.number({ unit: "%", min: 0, max: 100 }).optional().doc("Brightness."),
  colorTempK: param.number({ unit: "K", positive: true }).optional().doc("Colour temperature."),
};

const SENSOR_LIGHT_PARAMS = param.object({
  sensors: param.entities().doc("Presence or motion sensors: any of them active switches the lights on."),
  activeStates: param.strings().default(["on"]).doc("The states that count as active."),
  lights: param.entities("light", "switch").doc("light.* and switch.* entities."),
  offAfterMin: param.duration("min").doc("Minutes the room must have been empty (and a light on) before that light goes off."),
  dark: param
    .oneOf({
      illuminance: param.object({ illuminance: param.entity(), below: param.number({ unit: "lx" }) }),
      tooBright: param.object({ tooBright: param.entity("binary_sensor") }),
      sunBelow: param.object({ sunBelow: param.number({ unit: "°", min: -90, max: 90 }) }),
    })
    .optional()
    .doc(
      'Switch on only when it is dark: an illuminance sensor below a threshold, a "too bright" binary sensor (many motion sensors report one) off, or the sun below an elevation (sun.sun must be in the house scope). No reading never blocks; switching off never checks it.',
    ),
  level: param.object(LEVEL).optional().doc("Brightness and colour temperature for light.* when switching on."),
  levels: param
    .list(param.object({ ...LEVEL, from: param.time(), to: param.time() }))
    .optional()
    .doc('Other levels by local time ("HH:MM", wrapping midnight); the first that matches wins.'),
  keepOnWhile: param
    .object({ entities: param.entities(), states: param.strings().default(["on"]) })
    .optional()
    .doc("Entities that keep the room occupied while in one of `states` but never switch the lights on: a closed door."),
});

export type SensorLightParams = Infer<typeof SENSOR_LIGHT_PARAMS>;
export type LightLevel = NonNullable<SensorLightParams["level"]>;

function isDark({ entity, sun }: World, d: SensorLightParams["dark"]): boolean {
  if (d === undefined) return true;
  if ("illuminance" in d) {
    const lux = entity(d.illuminance);
    return typeof lux.value !== "number" || lux.below(d.below);
  }
  if ("tooBright" in d) return !entity(d.tooBright).is("on");
  const elevation = sun.elevation;
  return elevation === undefined || elevation < d.sunBelow;
}

function onValue({ between }: World, p: SensorLightParams, light: string): Desired {
  if (!light.startsWith("light.")) return "on";
  const level = (p.levels ?? []).find((l) => between(l.from, l.to)) ?? p.level ?? {};
  const attrs = {
    ...(level.brightnessPct !== undefined ? { brightness_pct: level.brightnessPct } : {}),
    ...(level.colorTempK !== undefined ? { color_temp_kelvin: level.colorTempK } : {}),
  };
  return Object.keys(attrs).length > 0 ? { state: "on", ...attrs } : "on";
}

function sensorLights(w: World, p: SensorLightParams) {
  const { entity, held } = w;
  const activeStates = (p.activeStates ?? ["on"]) as never[];
  const active = () => p.sensors.some((s) => entity(s).is(...activeStates));
  const keeping = () => p.keepOnWhile !== undefined && p.keepOnWhile.entities.some((e) => entity(e).is(...((p.keepOnWhile!.states ?? ["on"]) as never[])));
  const reporting = (s: string) => {
    const st = entity(s).state;
    return st !== undefined && st !== "unavailable" && st !== "unknown";
  };
  const vacant = () => !active() && !keeping() && p.sensors.some(reporting);
  /** When the room last changed: the latest change of any sensor or keepOnWhile entity (0 when unknown). */
  const roomSince = () => Math.max(0, ...[...p.sensors, ...(p.keepOnWhile?.entities ?? [])].map((e) => entity(e).since));
  const runOn = minutes(p.offAfterMin);

  if (active()) {
    if (!isDark(w, p.dark)) return p.lights.map((l) => entity(l).to(keep));
    return p.lights.map((l) => entity(l).to(onValue(w, p, l) as never));
  }
  // Nobody seen (read once here, so the explanation names each sensor once).
  const vacantNow = !keeping() && p.sensors.some(reporting);
  return p.lights.map((l) => {
    const light = entity(l);
    // On: off once the room has been empty, and the light on, for the run-on.
    if (light.state === "on") return light.to(held(() => vacant() && light.is("on"), runOn) ? "off" : keep);
    // Off: forget the last answer, so the next "on" is new (and so is the next "off", for
    // a light switched on by hand later). A light switched off while someone was there
    // comes back only once the room has been empty for the run-on; one switched off in
    // an already empty room (on the way out, or by something else) at the next visit.
    if (light.state === "off") {
      const offInEmptyRoom = vacantNow && light.since > roomSince();
      return light.to(offInEmptyRoom || held(vacant, runOn) ? release : keep);
    }
    return light.to(keep);
  });
}

export const sensorLight = rule<SensorLightParams>("sensor-light", sensorLights, {
  title: "Sensor → lights",
  description:
    "Lights on when a sensor sees someone (optionally only when dark, at a level by time of day); off once the room has been empty for a run-on. Lights switched by hand are left alone until the room empties.",
  guarantees:
    "A light switched off by hand while someone is there stays off until the room has been empty for the run-on; a light someone switched on keeps the brightness they chose; an unavailable sensor is never evidence of an empty room.",
  params: SENSOR_LIGHT_PARAMS,
  watch: (p) => [
    ...p.sensors,
    ...p.lights,
    ...(p.keepOnWhile?.entities ?? []),
    ...(p.dark === undefined ? [] : "illuminance" in p.dark ? [p.dark.illuminance] : "tooBright" in p.dark ? [p.dark.tooBright] : ["sun.sun"]),
  ],
  owns: (p) => p.lights,
  settle: () => true,
  watchAttributes: (p) => (p.dark !== undefined && "sunBelow" in p.dark ? ["sun.sun"] : []),
  pattern: "trigger",
});

export default sensorLight;
