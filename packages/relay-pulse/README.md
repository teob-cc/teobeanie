# Momentary relay

A latching relay that drives a push-button input is released after a short press, whoever pressed it.

## `relay-pulse` — Momentary relay

Turns a relay back off shortly after it turns on, so a latching relay acts as a button press.

**Guarantees.** A relay that turns on is released after the press, whoever turned it on, and once more if it is still on a few seconds later.

| Role | Entities | Notes |
|---|---|---|
| `relays` | switch | several, switched · The latching relays, each driving a momentary input. |

## How it works

The momentary pattern: latching relays that drive momentary inputs
(e.g. a door opener's step button). Whenever one turns on, whoever turned it on,
release it after a short press, and again if it is still on a few seconds later.
It shares the relays: other instances (garage-door) press them by turning them on.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "relay-pulse", "id": "garage-opener", "mode": "shadow", "params": {"relays": ["switch.garage_opener_relay"], "pressMs": 1000, "recheckMs": 5000}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
