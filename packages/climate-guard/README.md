# Climate guard

One air conditioner or heat pump kept within limits: setpoints per mode, a longest run, and starts on cold or heat.

## `climate-guard` — Climate guard

Setpoints per mode, a longest run, and a start below or above a room temperature; commands lift it for a room, or heat a room to a temperature, for a while.

**Guarantees.** A setpoint a person sets through Home Assistant stands until the next run; no run lasts longer than the longest run; a cloud unit's late report of an old run is not a new run; while a room's waiver runs, the unit is left alone; a wish keeps to the house's bounds and leaves the unit as it found it.

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

Optional wish: a command (`/warm bedroom 21 2h`) heats one room to a temperature for
a while (default 3 h), within the house's bounds for the unit's setpoint. Meanwhile
the unit heats at that setpoint (switched to heat if it was off or cooling), with no
longest run; its drift is set back, a person's change through HA becomes the wish's.
Then the unit goes back to how it was: off stays off, another mode comes back, and a
heating unit gets the guard's setpoint (a fresh longest run from the wish's end) or,
where the guard holds none (a boiler's thermostat), the setpoint it had before. Someone
switching the unit off or to another mode ends the wish. A wish and a waiver never run
together: either ends the other. Several instances share the command, as the waiver.

```json
"warm": { "command": "warm", "room": "bedroom", "defaultHours": 3, "maxHours": 12 }
```

`/warm bedroom 21` (3 h), `/warm bedroom 21.5 90m`, `/warm bedroom off` (ends it, the
unit back as it was). The temperature must lie within the house's bounds for the unit
(`allowlist.json` `"bounds"`, else the SafeActuator's 15–27); a thermostat the guard only
answers wishes for takes `"setpoints": {}` and nothing else.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "climate-guard", "id": "den", "mode": "shadow", "params": {"climate": "climate.den_unit", "setpoints": {"heat": 20, "cool": 22}, "maxRunMin": 180, "startHeatBelow": 17, "startCoolAbove": 25}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
