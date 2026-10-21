# Garage door

Open and close a garage door by command through its opener's step button, with an optional auto-close.

## `garage-door` — Garage door commands

Open and close commands press the opener's step button only when that gets the door there, then confirm from the door contact. Optionally closes a door left open with nobody there, after an announcement and a reminder.

**Guarantees.** The step button is pressed only when that gets the door where it was asked to go, and every command gets an answer from the door contact. An automatic close is announced first, and anyone arriving or a keep-open command stops it.

| Role | Entities | Notes |
|---|---|---|
| `button` | switch | switched · The momentary relay on the opener's step input (shared by a relay-pulse instance). |
| `contact` | binary_sensor (garage_door, door) | Door contact: on = open. |
| `autoClose.presence` | binary_sensor (occupancy, motion, presence) | optional · Someone there (an occupancy sensor): no countdown while it is on, nor while it reports nothing. |

## How it works

The command pattern: a named command (from Telegram, later the panel
or an agent) checks the house, acts, and confirms. "Open" or "close" presses the
opener's step button only when that gets the door where it was asked to go, then
waits for the door contact and reports what happened. The press goes through the
momentary relay another instance owns (relay-pulse shares it): that instance
releases it, whoever pressed it.

Optional auto-close: a door left open with nobody there is announced ("I'll close it
in 5 min"), reminded once, then closed the same way a close command does. Someone
showing up, the door closing, or the keep-open command stops the countdown; after a
keep-open the door is left alone until it next closes.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "garage-door", "id": "garage", "mode": "shadow", "params": {"button": "switch.garage_opener_relay", "contact": "binary_sensor.garage_door", "commands": {"open": "garage_open", "close": "garage_close"}}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
