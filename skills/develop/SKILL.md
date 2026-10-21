---
name: develop
description: Build or change a Teobeanie behaviour for a house. Pulls the add-on's config folder into a local git working copy, scopes the entities narrowly, adds or edits an instance in shadow mode, runs the package specs and a replay over the last days, pushes the folder back, and confirms the instance decides in shadow. Also for changing a starter package's own code, specs first. Use when asked to add, set up, tune or change a behaviour, an instance, its parameters, the house scope or a package, and after onboard when the owner has picked behaviours.
---

# Develop a behaviour

The loop is always the same: **pull, change, test, push, confirm.** The add-on's config
folder is the project. A local git working copy of it is where changes are made and
undone. The add-on reloads the folder about a second after a push, all or nothing.

What exists today (alpha 0.2): read-only MCP tools, the config folder edited as files,
package specs on the simulator with vitest, and replay with the CLI. MCP tools to edit
and develop behaviours do not exist yet: everything here goes through files and SSH.

## Rules

- **Shadow only.** A new instance goes in with `"mode": "shadow"`. This skill never
  sets `"active"`; that is the `operate` skill, with the owner's yes. *Why:* shadow
  decides and journals without acting, so a mistake costs nothing.
- **Scope narrowly.** `allowlist.json` lists what the behaviour watches and reads.
  `"operate": true` goes only on what it switches. Tell the owner which entities get
  `operate` and why, before the push. Never add `operate` silently, and never to an
  entity no behaviour switches. *Why:* the SafeActuator refuses any call outside
  `operate`. That last gate only protects the house while it is narrow.
- **Ask before every push.** Show `git diff` and say in plain words what the add-on
  will run differently. *Why:* a push changes the running house.
- **Commit before every push.** *Why:* the previous commit is the undo.
- **Pull before you edit.** The panel's editor, mode buttons and Studio write the same
  files. `config-sync.sh push` refuses when the box changed since the last pull; never
  `FORCE=1` over that without telling the owner what would be lost. *Why:* the owner's
  edit in the panel is as real as yours.
- **Never weaken a guard.** `leak-shutoff` forbids reopening its valve and never
  reopens it by itself. Keep both, also in a changed package. *Why:* a valve reopened
  during a leak floods the house.
- **No live tests.** Never call a Home Assistant service to see if something works.
  The simulator, replay and shadow are the tests. *Why:* a test on the real house is
  not a test, it is a change.
- **House data stays private.** The working copy is the owner's, in a private place.
  Nothing from it goes into the Teobeanie clone, its tests, an issue or a pull request.
  *Why:* the public repository never names a real house.
- **The token stays in its file.** Use `HA_TOKEN="$(cat ~/.config/teobeanie/ha-token)"`
  inside the command. Never print it. *Why:* it is an admin token.

## 0. Once: what the loop needs

Ask before installing anything.

1. **SSH to the box.** The owner installs the **Terminal & SSH** add-on and puts their
   public key in its `authorized_keys` option. Check:
   `ssh -o BatchMode=yes root@homeassistant.local true`.
2. **A clone of Teobeanie** for specs, typings and replay, at the add-on's version
   (the add-on's page in Home Assistant shows it):

   ```sh
   git clone https://github.com/teob-cc/teobeanie ~/teobeanie
   cd ~/teobeanie && git checkout v0.2.0   # the add-on's version; main when there is no tag
   pnpm install && pnpm build
   ```

   It needs Node.js 22.18 or later and pnpm (`corepack enable`).
3. **The sync script** is `${CLAUDE_PLUGIN_ROOT}/scripts/config-sync.sh`, or
   `~/teobeanie/scripts/config-sync.sh` in the clone. Its header lists the settings:
   `HA_SSH` (default `root@homeassistant.local`), `SSH_PORT`, `SLUG`.

Below, `SYNC` is that script run by `bash`, `WC` the working copy (ask where;
`~/teobeanie-config` is a fine default) and `TB` the clone.

## 1. Pull into the working copy

```sh
$SYNC pull $WC
git -C $WC add -A && git -C $WC commit -m "As pulled from the add-on"
```

`pull` makes the folder a git repository when it is not one yet, and refuses when it
has uncommitted changes. It brings `heuristics.json`, `allowlist.json`, `tiles.json`,
`teobeanie.lock.json`, `heuristics/` and `packages/`. On a fresh install there is no
`heuristics.json` or `allowlist.json` yet: you write them in steps 2 and 3. A private
remote for the working copy is a good idea; a public one never is.

## 2. Scope: allowlist.json

Add every entity the instance watches or reads. Add `"operate": true` to the ones it
switches, and to nothing else. On a fresh install, start the file:

```json
{
  "policyVersion": 1,
  "entities": [
    { "id": "binary_sensor.hallway_motion" },
    { "id": "light.hallway", "operate": true }
  ]
}
```

A sensor that reports every second gets a calmer route, such as
`"debounce": "deadband", "params": { "deadband": 1 }`. A package that `uses` outdoor
needs `"outdoor": { "temperature": "<entity>", ... }`, with those entities listed too.
`docs/heuristics.md` ("The house scope") has the details.

Say it to the owner like this: "This lets Teobeanie switch `light.hallway`, because
`sensor-light/hallway` turns it on and off. Nothing else may be switched."

## 3. The instance: heuristics.json

Start from the package's `packages/<name>/example.json`. One entry in `instances`:

```json
{ "heuristic": "sensor-light", "id": "hallway", "mode": "shadow",
  "params": { "sensors": ["binary_sensor.hallway_motion"], "lights": ["light.hallway"], "offAfterMin": 3 } }
```

- `id` is kebab-case and unique per heuristic. It names the journal stream: choose it
  once.
- `params` follow the heuristic's parameter schema: the `PARAMS` in its source
  (`packages/<name>/*.ts`, or the `heuristic_source` tool) and the roles table in its
  `README.md`. Leave a param out to get its default.
- `alerts`, `notifyPerHour` and `commandHelp` sit next to `mode`, not inside `params`.
- Two instances may not own one entity. The reload refuses that.

On a fresh install the file is `{ "instances": [ ... ] }`. After step 4,
`"$schema": "./.teob/heuristics.schema.json"` at the top lets an editor check the
instances the way the loader does.

## 4. Typings

```sh
cd $TB && HA_URL=http://homeassistant.local:8123 HA_TOKEN="$(cat ~/.config/teobeanie/ha-token)" \
  node dist/studio/cli.js types $WC
```

It writes `heuristics/ha.d.ts` (the house scope, typed), `.teob/` and a `tsconfig.json`.
Run it again after every scope change. These files are for editors; the push leaves
them out. Put `.teob/` in the working copy's `.gitignore`: it is regenerated every
time.

## 5. Specs

```sh
cd $TB && TEOBEANIE_PACKAGES=$WC/packages pnpm vitest run $WC/packages
```

All green, or no push. The specs are the packages' promises, played out on the
simulator. A red spec in an unchanged starter package means the clone and the add-on
are at different versions: check out the add-on's tag.

## 6. Replay the last days

```sh
cd $TB && HA_URL=http://homeassistant.local:8123 HA_TOKEN="$(cat ~/.config/teobeanie/ha-token)" \
  node dist/studio/cli.js replay $WC sensor-light/hallway --days 3 --timeline
```

Replay reads the recorder's history and the logbook (Home Assistant keeps 10 days by
default) and runs the instance over them. It calls nothing. The report says, per owned
entity: how many calls Teobeanie would have made, how many changes the house saw and
who made them, how many matched, then "Teobeanie only" and "house only" with how far
each is from its nearest counterpart.

