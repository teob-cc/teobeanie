# The House view

The House tab is the panel's first tab. It shows every entity in the house scope,
grouped into sections, each with a summary on top and the entities below it, and the
cards of the running heuristic instances. It updates in place while Home Assistant's
states change. Nothing on it calls a service directly: a card's buttons run an
instance's command, and the instance decides.

## What it shows

On top, a row of what needs a look: alarms that are on (leak, smoke, gas, CO,
problem sensors), doors and windows that are open and for how long, low batteries,
and how many entities are not reporting. Below it the pinned tiles (`tiles` in
`tiles.json`), the instances' cards, then one section per aspect of the house:

| Section | Summary on top |
|---|---|
| Energy | Power flow between solar, the house and the grid; today's imported, exported and solar kWh and gas; the devices using power now; the grid's carbon intensity |
| Doors & windows | Open against closed; what is open and since when; locks; covers with their position; alarm panels |
| Lights & switches | How many are on, per area; which ones, with brightness; light level sensors |
| Climate | Thermostats (reading, setpoint, mode, action) and room temperatures on one scale, with humidity; CO₂ against good / fair / poor bands; heating and ventilation |
| Outdoor | Temperature and condition, humidity, pressure, a wind compass, the sun's position and its next rise or set |
| Presence | Who is home and since when; which occupancy sensors detect someone |
| Safety & water | Alarms that are on; how many leak, smoke and problem sensors watch and whether all report; valves; water meters |
| Other | Everything else in scope, grouped by domain |

A section collapses with a click on its header; the one-line summary stays visible.
"All N entities" opens the section's entities, each with its value and how long ago
it changed, grouped:

1. by the group `tiles.json` gives the entity, if any (marked "group");
2. else by area: the entity's own area in Home Assistant (marked "area"), else its
   device's (marked "device area");
3. else by device, when the device has several entities in the section;
4. else by kind, for what no area holds: people, trackers, weather, the sun, outdoor
   readings, the grid, solar, prices and Home Assistant's helpers and automations;
5. everything else in one compact "No area" group per section, by kind, the first
   few shown. Assigning areas to those entities or their devices in Home Assistant,
   or a group in `tiles.json`, moves them out of it.

