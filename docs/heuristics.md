# Heuristics: programming the house with rules and deciders

The map of the whole add-on (stores, effects, integrations, the working set, the agent)
is [architecture.md](architecture.md); this document is the programming model.

There are two ways to write a heuristic, and both run on the same kernel:

- A **rule** says what state its entities should be in, given the rest of the house
  and the time. Most automations are this: lights, pumps, appliances, covers.
- A **decider** reacts to inputs with explicit events, timers and actions, for logic
  that has to remember things: reminders that count, appliance cycles.

## Control patterns

Most home automation is a handful of patterns. The starter packages have one
implementation of each, and a house is mostly instances of them in `heuristics.json`.
The add-on copies them into the config folder's `packages/` (see
[Behaviour packages](#behaviour-packages)):

| Pattern | What it does | Starter package: heuristics |
|---|---|---|
| **momentary** | A latching switch acts as a push button: whenever it turns on, whoever turned it on, it is released after a short press (and again if it stays on). | relay-pulse: `relay-pulse` |
| **trigger** | Targets are on while any input is active (optionally only below a threshold, such as illuminance), and off once every input has been quiet for a run-on. | trigger: `trigger`, presets `occupancy-light`, `follow-with-run-on`; sensor-light: `sensor-light` (lights from presence sensors); appliance: `appliance-auto-off` |
| **hold** | Put an entity into a value each time a condition starts (a setpoint when heating switches on), optionally keep it there (`enforce`), optionally another value outside the condition (a schedule). | hold: `hold`; climate-guard: `climate-guard` |
| **button** | A press sets entities: from an `event.*` entity (by `event_type`) or an MQTT action, so a zigbee2mqtt remote works without any HA entity. | button: `button`, preset `button-cover` |
| **command** | A named command checks the house, acts, and confirms what happened. | garage-door: `garage-door` |
| **notice** | Tell people: reminders while a door is open, someone lingering, water running at night, a shower's cost. | door-watch: `door-nag`, `sustained-notice`; water-meter: `night-leak`, `shower-summary` |
| **guard** | Protect the house; never undone automatically. | leak-guard: `leak-shutoff` |

Patterns compose by **sharing**, never by two owners. An instance may `share` an entity
it owns, and another instance that declares it in `uses` may operate it too:
`relay-pulse` shares the garage relay, so `garage-door` presses it and `relay-pulse`
releases it; `appliance-auto-off` shares the coffee machine, so a `button` remote
switches it on and the auto-off still switches it off; `climate-guard` shares its unit,
so a house's own heuristic may switch it on and off while the guard keeps its setpoint. An instance that uses an entity
nobody shares is not started.

`garage-door` can also close a door left open with nobody there (`autoClose`): after
`noticeAfterMin` (3) it announces "I'll close it in 5 min", reminds a minute before,
then presses the button like a close command and confirms from the contact. Someone
showing up (`presence` on, or reporting nothing), the door closing, or the
`keepOpenCommand` stops the countdown; after a keep-open it waits until the door closes.
The opener's own obstruction sensor still has the last word on a closing door.

```json
{ "heuristic": "hold", "id": "study-setpoint",
  "params": { "target": "climate.study", "value": { "temperature": 20 },
              "when": { "entity": "climate.study", "is": ["heat"] } } }

{ "heuristic": "button", "id": "coffee-remote",
  "params": { "mqtt": { "topic": "zigbee2mqtt/Coffee remote" },
              "presses": [{ "action": "on",  "set": [{ "entity": "switch.coffee_machine", "to": "on" }] },
                          { "action": "off", "set": [{ "entity": "switch.coffee_machine", "to": "off" }] }],
              "uses": ["switch.coffee_machine"] } }
```

Commands (`garage_open`) reach an instance through `commands`; Telegram delivers
them once the add-on runs the bot.

### Lights from sensors

`sensor-light` is the trigger pattern for lights, with what lights need on top:

```json
{ "heuristic": "sensor-light", "id": "stairs",
  "params": { "sensors": ["binary_sensor.stairs_top_motion", "binary_sensor.stairs_bottom_motion"],
              "lights": ["light.stairs_top", "light.stairs_bottom"], "offAfterMin": 5,
              "dark": { "tooBright": "binary_sensor.stairs_top_illuminance_above_threshold" },
              "level": { "brightnessPct": 100 },
              "levels": [{ "from": "23:00", "to": "06:30", "brightnessPct": 15, "colorTempK": 2200 }] } }
```

- **On** when any sensor is active (`activeStates`, default `["on"]`), if it is dark:
  `dark` is an illuminance sensor below a threshold (`{ "illuminance": "sensor.x",
  "below": 50 }`), a "too bright" binary sensor that is off (`{ "tooBright": ... }`), or
  the sun below an elevation (`{ "sunBelow": 3 }`; `sun.sun` must be in the scope). The
  check is repeated while someone is there, so a light comes on when dusk falls on a
  person already outside. No reading never blocks. Switching off never checks it.
- **Level:** `level` for `light.*`, or the first of `levels` whose clock times match.
  It is applied when a light switches on, never to a light that is already on.
- **Off** once every sensor has been quiet, and the light on, for `offAfterMin`. A
  light switched on by hand in an empty room goes off after the same run-on.
- **People win:** a light switched off by hand while someone is there stays off until
  the room has been empty for the run-on; a light someone already switched on is left
  at the brightness they chose.
- **Unavailable sensors** are no evidence of an empty room: the run-on counts from the
  moment a sensor reports again, and with every sensor down the lights stay as they are.
- **`keepOnWhile`** `{ "entities": [...], "states": ["off"] }` keeps the room occupied
  (a closed bathroom door) without ever switching the lights on.

### Climate units

`climate-guard` keeps one climate unit within limits:

```json
{ "heuristic": "climate-guard", "id": "den", "mode": "active",
  "params": { "climate": "climate.den_unit", "setpoints": { "heat": 20, "cool": 22 },
              "maxRunMin": 180, "startHeatBelow": 17, "startCoolAbove": 25 } }
```

- **Setpoints** per mode while it heats or cools. The unit's own drift (an app
  schedule, a reset after a mode change) is set back, at most every `graceSec` (300);
  a setpoint a user changes through HA stands until the next run.
