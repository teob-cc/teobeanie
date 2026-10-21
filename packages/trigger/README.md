# Trigger

Targets on while an input is active, off after a run-on: the generic form, occupancy lights, and a pump that follows a demand.

## `trigger` — Trigger

Targets on while any input is active (optionally only below a threshold), off once all inputs have been quiet for a run-on.

**Guarantees.** A target switched by hand is not overruled until the inputs change their mind; switching off never waits for the gate, and a gate sensor without a reading never blocks switching on.

| Role | Entities | Notes |
|---|---|---|
| `when` | binary_sensor or switch or input_boolean | several · Any of these active triggers. |
| `targets` | light or switch or fan | several, switched · On while triggered, off after the run-on: light.*, switch.*, fan.*, ... |
| `onlyBelow.sensor` | sensor (illuminance) | optional |

## `occupancy-light` — Occupancy light

Lights on while a zone is occupied (optionally only when dark); off after it has been vacant for a while.

**Guarantees.** A light switched by hand is not overruled until the zone's occupancy changes; it goes off only after the zone has been vacant for the whole run-on.

| Role | Entities | Notes |
|---|---|---|
| `occupancy` | binary_sensor (occupancy, motion, presence) | several · Any of these on = occupied. |
| `lights` | light or switch | several, switched · light.* and/or switch.* entities. |
| `darkness.sensor` | sensor (illuminance) | optional |

## `follow-with-run-on` — Follow with run-on

A switch is on while a demand signal is on, and stays on for a run-on period after it stops.

**Guarantees.** The switch follows the demand and keeps running for the run-on after it stops; a person switching it by hand is not overruled until the demand changes.

| Role | Entities | Notes |
|---|---|---|
| `demand` | binary_sensor or switch or input_boolean | The demand signal: on = demand. |
| `target` | switch | switched · On while there is demand, and for the run-on after it. |

## How it works

The trigger pattern: targets are on while any of their inputs is active,
and go off once every input has been quiet for a while (the run-on). Switching on
can wait for a gate (dark enough); switching off never does. A person who switches
a target by hand is not overruled until the trigger changes its mind.

occupancy-light (lights follow presence) and follow-with-run-on (a pump follows the
boiler's demand) are this pattern under their own parameter names.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "follow-with-run-on", "id": "circulation-pump", "mode": "shadow", "params": {"demand": "binary_sensor.boiler_heating", "target": "switch.circulation_pump", "runOnMin": 15}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
