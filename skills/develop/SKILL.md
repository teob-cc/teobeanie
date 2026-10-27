---
name: develop
description: Build or change a Teobeanie behaviour for a house over Teobeanie's MCP tools. Scopes the entities narrowly, adds or changes an instance in shadow mode, changes package code specs first, runs the specs and a replay over the last days, and confirms the instance decides in shadow; each change is one revision that can be rolled back. Also for a new package, a shadow twin of a running instance, and exporting a package without house data. Use when asked to add, set up, tune or change a behaviour, an instance, its parameters, the house scope or a package, and after onboard when the owner has picked behaviours.
---

# Develop a behaviour

The loop is always the same: **change, test, replay, shadow, confirm.** It runs over
the `teobeanie` MCP tools. Every write is one revision of the add-on's working set,
applied all or nothing: when the add-on rejects a change, the folder stays as it was
and the tool says why. Each answer names its revision and the one to roll back to.

Teobeanie is alpha (0.3). Its MCP tools explore, develop (this skill), operate (the
`operate` skill) and explain. None of them switches a device. Without the tools (an
older add-on, a client that cannot reach them) the config folder is edited as files
over SSH: the fallback at the end.

## Rules

- **Shadow only.** A new instance goes in with `instance_upsert` and `mode: "shadow"`.
  This skill never makes one active; that is the `operate` skill, with the owner's yes.
  *Why:* shadow decides and journals without acting, so a mistake costs nothing.
- **Scope narrowly.** `scope_add` adds what the behaviour watches and reads, observed
  only. An instance that switches an entity needs it operable, and that is
  `scope_operate` with a reason: say which entity, which instance switches it and
  why, get a yes, then call it. Never on an entity no behaviour switches. *Why:* the
  SafeActuator refuses any call outside `operate`. That last gate only protects the
  house while it is narrow.
- **Say it before every write.** Say in plain words what the add-on will run
  differently, and ask. *Why:* a write changes the running house's config at once.
- **Name the way back.** Every write answers with its `revision` and `undo` (a
  `rollback` to the revision before). Tell the owner. *Why:* an undo that is only found
  during a problem is found too late.
- **Specs first.** A change to a package's code starts with a spec that fails. *Why:*
  the specs are the guarantees people rely on.
- **Never weaken a guard.** `leak-shutoff` forbids reopening its valve and never
  reopens it by itself. Keep both, also in a changed package. *Why:* a valve reopened
  during a leak floods the house.
- **No live tests.** Never call a Home Assistant service to see if something works.
  The simulator (`test_run`), `replay` and shadow are the tests. *Why:* a test on the
  real house is not a test, it is a change.
- **House data stays private.** Entity ids, names and places stay in the house's
  config. A package goes anywhere else only through `package_export`, which swaps the
  house's ids for its roles and refuses when the privacy scan finds something. *Why:*
  a house's ids say who lives there and when they are home.

## The tools

| Tool | Does |
|---|---|
| `package_list` | installed packages (origin, changed or not) and the starter set |
| `package_install` | a starter package missing from the folder, or an installed one upgraded to the add-on's version (`upstream` in `package_list`; one the house changed only with `replace_modified`, after showing the owner what it loses) |
| `package_scaffold` | a new package: manifest with roles, code, a passing spec, README, example |
| `file_read` | a working-set file, or the list of them |
| `file_write` | one working-set file, whole (`heuristics.json`, `allowlist.json`, `tiles.json`, `energy.json`, `voice.json`, `heuristics/**`, `packages/**`) |
| `voice_try` | phrases as if said in the chat: what each would run (nothing runs); with expectations, the house's voice eval |
| `types` | `heuristics/ha.d.ts` and `.teob/` for editing code (generated, no revision) |
| `test_run` | specs, per package or file, with vitest's matchers |
| `replay` | an instance over the recorder's last days (at most 7), facts included |
| `scope_add` | an entity into the house scope, observed only |
| `scope_operate` | an entity made operable, with the reason (an operate step: ask first) |
| `instance_upsert` | an instance in shadow or off, or a twin of one (`twinOf`) |
| `package_export` | a package with roles for ids, after the privacy scan |
| `revisions` | the working set's revisions, newest first |

## 1. Scope

For each entity the instance watches or reads: `scope_add` with `entity`. On a fresh
install there is no `allowlist.json` yet: the first `scope_add` writes it.

The entities it switches need `operate`. Say it like this: "This lets Teobeanie switch
`light.hallway`, because `sensor-light/hallway` turns it on and off. Nothing else may be
switched." On a yes, `scope_operate` with `entity` and that `reason`. It is journaled
with it.

A sensor that reports every second gets a calmer route
(`"debounce": "deadband", "params": { "deadband": 1 }`), and a package that `uses`
outdoor needs `"outdoor": { "temperature": "<entity>", … }`: `file_read` and then
`file_write` of `allowlist.json` for those. `file_write` refuses to add `operate`.

## 2. The instance

Read the package's `README.md` (its roles and guarantees) and `example.json` (`file_read`
with `path: "packages/<name>/example.json"`, or `heuristic_source` with the package
name). Then `instance_upsert` with `heuristic: "sensor-light"`, `id: "hallway"`,
`mode: "shadow"` and the `params`.

- `id` is kebab-case and unique per heuristic. It names the journal stream: choose it
  once.
- `params` follow the heuristic's schema; leave one out for its default. The tool checks
  them as the panel does and says which field is wrong.
- `alerts`, `notifyPerHour` and `commandHelp` sit next to `mode`.
- Two instances may not own one entity. The reload refuses that, and nothing changes.

## 3. Specs