- **`maxRunMin`**: a heating or cooling run, however it started, is switched off after it.
- **`startHeatBelow` / `startCoolAbove`**: a unit that is off starts heating (cooling)
  when the room temperature (`temperature`, or the unit's own `current_temperature`)
  is below (above) it; that run is limited too.
- Other modes (dry, fan only, auto) and an unavailable unit are left alone.
- **`waive`** `{ "command": "climate_waive", "room": "bedroom", "hours": 3 }` lifts the
  guard for one room for a while, to heat or cool beyond its limits:
  `/climate_waive bedroom` waives it for `hours` (3) and replies until when, in house
  time; sent again, it renews the waiver from then; `/climate_waive bedroom off` ends
  it early. Meanwhile the unit is left alone: no setpoint set back, no longest run, no
  start. When the waiver ends the guard takes the unit over as it finds it, as at a
  start: a run under way gets the mode's setpoint again and counts its longest run
  from the waiver's end, not from when it began; a unit that is off may be started.
  The decision log says who waived it and until when, and the end; a restart keeps a
  running waiver.

Every room's instance takes the same command, each with its own `room`. The others
stay silent; `/climate_waive` alone, or with a room no instance answers for, gets one
reply listing the rooms (from the instance whose room sorts first). The messages are a
`texts` object, below. In Telegram the command is in the bot's menu, and
`/climate_waive` alone (or with a room nobody answers for) gets a button per room
instead, plus "bedroom off" for a room whose waiver runs; a press runs the command as
the person who pressed it. Rooms match in any case.

### Water

Two notices read a pulse water meter's total in litres (a meter that only counts up).
Neither journals a reading as an event: a use is journaled when it starts and ends,
and its litres are the difference of the totals. Each new reading re-arms a quiet
timer, so a use is over when that timer fires. The meter's `last_changed` is no sign
of water: a meter that writes the same total again (`force_update`) moves it every
few seconds. A total that jumps (the meter's value set by hand) is a counter
correction, never water used.

```json
{ "heuristic": "night-leak", "id": "house",
  "params": { "meter": "sensor.water_total", "from": "00:30", "to": "05:30" } }

{ "heuristic": "shower-summary", "id": "house",
  "params": { "water": "sensor.water_total", "gas": "sensor.gas_total",
              "hotWater": "binary_sensor.boiler_hot_water",
              "waterPricePerM3": 1.76, "gasPrice": "sensor.gas_price" } }
```

- **`night-leak`:** inside the night window, the meter counting for `persistMin` (60)
  with no break longer than `gapMin` (15) is one notice, with the litres and the rate.
  A flush or a glass of water stops at the first break. A run that grows beyond
  `maxLitres` (1000) is taken for a correction and counted afresh. A drip slower than
  a litre per `gapMin` is too slow for a pulse meter to show as a run.
- **`shower-summary`:** a use ends once the meter has been still for `quietMin` (2).
  One longer than `maxMin` (60) is no shower (a garden hose, a leak) and is not
  summed up. One of at least `minLitres` (30) that was hot is summed up: the litres, the minutes,
  the gas meter's difference over the use and what both cost. Hot means `hotWater`
  (the boiler heating tap water) came on during it; without that sensor, the gas meter
  moving by `minGasM3` (0.05). A smart meter reports gas every few minutes, so the
  summary waits for its first reading after the water stopped, at most `gasWaitMin`
  (6). A combination boiler heats tap water before the house, so the gas over a shower
  is the shower's; the minutes before its first reading may carry some heating. Prices:
  `waterPricePerM3` (all in), `gasPrice` (an entity, the price now) or `gasPricePerM3`;
  an unknown one shows as `?`.

### Outdoor conditions

`allowlist.json` may say where the outdoor conditions come from. Measuring sensors are
preferred over the weather entity, which also gives the wind:

```json
"outdoor": { "weather": "weather.home", "temperature": "sensor.outdoor_temperature",
             "humidity": "sensor.outdoor_humidity" }
```

A rule reads `outdoor.temperature`, `outdoor.humidity`, `outdoor.windSpeed`,
`outdoor.windGust`, `outdoor.windBearing` and `outdoor.condition`, and is woken when
they change, including the weather entity's attributes, which change without its state:

```ts
export default rule("awning", ({ ha, outdoor, held }) =>
  ha.cover.awning.to(held(() => (outdoor.windSpeed ?? 0) > 40, minutes(2)) ? "closed" : keep),
);
```

Tiles can show an attribute (`{ "entityId": "weather.home", "label": "Wind", "kind":
"wind", "attribute": "wind_speed" }` shows "31 km/h SE"), and the MCP `outdoor` tool
reports the readings with their sources.

## Rules: desired state

```ts
import { keep, minutes, rule } from "teobeanie";

export default rule("hallway-light", ({ ha, held, between }) => {
  const motion = ha.binary_sensor.hallway_motion;
  return ha.light.hallway.to(
    motion.is("on")
      ? { state: "on", brightness_pct: between("23:00", "06:00") ? 15 : 100 }
      : held(() => motion.is("off"), minutes(5)) ? "off" : keep,
  );
});
```

The rule returns `entity.to(value)` for each entity it sets (one, or an array), with
`keep` meaning "no opinion right now". The kernel re-evaluates it whenever an entity it watches changes, or when
a time condition can flip. It acts only when an entity's desired value **changes**.
When that happens it journals `DesiredChanged{entity, from, to}` and sends the call that
gets the entity there. So a person who switches the light by hand is not fought: the
rule acts again only when its own answer changes. At start, an entity that already is
in its desired state gets no call.

| In the rule | Means |
|---|---|
| `ha.light.hallway`, `entity("light.hallway")` | An entity handle. `.to(value)` says what it should be. |
| `.is("on", ...)`, `.above(n)`, `.below(n)` | Predicates. They are recorded, and the decision's reason is the predicates the evaluation took, e.g. `hallway → off · hallway_motion is on ✗, hallway_motion is off for 5 min`. |
| `.state`, `.value`, `.attr(name)`, `.since` | Raw state, normalized value, an attribute, last_changed. |
| `held(() => cond, ms)` | `cond` has been true for `ms`. It is measured from the inputs' last_changed, so it is right across restarts, and tracked while true, so a numeric condition is not reset by every new reading. |
| `within(() => cond, ms)` | `cond` is true, or was within the last `ms` (run-on). |
| `between("22:00", "06:30")` | House-local clock time, wrapping midnight. |
| `sun.belowHorizon`, `sun.elevation` | From `sun.sun`. |

Desired values are `"on"`/`"off"` (light, switch, fan, input_boolean, media_player, ...),
`"open"`/`"closed"` (cover, valve), `"locked"`/`"unlocked"`, a number (number,
input_number), an option (select, input_select), or an object with a state plus
attributes: `{ state: "on", brightness_pct: 30 }`, `{ position: 30 }` for a cover,
`{ hvac_mode: "heat", temperature: 21 }` for climate. When only attributes change, only
those are sent.

The kernel only knows when to re-evaluate a rule for entities it watches. Those are the
`ha.domain.object_id` references in its source and what it reads on a first evaluation
over an empty house, plus an optional `{ watch: (params) => [...] }`. A rule that reads
something outside that set journals `UnwatchedRead` once. Name the entity with
`ha.domain.object_id`, or add it to `watch`. A rule owns the entities its first
evaluation calls `.to()` on, plus an optional `owns`.

Two options change when a rule calls. `enforce: (p) => true` sets an entity back when
it drifts from the answer (see hold); `enforce: (p) => ({ yieldToUsers: true })` only
when the device drifted by itself, and leaves a change made through HA by a user (the
signal carries the HA context's `user_id`) until the rule's answer changes. `settle: (p) => true` records a new answer
without a call when the entity already is there; for switches and lights only on/off
counts, so a light someone already switched on keeps its brightness. `watchAttributes`
names entities whose attribute-only changes re-evaluate the rule (`sun.sun` for its
elevation).

Rules can take params, like any package's heuristic:
`rule<Params>("id", ({ entity }, p) => p.lights.map((l) => entity(l).to("on")), { watch, owns, title, description })`.

### Typed Home Assistant

With the house's types next to the rules, every entity id, state and desired value is
checked while you write: `ha.light.halway` is an error ("Did you mean 'hallway'?"), so
are `motion.is("open")` on a binary sensor, `light.to("purple")` and a climate mode
the unit does not have. The types come from Home Assistant's live states:

```sh
HA_URL=http://homeassistant.local:8123 HA_TOKEN=... node dist/studio/cli.js types <config folder>
tsc -p <config folder>
```

This writes `heuristics/ha.d.ts` (each entity id with its possible states, named and
documented), the `"teobeanie"` module's declarations in `.teob/`, and a `tsconfig.json` if
there is none. `.teob/heuristics.schema.json` is `heuristics.json` as a JSON Schema, made
from the heuristics' parameter schemas (below): with
`"$schema": "./.teob/heuristics.schema.json"` at the top of `heuristics.json`, an editor
completes and checks the instances as the loader will. Regenerate when entities are added, renamed or removed: a rule using a
deleted entity then fails to compile instead of silently doing nothing. The add-on
runs rules without the types; they are for writing them.
`test/rules.test.ts` shows `occupancy-light` and `follow-with-run-on` written as rules
that make the same calls at the same times as the deciders.

## Deciders

A decider is a pure **decide** function plus an **evolve** over its own state. Everything it
wants done comes back as data. The kernel journals that data, arms its timers durably,
and hands its actions to the SafeActuator, the one path to Home Assistant.

```ts
defineHeuristic<Params, State, Event>({
  id: "door-nag",                       // journal category; instances are entities
  watch:    (p) => [p.door],            // changes delivered as signal inputs
  reads:    (p) => [p.quietWhileOn],    // readable via ctx.get(), never wake the heuristic
  actuates: (p) => [],                  // ownership claim, enforced by the SafeActuator
  forbids:  (p) => [],                  // services nobody may automate on an entity (optional)
  triggers: (p) => ({ ... }),           // HA trigger schema (time, sun, ...) by id
  initial:  (p) => ({ openSince: null, nags: 0 }),
  decide(state, input, ctx) {           // pure: no clock, no HA, no I/O
    return { why, events, actions, timers };
  },
  evolve(state, event) { ... },         // pure fold over the heuristic's own events
  view(state, ctx) { ... },             // optional: its card on the House page (Cards below)
});
```

Instances live in `heuristics.json` in the config folder. In the add-on that is
`/config`, shown as `addon_configs/…_teobeanie`. Standalone, it is `./.dev-data` or
`CONFIG_DIR`. Complete example folders are in [`examples/`](../examples), and the
add-on copies them into the config folder on first start.

The split is deliberate:
- **This repository is the plumbing:** the kernel, the SafeActuator, the panel, the
  add-on, and the starter packages (generic heuristics the add-on copies into the config
  folder). None of it has house-specific entity ids.
- **The config folder is your house:** instances, its packages (the starter set and
  your own), your own heuristics as code, the house scope (`allowlist.json`), and the
  tiles.

### Cards

A heuristic can give each instance a card on the House page: a title, a few values
and buttons that run its commands. `view` builds it, and is pure like `decide`: it
sees the instance's state, its params and the live values of the entities it watches
or reads (`ctx.get`, `ctx.value`; anything else reads as undefined). It has no clock.

```ts
view(state, ctx) {
  const door = ctx.get(ctx.params.door);
  return {
    title: "Door left open",
    fields: [
      { label: "Door", value: door?.value === true ? "open" : "closed", since: door?.since, tone: "warn" },
      { label: "Reminders sent", value: state.nags },
    ],
    buttons: [{ label: "Close", command: ctx.params.command, args: ["now"], confirm: "Close the door?" }],
  };
},
```

- A **field** has a `label`, a `value` (text, number, yes/no or none) and optionally
  a `unit`, a `since` (ms; the panel says how long ago) and a `tone` (`ok`, `warn`,
  `bad`).
- A **button** runs one of the instance's own `commands`, with `args`, through
  `POST api/command`: as the panel's HA user, journaled like a Telegram command.
  `confirm` asks first; `disabled` shows it greyed out. A button for a command the
  instance does not answer to is left out, and the card says so.
- Active and shadow instances have a card; a shadow one is marked shadow (its buttons
  reach it, but it acts on nothing). Each card links to the instance's decisions.
- A rule takes `view` in its options; its state is `{ desired }`, what it wants per entity.
- In tests, `simulate(...).card()` gives the card as the House page gets it.

A package imports the card types (`Card`, `CardField`, `CardButton`, `ViewCtx`) from
`"teobeanie"`. In the starter set, `garage-door` (door open or closed since when, open,
close and keep-open buttons) and `door-nag` in `door-watch` (open since when, reminders
sent) have cards.

### The house scope

`allowlist.json` says which part of Home Assistant is the house Teobeanie runs. Every
listed entity is observed: recorded in the signal ring and readable by heuristics.
An entry with `"operate": true` may also be acted on. Anything not listed, such as a
printer or the cameras, does not exist for Teobeanie:

- an instance that watches, reads or owns an entity outside the scope is not started
  at boot, and a reload that needs one is rejected; the log says which entities are
  missing;
- a read of an unlisted entity returns nothing, and the SafeActuator refuses any call
  on an entity that is not `"operate"`, whoever owns it;
- the Studio and the generated types only know listed entities, and `.to()` only
  compiles for operable ones;
- the MCP tools only show the scope.

```json
{
  "policyVersion": 1,
  "entities": [
    { "id": "binary_sensor.hallway_motion" },
    { "id": "light.hallway", "operate": true },
    { "id": "sensor.indoor_co2", "debounce": "deadband", "params": { "deadband": 25 } }
  ]
}
```

`debounce` defaults to `on-change`. Widening the scope is a reviewed change to this
file, not something a heuristic or an agent can do.

```json
{ "heuristic": "door-nag", "id": "garage", "mode": "shadow", "alerts": true,
  "params": { "door": "binary_sensor.garage_door_contact", "everyMin": 3,
              "text": "Garage door is still open, but no one in the garage!",
              "quietWhileOn": "binary_sensor.garage_occupancy" } }
```

`"alerts": true` sends the instance's notices to the alerts chat as well (the add-on
option `telegram_alerts_chat_id`): a chat for watching the house, which takes no
commands. Everything else (replies to commands, Teobeanie's own messages) goes to the main
chat only: whatever an instance says on a command is a reply, also from an instance marked
`alerts`. The alerts chat is for what may need someone to act; a heuristic marks a notice
that needs nobody as a report, `notify(text, { info: true })` (the shower summary, a climate
guard resuming), and that
too goes to the main chat only.

With `telegram_commands` on, the bot's menu lists every command an active instance
answers to, with the heuristic's short English line for it (`garage-door`: "Open the
garage door"); `"commandHelp": { "garage_open": "Open the shed" }` next to `mode` sets
the instance's own. Shadow instances still take typed commands (and journal what they
would do) but are not in the menu, as they never reply. A command with arguments
(`commandArg`) sent without one gets a keyboard of the arguments.

`"notifyPerHour": 30` next to `mode` and `alerts` (not inside `params`) caps the notices this
instance may send per hour: a positive whole number, otherwise the instance does not
start. Without it the heuristic's own cap holds (`garage-door` 30, `door-nag` 60,
any other 12).

Texts are parameters with English defaults. `sustained-notice`, `door-nag` and
`leak-shutoff` take a `text`; `leak-shutoff` also takes `forbidReason`, the reason
given when something tries to reopen the valve. `garage-door` and `climate-guard`
have several messages, so they take one optional `texts` object:
`{ "texts": { "opening": "Going up" } }` replaces that message and keeps the rest. The
keys and defaults are `GARAGE_DOOR_TEXTS` and `CLIMATE_GUARD_TEXTS`;
`{state}`, `{s}`, `{min}`, `{keep}` and `{command}` in a garage text are filled in, and
`{room}`, `{until}`, `{rooms}`, `{command}` and `{hours}` in a climate-guard text.

### Parameters

Every heuristic of the starter packages declares its parameters as a schema (`src/kernel/params.ts`):
each one's name, kind (an entity id and of which domains, a number and its unit, a
duration in ms, s, min or h, a clock time, a text, ...), whether it is required, its
default and what it is for. The loader checks every instance against it before
anything else: an unknown key, a missing required param, a wrong type, an entity of
the wrong domain or a negative duration leaves that instance out at boot, and rejects
a reload, with the path and what was expected:

