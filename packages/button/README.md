# Buttons

A press of a button or a remote sets entities; wall buttons move covers to fixed positions.

## `button` — Button

A press on a remote or wall button (event entity or MQTT action) sets entities to values.

**Guarantees.** Each press sets the entities it names, the way a person pressing the button would expect; nothing happens between presses.

| Role | Entities | Notes |
|---|---|---|
| `events` | event (button) | several, optional · event.* entities whose presses count. |
| `presses[].set[].entity` | light or switch or cover or fan or climate or select or input_boolean | several, switched |
| `uses` | light or switch or cover or fan or climate or select or input_boolean | several, optional, switched · Targets another instance owns and shares (an appliance with its own auto-off), operated, not owned. |

## `button-cover` — Button → cover position

A button press moves covers to a fixed position.

**Guarantees.** Each press moves the covers to that button's position; nothing happens between presses.

| Role | Entities | Notes |
|---|---|---|
| `buttons[].entity` | event (button) | several |
| `covers` | cover | several, switched · The covers the buttons move. |

## How it works

The button pattern: a press does something. Presses come from event.*
entities (each press is a new state; event_type says which button action) or from
an MQTT topic with a JSON payload (zigbee2mqtt remotes publish {"action": "on"}),
delivered through Home Assistant's MQTT trigger, so a remote without any HA entity
works too. Each press sets entities to values, the way a rule's .to() does.

button-cover (wall buttons moving the blinds to fixed positions) is this pattern.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "button-cover", "id": "living-room-blinds", "mode": "shadow", "params": {"buttons": [{"entity": "event.blinds_remote_up", "position": 100}, {"entity": "event.blinds_remote_down", "position": 0}], "covers": ["cover.living_room_blinds"]}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
