# Examples

Each directory here is a complete **config folder**, laid out the way Teobeanie
reads it. In the add-on that folder is `addon_configs/…_teobeanie` (Samba / Studio
Code Server); standalone it is `CONFIG_DIR` (default `./.dev-data`). The add-on copies
this `examples/` directory into the config folder on first start.

```
<config folder>/
  heuristics.json      which heuristics run, on which entities, in which mode
  packages/<name>/     the behaviour packages: the starter set, added on start, and your own
  teobeanie.lock.json  where each package came from (written by the add-on)
  heuristics/*.ts      optional: your own rules and heuristics, as code (.ts, .js or .mjs)
  allowlist.json       the house scope: entities Teobeanie sees, and ("operate") may act on
  tiles.json           optional: the House view's pinned tiles and grouping (docs/house.md)
```

| Example | Shows |
|---|---|
| [`starter/`](starter) | One instance of most starter packages: motion lights (including stairs with two sensors, and a porch light that only switches on in the dark), door reminders, a visitor notice, leak shutoff, a circulation pump with run-on, coffee-machine auto-off with a morning keep-on window and an MQTT remote, a thermostat setpoint applied when heating starts, a garage door opened and closed by command through a momentary relay, a blinds remote, and the outdoor sources. |
| [`rules/`](rules) | Desired-state rules in TypeScript: a hallway light that is dimmer at night and switches off 5 minutes after the last motion, and a circulation pump with a 20-minute run-on. |
| [`custom-heuristic/`](custom-heuristic) | A heuristic written as code in the config folder: "the washing machine is done", detected from its power draw, used for two appliances. |

`starter/` is what `node dist/studio/cli.js init <folder>` writes (plus typings for its
placeholder ids, which init generates, and the starter packages from
[`packages/`](../packages), which init installs as the add-on does); a test keeps the
two equal. None of these folders holds a `packages/`: the add-on adds the starter set
on start. It also holds a
README for the people of the house and a sample rule with its test. Their guide is
[docs/working-set.md](../docs/working-set.md).

To start: run `init` into a new folder, or copy a starter's files up into the config folder, replace the entity ids
with yours (Developer tools → States) and delete what you don't need. The add-on
picks the files up as they are saved. Everything runs in **shadow** until you set `"mode": "active"` on an instance
and turn off the add-on's `shadow_mode` option.

Keep your real configuration in your own (private) place, for example a private git
repository that you copy into the config folder. Your entity ids, names and routines
don't belong in this repository.