```
heuristics.json: sensor-light/porch: params.lights[0]: expected an entity id of domain light or switch, got "sensor.porch" — skipped
```

A default is what the heuristic uses when the param is left out; the loader does not
write it into the params. `simulate()` and `cli.js replay` refuse params the loader
would. The same schema, as JSON (`describeParams`), is what the panel's instance editor
is built from, and the TypeScript type the heuristic is written against is derived
from it (`type DoorNagParams = Infer<typeof PARAMS>`), so the three cannot drift.
A heuristic's `guarantees` (a sentence or two of plain English: what it promises the
people in the house) is shown next to its description in the panel's catalogue; a
rule takes it as an option, like `title`.

## Behaviour packages

A package is a folder in the config folder's `packages/`: one behaviour, ready to use
and the house's to change.

```
packages/door-watch/
  teobeanie.json        the manifest
  door-nag.ts           the code: imports only from "teobeanie", default-exports its heuristics
  sustained-notice.ts
  door-watch.test.ts    its specs, on simulate()
  README.md             what it does, what it promises, its roles
  example.json          one instance, to copy into heuristics.json
```

The manifest says what the package is and which entities each heuristic needs:

```json
{
  "name": "door-watch",
  "version": "1.0.0",
  "platform": ">=0.2.0 <1.0.0",
  "title": "Door watch",
  "pattern": "notice",
  "heuristics": {
    "door-nag": {
      "pattern": "notice",
      "roles": {
        "door": { "domain": "binary_sensor", "device_class": ["door", "garage_door", "window", "opening"] },
        "quietWhileOn": { "domain": ["binary_sensor", "input_boolean"], "optional": true }
      },
      "uses": ["notify"]
    }
  }
}
```