`test_run` with `package: "<name>"`. All green, or no next step. Each failing spec comes
with its message. The specs are the package's promises, played out on the simulator.

## 4. Replay the last days

`replay` with `instance: "sensor-light/hallway"` and `days: 7` reads the recorder's
history and the logbook and runs the instance over them, with the facts it reads. It
calls nothing. Per owned entity: how many calls Teobeanie would have made, how many
changes the house saw and who made them, how many matched, then "Teobeanie only" and
"house only" with how far each is from its nearest counterpart (`report`).

- Something else switches these entities today (an automation, Node-RED)? Pass the
  name the logbook gives it as `replaces` (Node-RED calls as `Supervisor`).
  Teobeanie then drives the entities and is compared with that one alone.
- A notice-only heuristic (`door-nag`, `night-leak`) owns no entities, so replay has
  little to compare. Its shadow decisions are its evidence.
- `params` tries other numbers without changing the instance.

Explain each "only" row in plain words. Most differences are on purpose (Teobeanie does
not re-send to a light that is already on; it waits for all sensors). The ones that are
not are a reason to change the params, and replay again.

## 5. Confirm in shadow

- `heuristics`: the instance is there, `mode: shadow`, with what it watches and owns.
- `decisions` with `instance: "sensor-light/hallway"`, `since_min: 30`: its first
  decision, from the `start` input. Shadow actions show as `shadow`.
- `timeline` with the same `instance`: the config change (by `mcp:<you>`), then the
  decisions.

Tell the owner where to look (the panel's Decisions tab marks shadow actions as
"would") and when to come back: after a day of real use, the `operate` skill.

## Changing an instance

In shadow: the same loop, `instance_upsert` with the new params, specs, replay.

An **active** instance is never changed in place: `instance_upsert` refuses. Run the
change beside it as a twin: `instance_upsert` with `id: "hallway-next"`,
`twinOf: "sensor-light/hallway"` and the new `params`. The twin decides on the same
inputs, in shadow. After a day, `twin_compare` with `key: "sensor-light/hallway"` shows
where they differ, and `promote` (the `operate` skill) swaps them in one revision.

## Changing a package's code

The packages in `packages/` are the house's to change. The add-on never overwrites
one; the lock marks a changed starter package `modified`.

1. `file_read` the package's `README.md`, its code and its specs.
2. Write the spec for the change first (`file_write` the `*.test.ts`), `test_run`, and
   see it fail.
3. Change the code (`file_write`). It imports only from `"teobeanie"`. `types` writes
   the typings when an editor needs them.
4. `test_run` the whole package. The old specs stay green: they are the guarantees. If
   one has to change, tell the owner exactly which promise changes.
5. Update the `README.md`. `replay` every instance that uses the package.

A code change applies to every instance of the package at once, active ones too. For
an active instance, copy the package under a new name with new heuristic ids (an id
defined twice is an error) and run it as a twin.

## A new package

`package_scaffold` with `name` and `pattern` writes a skeleton that loads and whose
spec passes (`kind: "rule"` for a rule). Change it specs first, as above. To share it,
`package_export` with `name`: the files with the roles' placeholders in the example, or
the privacy hits to fix first. Never copy a package out of the house any other way.

## A command for voice

A voice message reaches only the commands `voice.json` lists, and each only through its
heuristic's `commandSchema`: the arguments typed (a choice, a number with its range, a
duration). Give a command a schema that is exactly what its `decide` accepts, with the
range from the house's bounds (`boundFor(house, entity, field)`), so the check before a
call and the behaviour agree. Then, with `voice.json` in `shadow`: `voice_try` with the
phrases people really say and what each must become, until they all pass. Listing a
command in `voice.json` is the owner's call, like going active.

## Fallback: the config folder over SSH

Use it when the add-on has no develop tools, or when the owner keeps the config in git
on their machine. The add-on journals what a push changes as a revision by `file`.

Once, and ask before each:

1. **SSH:** the **Terminal & SSH** add-on with the owner's public key;
   `ssh -o BatchMode=yes root@homeassistant.local true` succeeds.
2. **A clone** of Teobeanie at the add-on's version, built (`pnpm install && pnpm
   build`), with Node.js 22.18 or later and pnpm. Below: `TB`.
3. **A Home Assistant token**, for `types` and `replay` on the command line: a
   long-lived token of an administrator in `~/.config/teobeanie/ha-token` ("The command
   line needs a Home Assistant token" in `docs/getting-started.md`). Use it inside the
   command, `HA_TOKEN="$(cat ~/.config/teobeanie/ha-token)"`; never print it. *Why:* it
   is an admin token.
4. **The sync script:** `${CLAUDE_PLUGIN_ROOT}/scripts/config-sync.sh` (below: `SYNC`)
   and a working copy (below: `WC`, a private git repository).

The loop, under the same rules as above:

1. `$SYNC pull $WC`, and commit what came.
2. Edit the files.
3. Specs: `cd $TB && TEOBEANIE_PACKAGES=$WC/packages pnpm vitest run $WC/packages`.
4. Typings: `cd $TB && HA_URL=http://homeassistant.local:8123 HA_TOKEN="$(cat ~/.config/teobeanie/ha-token)" node dist/studio/cli.js types $WC`.
5. Replay, with the same `HA_URL` and `HA_TOKEN`:
   `node dist/studio/cli.js replay $WC <heuristic>/<id> --days 7` (`--replaces Supervisor`
   to compare with Node-RED).
6. Show `git diff`, ask, commit, `$SYNC push $WC`.

`push` refuses when the box changed since the last pull; never `FORCE=1` over that
without telling the owner what would be lost. A rejected reload prints the reason, and
the add-on keeps running the previous config.
