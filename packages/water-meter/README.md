# Water meter

Notices from a pulse water meter: water running at night, and each shower summed up with its gas and cost.

## `night-leak` — Water running at night

Tells the household when the water meter keeps counting through the night, a little at a time: a dripping tap, a running toilet.

**Guarantees.** Only tells people, never closes anything; one notice per run of water, however long it lasts.

| Role | Entities | Notes |
|---|---|---|
| `meter` | sensor (water) | The water meter's total in litres. |

## `shower-summary` — Shower summary

When a large use of hot water (a shower, a bath) is over, tells the household the water and gas it took and what they cost.

**Guarantees.** Only tells people, never switches anything; one message per hot-water use, after it is over.

| Role | Entities | Notes |
|---|---|---|
| `water` | sensor (water) | The water meter's total in litres. |
| `gas` | sensor (gas) | The gas meter's total in m³. |
| `hotWater` | binary_sensor | optional · On while the boiler heats tap water. Given: a use is hot only if it came on. Without: a use is hot when the gas meter moved by minGasM3. |
| `gasPrice` | sensor or input_number (monetary) | optional · The gas price now, in €/m³. |

## How it works

Notices from a pulse water meter: water that keeps running at night
(a leak), and a hot-water use (a shower) summed up with its gas and what it cost.

Both read a meter total in litres that only ever counts up. Neither journals a
reading: a use is journaled when it starts and ends, and its litres are the
difference of the totals. Each reading re-arms a quiet timer, so the use is over
when that timer fires. The meter's last_changed is no sign of water: a meter that
writes the same total again (force_update) moves it every few seconds. A total that
jumps (the meter's value set by hand) is a counter correction, never water used.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right.

```json
{"heuristic": "night-leak", "id": "house", "mode": "shadow", "params": {"meter": "sensor.water_total"}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