- **`platform`** is a version range of the `"teobeanie"` module. A package whose range
  leaves the running version out does not load.
- **A role** is one of the heuristic's entity parameters, named by its path in the
  params (`lights`, `dark.illuminance`, `rooms[].climate`), with hints for finding it
  in Home Assistant: the `domain`, the `device_class`, `many` (several entities),
  `optional` (it may be left out) and `operate` (the heuristic switches it; otherwise it
  only reads it). The loader checks each role against the parameter schema: the path
  must name an entity parameter, `many` and `optional` must match it, and the domain
  must be one it takes. The starter packages name a role for every entity parameter.
- **`uses`** says what else it relies on: `notify`, `commands`, `triggers`, `outdoor`,
  `clock`, `sun`. The loader checks `commands`, `triggers` and `outdoor` against the code.
- **`main`** (optional) names the files that default-export the heuristics; without it,
  every `.ts`, `.js` or `.mjs` file at the top of the folder does, specs aside.

Packages load with `heuristics/` (below), on start and on every reload, all or nothing
per package: a package whose manifest is wrong, whose code fails, or whose code and
manifest disagree is skipped at start and rejects a reload. A heuristic id defined
twice, in two packages or in a package and a file, is an error. An edited package file
is imported afresh, and the package's other files with it.

