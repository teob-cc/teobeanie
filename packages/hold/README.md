# Hold

Put an entity into a value when a condition starts, and optionally keep it there while it lasts.

## `hold` — Hold

Puts an entity into a value when a condition starts and, optionally, keeps it there while the condition lasts.

**Guarantees.** The value is set each time the condition starts. Without enforce a person may change it afterwards and is left alone until the condition starts again; with enforce it is set back.

| Role | Entities | Notes |
|---|---|---|
| `target` | climate or light or switch or fan or cover or valve or select or input_boolean or input_number | switched · The entity put into the value. |
| `when.entity` | climate or binary_sensor or switch or input_boolean or sensor | optional |

## How it works

The hold pattern: put an entity into a value when a condition starts (each
time it starts), and optionally keep it there while the condition lasts. A climate
setpoint applied whenever heating switches on; a light kept on in a time window;
a valve kept open. Without enforce a person may change it afterwards and is left
alone until the condition starts again; with enforce the value is set back.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "hold", "id": "living-room-setpoint", "mode": "shadow", "params": {"target": "climate.living_room", "value": {"temperature": 20}, "when": {"entity": "climate.living_room", "is": ["heat"]}}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
