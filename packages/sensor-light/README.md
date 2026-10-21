# Sensor light

Lights on when a sensor sees someone, off once the room has been quiet; people win in between.

## `sensor-light` — Sensor → lights

Lights on when a sensor sees someone (optionally only when dark, at a level by time of day); off once the room has been empty for a run-on. Lights switched by hand are left alone until the room empties.

**Guarantees.** A light switched off by hand while someone is there stays off until the room has been empty for the run-on; a light someone switched on keeps the brightness they chose; an unavailable sensor is never evidence of an empty room.

| Role | Entities | Notes |
|---|---|---|
| `sensors` | binary_sensor (occupancy, motion, presence) | several · Presence or motion sensors: any of them active switches the lights on. |
| `lights` | light or switch | several, switched · light.* and switch.* entities. |
| `dark.illuminance` | sensor (illuminance) | optional |
| `dark.tooBright` | binary_sensor (light) | optional |
| `keepOnWhile.entities` | binary_sensor or input_boolean or media_player or switch | several, optional |

## How it works

The trigger pattern for lights. Lights come on when a sensor sees
someone (only when it is dark enough, if asked), at a level that can depend on the
time of day, and go off once every sensor has been quiet for a while. In between,
people win:

- a light switched off by hand while someone is there stays off until the room
has been empty for the run-on; one switched off in an empty room comes on again
at the next visit;
- a light someone already switched on is left at the brightness they chose;
- a light switched on by hand in an empty room goes off after the same run-on;
- an unavailable sensor is no evidence of an empty room, and with every sensor
down the lights stay as they are.

occupancy-light (trigger.ts) is the older, plainer form of this.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "sensor-light", "id": "hallway", "mode": "shadow", "params": {"sensors": ["binary_sensor.hallway_motion"], "lights": ["light.hallway"], "offAfterMin": 3}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
