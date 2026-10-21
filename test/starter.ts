// starter.ts — the starter packages' heuristics (packages/ in the repository), for the
// platform's tests that need real ones. The add-on itself loads them from the config
// folder (src/packages/library.ts); test/packages.test.ts checks that path.

import type { AnyHeuristic } from "../src/kernel/heuristic.js";
import appliance from "../packages/appliance/appliance-auto-off.ts";
import button from "../packages/button/button.ts";
import climateGuard from "../packages/climate-guard/climate-guard.ts";
import doorNag from "../packages/door-watch/door-nag.ts";
import sustainedNotice from "../packages/door-watch/sustained-notice.ts";
import garageDoor from "../packages/garage-door/garage-door.ts";
import hold from "../packages/hold/hold.ts";
import leakShutoff from "../packages/leak-guard/leak-shutoff.ts";
import relayPulse from "../packages/relay-pulse/relay-pulse.ts";
import sensorLight from "../packages/sensor-light/sensor-light.ts";
import trigger from "../packages/trigger/trigger.ts";
import waterMeter from "../packages/water-meter/water-meter.ts";

export const STARTER: AnyHeuristic[] = [
  sensorLight,
  trigger,
  hold,
  button,
  relayPulse,
  doorNag,
  sustainedNotice,
  waterMeter,
  leakShutoff,
  appliance,
  garageDoor,
  climateGuard,
].flat();
