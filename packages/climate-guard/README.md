# Climate guard

One air conditioner or heat pump kept within limits: setpoints per mode, a longest run, and starts on cold or heat.

## `climate-guard` — Climate guard

Setpoints per mode, a longest run, and a start below or above a room temperature; a command lifts it for a room for a while.

**Guarantees.** A setpoint a person sets through Home Assistant stands until the next run; no run lasts longer than the longest run; a cloud unit's late report of an old run is not a new run; while a room's waiver runs, the unit is left alone.

| Role | Entities | Notes |
|---|---|---|
| `climate` | climate | switched · The climate entity. |
| `temperature` | sensor or input_number (temperature) | optional · A room temperature sensor; default the unit's own current_temperature. |

## How it works

One climate unit (an air conditioner, a heat pump) kept within limits:

- while it heats or cools, its setpoint is the one for that mode; the unit's own
drift (an app schedule, a reset) is set back, a change made through HA by a user
stands until the next run;
- a run (heating or cooling, however it started) stops after maxRunMin; a cloud
unit that still reports the old run for a while after it was switched off (its
state catching up) is not a new run, for settleMin;
- switched off, it starts heating when the room is colder than startHeatBelow, and
cooling when it is warmer than startCoolAbove.

Other modes (dry, fan only, auto) are left alone.

Optional waiver: a command (`/climate_waive bedroom`) lifts the guard for one room
for a while (default 3 h), to heat or cool beyond its limits. Meanwhile the unit is
left alone: no setpoint, no longest run, no start. Then the guard takes the unit over
as it finds it, as at a start: a run under way gets the mode's setpoint and counts
from the waiver's end. Several instances share the command, each for its own room.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "climate-guard", "id": "den", "mode": "shadow", "params": {"climate": "climate.den_unit", "setpoints": {"heat": 20, "cool": 22}, "maxRunMin": 180, "startHeatBelow": 17, "startCoolAbove": 25}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