**The starter set.** The add-on ships the generic packages in the table above and no
heuristics of its own. On every start (and on `cli.js init`) it copies each starter
package that is missing from `packages/` into it, and never overwrites one that is
there. `teobeanie.lock.json` records each package's origin (`starter`, or `local` for
one the house put there), its version and the hash of its files as installed. A
package whose files no longer match is marked `"modified": true` and stays as it is;
`"upstream"` says when the add-on ships another version of it. A starter package the
house deleted stays deleted (`"removed": true`), unless an instance in
`heuristics.json` names one of its heuristics: then it is installed again. The panel's
catalogue shows each heuristic's package, and marks a starter package the house
changed.

A house's own behaviour that is more than a file (its code, specs, README) is best
kept as a package of its own, in its private config repository, and copied into
`packages/` with the rest. Its specs run with this repository's vitest:
`TEOBEANIE_PACKAGES=../my-house/packages pnpm vitest run ../my-house/packages`.

## Your own heuristics, as code

Drop `.ts`, `.js` or `.mjs` files into `heuristics/` in the config folder. TypeScript
runs as-is through Node's type stripping, with no build step. Each file
default-exports a rule or heuristic definition, or an array of them:

```ts
// <config folder>/heuristics/hallway-light.ts
import { keep, minutes, rule } from "teobeanie";

export default rule("hallway-light", ({ ha, held }) =>
  ha.light.hallway.to(
    ha.binary_sensor.hallway_motion.is("on") ? "on"
      : held(() => ha.binary_sensor.hallway_motion.is("off"), minutes(5)) ? "off" : keep,
  ),
);
```

`"teobeanie"` is resolved by the add-on to its toolkit (`"teob"`, its name before the
rename, still is too). A file may instead default-export a
function that receives the toolkit, as the decider example below does.


```js
// <config folder>/heuristics/appliance-done.js
export default ({ defineHeuristic, notify, setTimer, cancelTimer, minutes }) =>
  defineHeuristic({
    id: "appliance-done",
    watch: (p) => [p.power],
    actuates: () => [],
    initial: () => ({ running: false, startedAt: null }),
    decide(state, input, ctx) { /* ... */ },
    evolve(state, event) { /* ... */ },
  });
```

The toolkit contains `rule`, `keep`, `release`, `defineHeuristic`, `call`, `notify`,
`setTimer`, `cancelTimer`, `fill`, `minutes`, `seconds`, `hours`, `heldSince`, `anyOn`,
`readOutdoor`, `actionsFor`, the clock helpers `localMinutes`, `parseHhMm`,
`nextLocalTime`, `localTimeOn` and `houseZone` (`localMinutes(ctx.now,
houseZone(ctx.house))`), and `param`, the parameter vocabulary: everything the starter
packages use. A rule's instance in `heuristics.json` needs no params:
`{ "heuristic": "hallway-light", "id": "main", "params": {} }`.

