# Sun screen

A sun screen comes in after sundown, at once in a strong wind, and before rain, which is announced first.

## `screen-guard` — Sun screen guard

A sun screen (an awning, a roller screen over the terrace) is out for the sun and comes in for everything else.

**Guarantees.** It only closes, never opens. The dark and the wind close the screen at once and say so; rain is announced as an alert and the screen comes in after the countdown. A close that does not arrive is sent once more, then the household is alerted. No reading never closes anything.

| Role | Entities | Notes |
|---|---|---|
| `covers` | cover | several, switched · The screen: every cover entity of it (a Fibaro module has two). |

It also reads the house's outdoor conditions (`"outdoor"` in `allowlist.json`: a wind sensor when there is one, else the weather entity's wind and its state as the condition) and `sun.sun`'s elevation, which must be in the house scope.

## How it works

- **Sundown** (`sunBelow`, degrees of elevation; 0 is the horizon): while the sun is below it, an open screen is closed at once, and the house is told (a report in the main chat).
- **Wind** (`windAbove`, km/h): while the outdoor wind speed is above it, the same.
- **Rain** (`rain.conditions`, default rainy, pouring, lightning-rainy, hail, snowy-rainy, snowy; `rain.closeAfterMin`, default 10): when the weather condition turns to rain with the screen out, an alert goes out ("Rain is coming (rainy): closing the sun screen in 10 min.") and the screen comes in when the countdown runs out, raining or not: it was announced. Closed by hand meanwhile, nothing more happens; opened again in the rain, the countdown starts again.
- Each rule applies only when its parameter is set, so one instance can be wind only.
- **Opening is the people's.** The guard never opens. A screen opened while it is dark or windy comes in again, and they are told why.
- **A close has `settleMin`** (default 3) to arrive: the motor runs for minutes, and a Fibaro roller-shutter module reports its state late (it reads by the position when there is one). Still open after that, the close is sent once more; still open, the household is alerted ("Sun screen still open after 2 closes, please check it.") and the screen is left alone until it reads closed.
- **The covers belong to the instance that moves them for people**, `button-cover` (which shares them); this guard operates them too. An instance of it must run for the guard to load.
- Mark the instance `"alerts": true` so the rain warning and the "still open" alert reach the alerts chat; the closes are reports and stay in the main chat.
- `closedPosition` (default 0) is the position that is closed; a screen wired the other way round takes 100.
- `texts` overrides any message; `{wind}`, `{condition}`, `{min}`, `{n}` and `{error}` are filled in.

## Try it

`example.json` is one instance. Copy it into the `instances` of `heuristics.json`, replace the
entity ids with yours, and leave it in shadow until its decisions look right. Then
`replay` it over the last days: every close it would have sent is one the weather asked for.

```json
{"heuristic": "screen-guard", "id": "terrace", "mode": "shadow", "alerts": true, "params": {"covers": ["cover.terrace_screen"], "sunBelow": 0, "windAbove": 25, "rain": {"closeAfterMin": 10}}}
```

The specs (`*.test.ts`) run on the simulator: `pnpm test` in the Teobeanie repository.
