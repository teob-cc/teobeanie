# Energy: the house's euros and quantities

The energy ledger keeps the house's money and quantities per hour, day, week, month
and year: grid import and export, solar, gas, water and each device Home Assistant's
energy dashboard lists, each hour priced at its own price. It reads; it never
switches anything. The panel's **Energy** tab shows it, and the `energy` MCP tool
gives it to an agent.

## Where the numbers come from

- **Quantities**: Home Assistant's long-term statistics (`recorder/statistics_during_period`,
  hourly `change`), for the sources of its energy dashboard (`energy/get_prefs`): the
  grid with its tariffs, solar, gas, water and the individual devices. The hour that
  runs comes from the 5-minute statistics.
- **Prices**, per hour, in this order:
  1. the price entity's hourly mean, from the same statistics;
  2. a price fetched for that hour from the price history (below);
  3. a neighbouring hour's mean within three hours, for an entity that was unavailable
     for a while;
  4. the nearest known price (today the entity's state, in the past the nearest
     month's mean), marked **estimated**.
- **Export**: credited at the export price HA's energy dashboard names, unless a tariff
  in `energy.json` says otherwise from a date on (when net metering ends).
- **Fixed charges** and the energy tax credit from `energy.json`, per day.
- **Degree days**: `max(0, base − the day's mean outdoor temperature)`, base 18 °C, from
  the outdoor temperature's hourly means (allowlist.json's `outdoor.temperature`). € and
  m³ per degree day compare heating across a mild and a cold week.

A counter that goes back (a reset, or the integration added again) or jumps past what a
house can use in an hour (`limits`, default 25 kWh and 10 m³) counts 0 for that hour,
and the Data band says which statistic and when.

## Closing days

Today is computed as it goes and never stored. Each past day is **closed** once:
journaled as `DayClosed` in `teob-energy/ledger` with its ledger and its data flags.
At the first start the ledger closes every day the statistics hold, up to five years,
newest first, a month at a time, in the background. Then it closes each day 20 minutes
after midnight. A closed day is final: the record does not change when Home Assistant's
statistics or prices do later.

What only a closed day can keep:

- **The gas split** between hot water and heating. Each step of the gas meter (the
  signals of the meter in `attribution.gas`) counts for the boiler state that was on
  between the previous reading, less the meter's lag (5 min), and it. With both on,
  the step is split by how long each was. A step while neither was on (cooking, or no
  state known) stays unattributed. The signals are kept 30 days, so older days have no
  split.
- **The showers**: the `ShowerReported` events of `shower-summary` instances (the
  water-meter package): count, litres, m³ and €.
- **Past prices** fetched from the price history, journaled as `PricesRecorded` in
  `teob-energy/prices`.

## The price history

With `"priceHistory": { "source": "energyzero" }` and Home Assistant's EnergyZero
integration, hours the statistics have no price for are priced with EnergyZero's
all-in hourly electricity prices (VAT, taxes and markup included). The prices come
through Home Assistant's `energyzero.get_energy_prices` service, a call that only
returns data.

Gas has only a market price there (`energyzero.get_gas_prices`, with VAT). The all-in
gas price is that price plus an **adder** for the taxes and markup:

- `gasAdder` sets it;
- without one, it is derived as the median difference between the gas price entity's
  daily means and the market price over the days both are known. Days priced this way
  are marked estimated.

The same service gives today's and (after about 13:00) tomorrow's price curve for the
Energy tab. Without a price history, the curve comes from the price entity's `prices`
attribute (`[{ start, price }]`) or Nord Pool's `raw_today` / `raw_tomorrow`.

## energy.json

Optional, in the config folder next to `tiles.json`, and part of the working set: it
reloads live, is checked before it is applied, and is kept in each revision. Every key
is optional.

```json
{
  "tariffs": [
    { "from": "2026-01-01", "fixedPerDay": { "electricity": 1.25, "gas": 0.95, "water": 0.27 }, "taxCreditPerYear": 524.95 },
    { "from": "2027-01-01", "exportPrice": 0.05 }
  ],
  "priceHistory": { "source": "energyzero" },
  "water": { "stat": "sensor.water_meter_total", "price": "sensor.water_price" },
  "attribution": { "gas": "sensor.gas_meter", "hotWater": "binary_sensor.boiler_hot_water", "heating": "binary_sensor.boiler_heating" },
  "devices": {
    "sensor.*_cooling_energy": { "use": "cooling" },
    "sensor.ventilation_energy": { "use": "ventilation", "name": "Ventilation" },
    "sensor.old_meter_energy": { "hidden": true }
  },
  "degreeDays": { "base": 18 },
  "limits": { "maxKwhPerHour": 25, "maxM3PerHour": 10 }
}
```

| Key | Meaning |
|---|---|
| `tariffs` | Periods, each from its date on. A later period overrides the fields it names and keeps the others. `fixedPerDay` is € per day per carrier. `taxCreditPerYear` is spread over the year's days. `exportPrice` is `"import"` (net metering: the import price), a fixed €/kWh, or a price entity. |
| `priceHistory` | `source: "energyzero"`; `configEntry` names the integration's entry when there are several; `gasAdder` is € per m³ on top of the market gas price. |
| `water`, `gas` | A meter (`stat`, a statistic id) and its `price` (an entity, or a fixed price per m³), for one HA's energy dashboard does not list or prices differently. |
| `attribution` | The gas meter (default: the energy dashboard's gas source), and the binary sensors that are on while the boiler heats water (`hotWater`) and the house (`heating`). `lagMin` is how late the meter reports, default 5. |
| `devices` | Per statistic id or pattern (`*`): `use` (`heating`, `cooling`, `hot_water`, `ventilation`, `other`), `name`, `hidden`. An exact id HA's dashboard does not list adds that device. Without a use, one is guessed from the name ("cooling", "heat", "water heater", "ventilation"). |
| `degreeDays` | `base` °C; `temperature`, an outdoor temperature other than allowlist.json's. |
| `limits` | The most an hour can use; more is a counter's artefact. |

## API and tool

- `GET api/energy`: the Energy tab's first load (`EnergyOverview` in
  `src/energy/types.ts`). It holds today so far and projected by its end, the last 7
  closed days, the price curve with the price now and its band (the cheapest third of
  the next 24 h, the dearest, or between), the data flags, the sources and the
  backfill's progress. The projection takes the rest of the day at the last 7 days'
  use per hour, priced on today's curve.
- `GET api/energy/periods?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD`: one
  ledger per period, oldest first. Weeks are ISO weeks. The current period includes
  today so far.
- `GET api/energy/hours?date=YYYY-MM-DD`: a day's hours with the prices each was priced
  at.
- MCP `energy` (read): `view` `today` (default), `periods` (`period`, `from`, `to`) or
  `hours` (`date`).
