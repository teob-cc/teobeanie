# Door watch

Reminders while a door stays open, and one message when someone lingers at a door.

## `door-nag` — Door left open

Reminds the household every few minutes while a door stays open.

**Guarantees.** Only tells people, never switches anything; the reminders stop as soon as the door closes.

| Role | Entities | Notes |
|---|---|---|
| `door` | binary_sensor (door, garage_door, window, opening) | The door contact: on = open. |
| `quietWhileOn` | binary_sensor or input_boolean (occupancy, motion, presence) | optional · Skip a reminder (but keep counting) while this entity is on. |

## `sustained-notice` — Sustained presence notice

One message when an entity has been on for a while (someone lingering at a door).

**Guarantees.** Only tells people, never switches anything; one message each time the entity stays on long enough.

| Role | Entities | Notes |
|---|---|---|
| `entity` | binary_sensor (occupancy, motion, presence) | Noticed once it has been on this long. |

## How it works

While a door stays open, send a reminder every N minutes; optionally
stay quiet while someone is around: while `quietWhileOn` is on, or while the fact
named in `onlyWhileFact` is not true. A skipped reminder still counts towards the
cadence.

One message when an entity has been on for a while: someone
lingering at a door. It only tells people; it never switches anything.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "door-nag", "id": "front-door", "mode": "shadow", "params": {"door": "binary_sensor.front_door", "everyMin": 5, "text": "The front door is still open."}}
```

### Only while nobody is near: a fact

"Nobody moving near the garage" is derived state: say it once, as a fact, and let
the reminder read it. Put the fact in a file of your own, for example
`heuristics/garage-facts.ts`, with your motion sensor:

```ts
import { fact, minutes } from "teobeanie";

export const nobodyNearGarage = fact(
  "nobody-near-garage",
  ({ ha, held }) => held(() => ha.binary_sensor.garage_motion.is("off"), minutes(5)),
  { title: "Nobody near the garage for 5 minutes" },
);

export default nobodyNearGarage;
```

Then name it in the instance. The door-nag reminds only while the fact is true:

```json
{"heuristic": "door-nag", "id": "garage", "mode": "shadow", "params": {"door": "binary_sensor.garage_door", "everyMin": 3, "text": "The garage door is still open, and nobody is near it.", "onlyWhileFact": "nobody-near-garage"}}
```

The fact shows on the House page with its value, since when, and its changes. An
instance that names a fact no file defines is not started (the reload says so).

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