The lights summary counts per area the same way (the entity's area, its device's,
its configured group's). Click an entity for
its last 6 hours from the signal ring (allowlisted entities only). The browser
remembers which sections you closed.

Today's energy totals come from the sources of Home Assistant's energy dashboard, as
far as they are in the house scope, summed from the recorder's hourly statistics
since midnight.

## Instance cards

Each active or shadow instance whose heuristic has a `view` shows a card: its title,
a chip saying active or shadow, its values (with how long each has held) and its
buttons, and a link to its decisions in the Studio. A button runs the instance's
command as the HA user of the panel session (`POST api/command`, through ingress
only), journaled like a Telegram command; a button with a confirm text asks first.
The instance's reply goes where its replies always go (the chat). How a heuristic
declares its card: [heuristics.md, Cards](heuristics.md#cards).

## Which entities

With an `allowlist.json`, the entities it lists. Without one, everything Home
Assistant has, except entities it hides or marks as diagnostic or configuration.

## How entities are grouped

The grouping is generic: it reads each entity's domain, `device_class` and unit,
Home Assistant's areas and devices, and a few generic English words in the name
(`keywords` below adds a house's own). A door
contact is a door, a `power` sensor on the device of the energy dashboard's grid
meter is grid import (or export, when its name says "returned" or "export"), a
temperature named "outdoor" belongs outdoors, a temperature on a device with one
temperature sensor is that room's. A device's loose readings follow its main entity:
the airflow sensors of a ventilation unit sit with the fan in Climate. An
integration without devices is grouped by name: "Heat pump Flow temperature" goes
with the fan "Heat pump".

## Adjusting it: `groups` in tiles.json

Whatever the generic rules get wrong for your house goes into `tiles.json` in the
config folder, next to the `tiles`. Both keys are optional. A saved change shows on
the next load of the House view; no restart.

```json
{
  "tiles": [ { "entityId": "sensor.indoor_co2", "label": "CO₂ indoor", "kind": "co2" } ],
  "groups": {
    "order": ["climate", "energy", "garden"],
    "sections": {
      "garden": { "title": "Garden" },
      "security": { "title": "Doors" },
      "other": { "hidden": true },
      "presence": { "collapsed": true }
    },
    "entities": {
      "switch.garden_lights": { "section": "garden" },
      "sensor.heat_pump_*": { "section": "climate", "group": "Heat pump" },
      "sensor.p1_power": { "role": "grid_import" },
      "sensor.*_debug_*": { "hidden": true },
      "sensor.den_co2": { "name": "CO₂ den" }
    },
    "pin": ["sensor.den_co2"],
    "keywords": { "outdoor": ["yard"], "grid": ["smart meter"] }
  }
}
```

| Key | Meaning |
|---|---|
| `order` | Section ids in the order to show them; the others follow in their default order |
| `sections.<id>` | `title` renames, `hidden: true` leaves it out, `collapsed: true` starts it closed. A new id declares a section of your own |
| `entities.<id or pattern>` | `section`, `group` (a group title), `name`, `role`, `hidden: true`. `*` matches any run of characters; an exact id wins over a pattern, patterns apply in file order |
| `pin` | Entities added to the pinned row, after the tiles |
| `keywords.<test>` | Words added to a name test's generic English defaults, for names in another language or of a particular meter or brand. Tests: `outdoor` (an outdoor reading), `room` (a room's reading), `garage` (a door contact that is a garage or overhead door), `equipment` (never a room's: setpoints, flow, appliances), `solar`, `grid` (power at the grid connection), `export` (power to the grid). A word matches at the start of a word in the entity id or name, in any script; a space also matches no space |

The defaults hold only generic English ("outdoor", "outside", "exterior"; "room", "indoor", "inside"). A house's room and place words, such as its kitchen or garden, come from
`keywords`; `examples/starter/tiles.json` shows the shape. Without a `tiles.json` the
House view has no pinned tiles and groups by Home Assistant's areas, devices and
domains, as described above. An existing `tiles.json` loads unchanged; `keywords.garage`
is the only addition to the schema.

An entity's `group` also stands in for its area when Home Assistant has none for the
entity or its device: the lights summary counts it there.

The built-in sections are `energy`, `security`, `lights`, `climate`, `outdoor`,
`presence`, `safety` and `other`. A role says what an entity is for the summaries:

| Section | Roles |
|---|---|
| energy | `grid_import`, `grid_export`, `solar`, `power` (a consumer), `energy` (a meter), `gas`, `carbon_intensity`, `electrical`, `price` |
| security | `door`, `window`, `garage_door`, `lock`, `cover`, `alarm` |
| lights | `light`, `switch`, `illuminance` |
| climate | `thermostat`, `ventilation`, `heating`, `room_temperature`, `room_humidity`, `co2`, `air_quality`, `temperature`, `humidity` |
| outdoor | `weather`, `outdoor_temperature`, `outdoor_humidity`, `outdoor_illuminance`, `wind`, `sun` |
| presence | `person`, `tracker`, `occupancy` |
| safety | `leak`, `smoke`, `gas_alarm`, `co_alarm`, `problem`, `valve`, `water` |
| other | `battery` |

A power tile labelled "Grid import", "Grid export" or "Solar" sets that role too, so
an existing `tiles.json` keeps its meaning. The outdoor summary prefers the sources
named under `outdoor` in `allowlist.json`.

## API

- `GET api/house`: the sections with their groups (each with `by`: `group`, `area`,
  `device`, `kind` or `none`), the pinned ids, the tiles, and every entity with its
  section, group, role, area and `areaSource` (`entity`, `device` or `group`), device
  and current state. Areas and devices come from Home Assistant's registries
  (`config/entity_registry/list_for_display`, `config/device_registry/list`,
  `config/area_registry/list`), cached for 10 minutes and read again after a
  reconnect or a registry update event. `cards`: per active or shadow instance
  with a view, `{ key, heuristic, id, mode, card?: { title, fields, buttons? }, error? }`.
- `GET api/house/energy-today`: today's totals per kind (`grid_import`,
  `grid_export`, `solar`, `gas`, `water`).
- The SSE stream `api/stream` carries `house` frames: `{ at, states: { <id>: { state,
  attributes, changedAt, updatedAt } }, cards? }`, the states that changed in the
  last second, and every card again when any changed (an instance's state moved, or
  an entity changed), sent only while a panel is connected. The panel reloads
  `api/house` when the stream reconnects.