- Something else switches these entities today (an automation, Node-RED)? Add
  `--replaces <user>` with the name the logbook gives it (Node-RED calls as
  `Supervisor`). Teobeanie then drives the entities and is compared with that
  automation alone.
- A notice-only heuristic (`door-nag`, `night-leak`) owns no entities, so replay has
  little to compare. Its shadow decisions are its evidence.
- `--params @file.json` tries other numbers without editing the instance.

Explain each "only" row to the owner in plain words. Most differences are on purpose
(Teobeanie does not re-send to a light that is already on; it waits for all sensors).
The ones that are not are a reason to change the params, and replay again.

## 7. Push and confirm

1. Show `git -C $WC diff`, say what changes, ask.
2. `git -C $WC add -A && git -C $WC commit -m "sensor-light/hallway in shadow"`
3. `$SYNC push $WC`

`push` checks that every JSON file parses and that the box did not change since the
last pull. It copies `packages/`, `heuristics/`, `allowlist.json`, `tiles.json` and
`heuristics.json`, never deletes a file on the box, and touches `heuristics.json` so the
file watch reloads. Then it prints the add-on's reload line, such as
`reload (file): +1 −0 ~0 unchanged 2`. A rejected reload prints the reason and exits
with an error: the add-on keeps running the previous config. Fix, commit, push again.

Then confirm over MCP:

- `heuristics`: the instance is there, `mode: shadow`, with what it watches and owns.
- `decisions` with `instance: "sensor-light/hallway"`, `since_min: 30`: its first
  decision, from the `start` input. Shadow actions show as `shadow` (journaled, not
  sent).
- `timeline` with the same `instance`: the config change from the file, then the
  decisions.

Tell the owner where to look (the panel's Decisions tab marks shadow actions as
"would") and when to come back: after a day of real use, the `operate` skill.

## Changing an instance

The same loop: pull, edit `params`, specs, replay with the new params, push. An
**active** instance acts on the new params as soon as the reload is done. Replay first,
say what will change, and ask. Offer to put it back to shadow for a day when the
change is more than a number.

## Changing a starter package

The starter packages in `packages/` are the house's to change. The add-on never
overwrites one that is there. `teobeanie.lock.json` marks a changed one
`"modified": true`, and the panel's library shows it as "changed". From then on the
add-on does not update it either; `"upstream"` in the lock says when a newer version
ships.

1. Read the package's `README.md` (its guarantees) and its specs.
2. **Write the spec for the change first**, in the package's `*.test.ts`. Run it and see
   it fail.
3. Change the code. It imports only from `"teobeanie"`.
4. Run all the package's specs. The old ones must stay green: they are the guarantees
   people rely on. If one has to change, tell the owner exactly which promise changes.
5. Update the `README.md` when the behaviour changes.
6. Replay every instance that uses the package. Push.

A new behaviour rather than a tweak? Make it a package of its own:
`packages/<new-name>/` with its own `teobeanie.json`, a new name and new heuristic ids
(an id defined twice is an error). Its specs run with the same command. The house's
small rules can also be single files in `heuristics/`; the panel's Studio runs their
tests in the browser.
