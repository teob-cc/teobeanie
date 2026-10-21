# Leak guard

A leak sensor closes the main water valve; reopening it is never automatic.

## `leak-shutoff` — Water leak shutoff

Any leak sensor going wet closes the main water valve and alerts the household. Reopening stays manual.

**Guarantees.** Any leak closes the valve and tells the household. Reopening is never automatic: it is refused for every instance, whatever the rest of the configuration says.

| Role | Entities | Notes |
|---|---|---|
| `sensors` | binary_sensor (moisture) | several · Leak sensors: any of them wet closes the valve. |
| `valve` | valve or switch | switched · The main water valve (a valve, or a switch that is on while open). |

## How it works

Closing the valve is automatic; reopening it is never
automated: the heuristic forbids it in the SafeActuator for every instance.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "leak-shutoff", "id": "main-water", "mode": "shadow", "params": {"sensors": ["binary_sensor.kitchen_leak", "binary_sensor.bathroom_leak"], "valve": "valve.main_water", "text": "Water leak — main water closed. Sensor:"}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
