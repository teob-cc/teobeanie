# Appliance auto-off

An appliance switched off once its room has been empty for a while, with a keep-on window.

## `appliance-auto-off` — Appliance auto-off

An appliance goes off after its room has been empty for a while, outside a keep-on window.

**Guarantees.** Never switches off inside the keep-on window, and only after the room has been empty for the whole delay.

| Role | Entities | Notes |
|---|---|---|
| `occupancy` | binary_sensor (occupancy, motion, presence) | The room's occupancy: on = someone there. |
| `appliance` | switch | switched · Switched off once the room has been empty for vacantMin. |

## How it works

Switch an appliance off once a room has been empty for a while,
except inside a keep-on window (a room still empty when the window ends switches it
off then); optional switch-on at a fixed time.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "appliance-auto-off", "id": "coffee-machine", "mode": "shadow", "params": {"occupancy": "binary_sensor.kitchen_motion", "appliance": "switch.coffee_machine", "vacantMin": 20, "keepOn": {"from": "07:00", "to": "09:00"}}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
