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
stay quiet while someone is around.

One message when an entity has been on for a while: someone
lingering at a door. It only tells people; it never switches anything.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "door-nag", "id": "front-door", "mode": "shadow", "params": {"door": "binary_sensor.front_door", "everyMin": 5, "text": "The front door is still open."}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