A heuristic of your own may declare its parameters the way the packages do, and is
then checked the same way (without a schema, any params are taken, as before):

```ts
import { defineHeuristic, param, type Infer } from "teobeanie";

const PARAMS = param.object({
  power: param.entity("sensor").doc("The plug's power reading."),
  quietMin: param.duration("min").default(3).doc("Below idle this long: done."),
  text: param.text().doc("The message."),
});

export default defineHeuristic<Infer<typeof PARAMS>, State, Event>({ id: "appliance-done", params: PARAMS, /* ... */ });
```

The vocabulary: `entity(...domains)`, `entities(...domains)`, `number({ unit, min, max,
positive, integer })`, `duration(unit)`, `bool()`, `time()` ("HH:MM"), `text()`,
`texts(defaults)`, `string()`, `strings()`, `value()` (a state or attributes),
`object({ ... })`, `list(item)` and `oneOf({ name: object(...) })`; each takes
`.optional()`, `.default(v)` and `.doc("...")`. `rule(id, fn, { params })` takes one too.
Files load at startup and on every config reload (below); an edited file is imported
afresh, an unchanged one is not. At startup a broken file, or one reusing a package's
id, is logged and skipped. Its instances are skipped too, and the rest of the house
keeps running. On a reload it rejects the reload instead. A module that a custom file
imports itself (a shared helper) is loaded once: a change there needs a restart. The
worked examples are
[`examples/rules`](../examples/rules) and
[`examples/custom-heuristic`](../examples/custom-heuristic), and
`test/examples.test.ts` shows how to test such a file with `simulate()`.

## Changing the config while it runs

The working set is read again one second after the last change to any of its files
(`heuristics.json`, `allowlist.json`, `tiles.json`, `teobeanie.lock.json`, anything
under `heuristics/` and `packages/`), and on `POST api/reload` (ingress only, like the
Studio's writes; the panel's **Reload config** button). Each applied change is a
revision of the working set, which can be diffed and rolled back
([working-set.md](working-set.md#undoing-a-change)).
A reload is planned in full before anything changes (`host.prepare()`), then committed:

- An instance whose mode, params, code or entities (an outdoor source moved) changed
  is stopped and started again on its own stream. Its runtime replays the journal and
  re-arms the journaled timers, and it gets a `start` input to reconcile, exactly as
  after a restart. A removed instance stops, and its timers with it. An added one
  starts.
- Every other instance is not touched: no replay, no `start`, its timers keep running.
  Each instance has an entity runtime of its own over the shared journal, which is what
  makes stopping one possible without stopping the rest.
- Claims, uses and forbids are re-made in the SafeActuator in one synchronous step. The
  scope, the routing (a new bridge, seeded from the old one's live cache when the routed
  entities change), the House view and the MCP tools follow the new `allowlist.json`.
- Any problem rejects the whole reload: broken JSON, an unknown heuristic, a duplicate
  instance, an entity outside the scope, two owners of one entity, a `uses` nobody
  shares, a custom file that fails to load. The reason is logged at warning, returned
  by the endpoint and shown on the Heuristics tab; the running set stays as it was.
- One line per reload: `reload (file): +1 −0 ~2 (mode) unchanged 18`, followed by the
  instance keys.

A restarted instance loses what was in flight. An outcome arriving after its runtime
stopped is dropped, so the action is settled as interrupted on the new start, and a
notice decided within `resendWithinMs` is sent once more: the same rule as a restart,
over a window of milliseconds instead of seconds. The add-on options (`shadow_mode`,
Telegram, the log level) are not part of a reload and still need a restart.

### Shadow twins

A twin tries a new version of an instance on the same inputs as the one that runs: new
params, a newer package, a rule rewritten from scratch. It is an instance with
`"twinOf"` naming its original, in shadow:

```json
{ "heuristic": "sensor-light", "id": "hallway", "mode": "active", "params": { … } },
{ "heuristic": "sensor-light", "id": "hallway-next", "mode": "shadow", "twinOf": "sensor-light/hallway", "params": { … } }
```

- It may watch, read and name the same entities to switch as its original. Of the pair
  one claims them: the original, unless the twin is active (allowed only while the
  original is not) or the original is off. The other's actions are vetted as the
  claimer's would be (scope, ownership, bounds, the pause), but not counted against a
  rate limit: a twin never calls, so it spends none of its original's budget.
- A twin is never active while its original is; a twin of a twin, two twins of one
  instance, and a twin that switches what a third instance owns are rejected, like two
  owners of one entity.
- The panel compares the two: for each input signal either decided on since the twin
  started, the actions each decided (requested, suppressed or refused alike), and lists
  where they differ. Decisions on other inputs (start, timers, triggers, commands)
  have no shared id and are only counted. `GET api/twins/<heuristic>/<id>`.
- **Promote** (`POST api/twins/<heuristic>/<id>/promote`) swaps them in one edit of
  `heuristics.json`: the original is removed (its stream stays in the journal), and the
  twin takes its id and mode and keeps its own heuristic, package and params. The
  promoted instance runs on the stream of its new key: with the same heuristic that is
  the original's stream, replayed under the new params, as after any params change.
  It is one revision, so a rollback to the one before undoes it.

## Inputs

| kind | when | carries |
|---|---|---|
| `start` | first HA states snapshot after boot | lets the heuristic reconcile with the current world (door already open, lights on in an empty room) |
| `signal` | a watched entity changed (bridge, on-change) | `entity`, normalized `value`, raw `state`, `obsId` (row in `signals.db`), `origin` (`ha`/`resync`) |
| `timer` | a timer this instance set came due | `timer`, `data` |
| `trigger` | a declared HA trigger fired | trigger id, HA variables |
| `command` | a named command arrived (the Telegram command lane, the panel's `POST api/command`; later the agent) | `command`, `args`, `from` (channel, user); `choices`: the first arguments the instances sharing it answer for (`commandArg`, one or several per instance), so one of them can answer an argument nobody else does |
| `outcome` | an action requested in active mode finished | `actionId`, `ok`, `error`, `haContextId` |

`ctx.now` is the input's timestamp. `ctx.get(entity)` reads a snapshot of declared
entities, and every read is journaled with the decision. `ctx.timer(id)` returns the due
time of a pending timer. Time-of-day rules convert explicitly (`kernel/clock.ts`,
DST-safe) in the house's zone, `ctx.house.timeZone` (Home Assistant's, or the
`time_zone` option; UTC until HA has said), never through the process time zone.

## Decisions

```ts
{ why?: string; events?: E[]; actions?: Action[]; timers?: TimerOp[] }
```

- `undefined` means nothing happened. It is not journaled.
- A `why` alone is a **declined** decision ("occupied but 2176 lx: light enough"). It is
  journaled, so "why didn't the light come on?" has an answer.
- Actions: `call(service, entities, data?)` or `notify(text)`.
- Timers: `setTimer(id, at, data?)` or `cancelTimer(id)`. Setting an existing id
  replaces it.

## Journal grammar

One decision is one atomic batch in the instance's stream:

```
Decided{input, why, reads, mode}          ← causation: obsId | the TimerSet that fired | the action
  <domain events>                         ← causation: Decided
  TimerSet{timer, at} | TimerCancelled    ← durable; re-armed from state after a restart
  ActionRequested{at} | ActionSuppressed | ActionRefused{reason}
later:
ActionCompleted{ok, error?, haContextId}  ← causation: ActionRequested
after a restart that cut a notice off, in the batch that settles it:
ActionResent{of, at} | ResendDropped{reason}   ← causation: the interrupted action
```

Every event carries a teob envelope: `eventId`, `causationId`, `correlationId` (the
instance key), and `origin: "heuristic"`. `GET /api/journal/chain/:eventId` walks a
decision back to the signal that caused it, for example
`ActionSuppressed ← Decided(timer vacant) ← TimerSet ← Decided(signal hallway_occupancy=off) ← obs`.
`haContextId` matches the `context.id` of the resulting `call_service` event in the
`ha-audit` stream. Each audited call carries who made it in `by` (and as its envelope
`origin`): `teob` (Teobeanie's own; the value predates the name, and the panel and MCP
show it as Teobeanie), `person:<name>`, `system:<name>` (the Supervisor, which other add-ons
call as), `user:<id prefix>` when HA would not list its users, or `device` when the call
has no user. Teobeanie recognises its own calls as they arrive: the actuator registers each
call (service and entities) before sending it, and the context id HA returns. Rows
journaled before attribution have no `by` and read as `nodered`.

The kernel also guarantees:
- A `decide` that throws is journaled as `DecideFailed` and does not crash the entity.
- Domain events cannot use kernel tags.
- A timer firing that is stale (re-set or cancelled since) is ignored.
- An action requested before a crash is settled as `ActionCompleted{ok:false, "interrupted by restart"}`.
  A call is never re-fired: the heuristic re-decides device state on start. A notice
  decided within the last `resendWithinMs` (default 10 min, 0 turns it off) is sent once
  more, marked "(resent after a restart)", as `ActionResent`. An older one, one already
  resent, one from a shadow instance, or one `vet()` refuses is `ResendDropped{reason}`.

## Modes and the SafeActuator

| mode | decide | timers | actions |
|---|---|---|---|
| `off` | not called | — | — |
| `shadow` | yes | yes | vetted, journaled as `ActionSuppressed`, never sent (nor resent) |
| `active` | yes | yes | vetted, `ActionRequested`, executed, `ActionCompleted`; a notice a restart cut off is resent once |

The add-on option `shadow_mode: true` (an emergency switch, off by default; always on in
standalone mode) forces every active instance to shadow.

`vet()` runs inside the decision, so the verdict is journaled. It enforces:

- **Scope:** only entities marked `"operate"` in `allowlist.json` (see
  [The house scope](#the-house-scope)).
- **Ownership:** an entity is claimed by exactly one instance. Claims are checked at boot
  and on every reload, and a call to an unclaimed or foreign entity is refused.
- **No `toggle`:** only absolute-state services, which are safe to retry.
- **Bounds:** climate temperature 15–27, light brightness 0–100%, cover position and fan
  percentage 0–100.
- **Hard denies:** a heuristic can declare `forbids`, services that no instance may
  ever call on an entity. `leak-shutoff` forbids reopening its valve.
- **Rate limits:** per entity per hour (default 30), and notifications per instance per
  hour (`notifyPerHour`, default 12). A resent notice counts against it too.
- **Global pause:** the header of the panel pauses every heuristic (`POST api/pause`),
  journaled as `Paused { at, by, reason? }` and `Resumed { at, by }` with the HA user who
  did it, and kept across a restart. While paused every call and notice is refused ("all
  heuristics paused"; instances still decide and journal), except a guard's: the leak
  shutoff still closes the valve and sends its alert.

`execute()` tries a failed call or notice once more after 5 s (`retryAfterMs`): cloud
devices and the chat reject the odd request. An error another try cannot fix (an
unknown service or entity, a malformed request, the chat refusing the request) is not
retried, nor is anything but a guard's while all heuristics are paused. `ActionCompleted` carries the
final answer; an error says "(also after a retry)" when both tries failed.

### Watching itself

The monitor (`src/monitor.ts`) reads every journal batch as it is persisted, from the
same hook that feeds the panel's live stream, plus HA's connection state, and posts to
the Telegram chat:

| Problem | From | Clears |
|---|---|---|
| HA unreachable for `monitor_ha_down_min` minutes | the HA connection | HA back, posted as such |
| A refused action | `ActionRefused`, except a notice's hourly limit and the global pause | the instance's next accepted action on the same target |
| A failed action | `ActionCompleted{ok:false}`, except "interrupted by restart" | the next success on the same target |
| Another automation on Teobeanie's entities | `HaCallServiceObserved` by `system:<name>` on an entity an active instance owns or uses (HA Cloud, which carries voice assistants, counts as a person) | an hour without a recurrence |
| A heuristic throwing | `DecideFailed` | the instance's next `Decided` |
| All heuristics paused | `Paused`, with who and why | `Resumed`, posted with who and after how long |

Any problem also clears after an hour without a recurrence. One message per problem
while it is open, at most 6 an hour in all. The monitor sends through the notifier
directly: no heuristic's `notifyPerHour` holds its messages back, and nothing it sends
is journaled, so it never sees itself.

The daily summary (`monitor_summary_time`) is a query over the journal for the day
up to the summary time, in HA's time zone: per instance its calls, notices, shadow
calls and notices, refusals, failures, errors and a first action ever; each pause and
resume, and a pause that still holds; and the calls by system users and devices on
entities active instances control.

## Testing

`simulate(def, params, world)` runs a heuristic on a virtual clock through the same
`decideStep`/`applyEvent` code the live kernel uses. A package's specs import it from
`"teobeanie/test"` with `describe`, `it` and `expect`; `pnpm test` runs every
`packages/*/*.test.ts` in this repository with vitest, and the Studio runs a file's
tests in the browser:

```ts
const sim = simulate(doorNag, garage, { "binary_sensor.garage_door": "off", "binary_sensor.garage_occupancy": "on" });
sim.set("binary_sensor.garage_door", "on").advance(minutes(9));
expect(sim.calls()).toEqual([]);                 // someone is in the garage
sim.set("binary_sensor.garage_occupancy", "off").advance(minutes(6));
expect(sim.calls()).toEqual([`notify: ${garage.text}`, `notify: ${garage.text}`]);
```

### Replaying history

Before an instance (or a new parameter set) runs anywhere, replay it over the
recorder's history and compare it with what happened to the entities it would own:

```sh
HA_URL=... HA_TOKEN=... node dist/studio/cli.js replay <config folder> sensor-light/stairs \
    [--heuristic sensor-light --params @stairs.json] [--replaces <who>] [--days 7] [--timeline]
```

By default the world is the recorded one, as a shadow instance sees it live. With
`--replaces` (the user another automation calls HA as, as the logbook names it), Teobeanie
drives its own entities: its calls take effect, that automation's recorded switches
are dropped and become what Teobeanie is compared with, and switches by people and devices
still happen. That is the fair comparison for a heuristic that reads its own targets:
in the recorded world it stays quiet wherever the other automation got there first.
The report lists, per entity, the switches both made, the ones only Teobeanie made and the
ones only the other made, with how far each is from its nearest counterpart.

`test/kernel.test.ts` covers the compiled aggregate against teob's mock control:
persist before side effects, timer re-arm on recovery, stale timers, active versus
shadow, and the actuator rules.

## Porting from Node-RED

Lessons from porting a real Node-RED installation:

- **Decide from your own answer, not from echoes.** Node-RED re-sends turn_on on
  every sensor edge. The trigger pattern sends when its own answer changes (on,
  then off after the run-on), so a person who switches a light off is not
  overruled. The parity view counts Node-RED's re-sends to a device already in that
  state as no-ops, not misses.
- **Reconcile from `last_changed` at start.** A room that has been empty since
  before boot is due at `last_changed + delay`, not `boot + delay` (`heldSince`).
- **Check "any" versus "all".** A Node-RED state node over two sensors fires per
  sensor. "Off when one has been vacant for 5 min" is usually a bug for "off when
  all have".
- **Device-targeted calls** carry only `device_id` in the `call_service` audit. The
  panel resolves them through HA (`/api/device-entities`) before matching.
- **Look for dead flows:** nodes without inbound wires, triggers on entities that no
  longer exist, disabled injects. Port the intent, or drop it deliberately.

Keep your own house's inventory (flow → instance → parity notes) next to your
`heuristics.json`, not in this repository.

## Next

1. **Parity in the journal:** the panel already matches shadow calls against the
   `ha-audit` stream ("alex ✓", "n/m calls also made outside Teobeanie"). Make that a server-side projection,
   so agreement is counted over weeks rather than over the loaded window.
2. **Confirmation watch:** `ActuationConfirmed/Unconfirmed` from the entity's state echo.
   `ActionCompleted.ok` only means HA accepted the call.
3. **Mode registry aggregate:** journaled mode changes from the panel, instead of
   editing `heuristics.json` (the global pause already is one).
4. **Telegram commands:** sending works through `telegram_bot_token`/`telegram_chat_id`;
   commands are taken once `telegram_commands` is on (one reader per bot).
5. **Attribute routing in the bridge.** Attribute-only changes are signals for
   enforced entities and the weather entity, fed in by the add-on; the bridge itself
   still compares states. A per-unit write budget for cloud-polled devices (Daikin)
   before any hold there is enforced.
6. **Replay:** feed `signals.db` segments through `simulate()` as a regression gate.
7. **Upstream:** move `kernel/` into teob-ts (`@lambda-house/teob-ts/ha`) once the API
   has settled against real use.

Known limits: inputs that lead to no decision are not journaled, so replaying those
relies on the 30-day `signals.db`. Rate-limit windows are in memory and reset on
restart. Snapshot reads happen at decision time and can be newer than the triggering
signal; `Decided.reads` records what was actually used.
