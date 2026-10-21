# Changing what the house does: the config folder

This guide is for the people of the house. You do not need to program. You edit a
few small text files, save, and a second later Teobeanie follows. If a change is
wrong, it says so and keeps doing what it did before.

## The config folder

Everything that is ours, as opposed to Teobeanie's own code, lives in one folder: the
config folder. In Home Assistant it is the add-on's config folder
(`addon_configs/…_teobeanie`, visible in the Samba or Studio Code Server add-ons).
`teobeanie init <folder>` writes a fresh one with examples, if you want to start
over or keep a copy elsewhere:

```sh
node dist/studio/cli.js init ~/our-house
```

It refuses a folder that already has files in it, unless you add `--force`.

```
heuristics.json     what runs
allowlist.json      what Teobeanie may see, and what it may switch
tiles.json          how the House tab looks
packages/           the behaviours Teobeanie can run, one folder each
teobeanie.lock.json where each package came from, and whether we changed it
heuristics/         rules of our own, as code (optional)
README.md           a short note to whoever opens the folder
```

`heuristics/ha.d.ts`, `.teob/` and `tsconfig.json` are for code editors. Leave them
alone.

### packages/: the behaviours

Each folder in `packages/` is one behaviour: motion lights, door reminders, the
garage door, the leak guard. Teobeanie puts the starter set there when it starts,
and `init` does too. Each has a `README.md` that says what it does and what it
promises, and an `example.json` with one instance to copy.

They are ours to change. Teobeanie never overwrites a package that is there: an
update of the add-on only adds the packages we do not have yet. A package we
changed is marked "changed" in the library, and `teobeanie.lock.json` says
`"modified": true`. A package we deleted stays deleted, unless `heuristics.json` still
uses it: then it comes back on the next start.

Keep the folder in git. Then every change is a few lines you can read, and every
mistake can be undone (see [Undoing a change](#undoing-a-change)).

## The three files

### allowlist.json: what Teobeanie knows about

```json
{
  "entities": [
    { "id": "binary_sensor.hallway_motion" },
    { "id": "light.hallway", "operate": true }
  ]
}
```

One line per thing in the house. A thing that is not listed does not exist for
Teobeanie: it cannot read it and cannot switch it. `"operate": true` lets Teobeanie
switch it; without that it only watches. To let a rule control a new light, add the
light here first, with `"operate": true`.

Two of the choices are worth knowing:

- Give a sensor that reports every second (power, say) a calmer line, such as
  `"debounce": "deadband"`, so that it is not logged on every flicker.
- `outdoor` names the weather, temperature and humidity sensors that rules use for
  "is it dark / cold outside".

### heuristics.json: what runs

```json
{
  "instances": [
    { "heuristic": "sensor-light", "id": "hallway", "mode": "shadow",
      "params": { "sensors": ["binary_sensor.hallway_motion"],
                  "lights": ["light.hallway"], "offAfterMin": 3 } }
  ]
}
```

Each entry is an **instance**: one use of a ready-made pattern (a *heuristic*, here
"light from a motion sensor") with our sensors and numbers.

| Field | Means |
|---|---|
| `heuristic` | Which pattern. The list is in [heuristics.md](heuristics.md) |
| `id` | Our name for this use. It appears in the panel, the log and Telegram. Lower case, no spaces |
| `mode` | `off`, `shadow` or `active` (below) |
| `params` | The pattern's settings: which sensors, which lights, how many minutes |
| `alerts` | Optional. `true` also sends this instance's notices to the alerts chat |
| `notifyPerHour` | Optional. The most notices this instance may send in an hour |

Two instances of the same pattern are independent: one hallway, one stairs. Two
instances may not switch the same thing. Teobeanie refuses that, because they would
fight.

### tiles.json: the House tab

The pinned tiles at the top of the House tab, nicer names, and which section a thing
belongs to. It changes only what you see, never what the house does. See
[house.md](house.md).

## Modes: off, shadow, active

| Mode | What it does |
|---|---|
| `off` | Nothing. The instance is kept in the file but does not run |
| `shadow` | Watches and decides, writes down what it would do, and does **not** do it |
| `active` | Does it |

Use **shadow** every time something is new: a new instance, new numbers, a rule you
changed. Leave it a few days. In the Decisions tab each card says what it would have
done and why. If an old automation still runs, the card shows both side by side,
with a green tick when they agree. When the decisions look right, change `"shadow"`
to `"active"`. If it ever misbehaves, change it back. Nothing else is needed.

The add-on also has a `shadow_mode` option that forces everything into shadow. While
it is on, `"active"` in the file has no effect. Switch it off when you want your
active instances to act.

## Notices

Some instances send messages (the front door is still open, there is a leak). Four
settings shape them:

- **Alerts.** `"alerts": true` on an instance also copies its notices to the alerts
  chat, the one for watching the house. Everything else goes to the main chat only.
- **Notification cap.** `"notifyPerHour": 6` next to `mode` (not inside `params`)
  limits the instance to 6 notices an hour. Without it the pattern's own cap holds
  (usually 12). A cap that is too low silences a real warning, so raise it rather
  than lower it when in doubt.
- **Texts.** The words are ours to change. Some patterns have one `text` in `params`:
  `"text": "The front door is still open."`. Others have several messages and take a
  `texts` object: `"texts": { "opening": "Going up" }` replaces that one message and
  keeps the rest.
- **The pause.** The header of the panel has a pause button. While paused, Teobeanie
  decides and writes it down but switches nothing and sends nothing, except
  safety guards such as the leak shutoff. It is journaled with who paused and when,
  and survives a restart. Press it again to resume.

## Adding an instance of a ready-made pattern

The panel does this without a text editor.

1. Open the **Heuristics** tab and switch to **Library**. Each card is one pattern:
   what it does, what it promises (for example "a light switched off by hand stays
   off until the room has been empty for the run-on"), its settings with their units
   and defaults, and how many of it we already run.
2. Press **Add an instance**. A form opens with an id (our name for it, such as
   `back-door`), the mode (shadow, to start with) and the pattern's settings.
3. Fill in the settings. The ones the pattern needs are at the top. The optional ones
   are folded away under **Optional**, each showing its default in grey: that is what
   the pattern uses when we leave it empty. An entity field offers the things in
   `allowlist.json` of the right kind as we type, with their names, and says when one
   is not there or may not be switched. A message shows its default text and the
   `{slots}` it fills in, such as `{door}` or `{min}`.
4. Anything wrong is said in red under its field while we type, and the button stays
   grey until it is fixed.
5. Press **Add instance** and confirm. Teobeanie writes the line into
   `heuristics.json`, reloads, and the Heuristics tab says what changed. If the
   reload refuses it (a light that another instance already switches, a light
   without `"operate": true`), nothing is written, and the form says why.

Watch the Decisions tab for a few days. Then set it to active, with the mode buttons
on the instance's page.

**Changing one.** Click the instance, then **Edit…**. It is the same form. Saving
changes only the values we changed: the rest of `heuristics.json`, our own layout and
any notes we left in it, stays as we wrote it. **Remove…** takes the line out; what
the instance did stays in the journal. The id cannot be changed: remove the instance
and add it again under the new name (its history then starts afresh).

**Notices.** The alerts flag, the notification cap and the lines in the bot's menu are
under **Notices and the bot's menu** in the same form.

**Our own patterns** (rules in `heuristics/`) are in the library too, marked "yours".
When a rule does not describe its settings, the form takes them as a block of JSON,
and the reload says whether they work.

**The packages are read-only in the panel.** "Source · copy to config" opens one in
the Studio's Editor; **Copy to edit** there makes a copy of our own in `heuristics/`
under a new name. Once it is saved and reloaded, it is in the library as ours. To
change a package itself, edit its files in `packages/` (in git, as everything else).

Every change made in the panel is journaled with our name, for example
"door-nag/back: params changed (everyMin 5 → 10)", and shows in the timeline.

By hand it is the same thing, in a text editor:

1. Find the pattern in [heuristics.md](heuristics.md) and copy its example line into
   `heuristics.json`, inside `instances`. Mind the commas between entries.
2. Give it a new `id` and `"mode": "shadow"`.
3. Replace the entity ids with ours (Developer tools, States in Home Assistant).
4. Make sure every entity is in `allowlist.json`, and every one it should switch has
   `"operate": true`.
5. Save. Watch the Decisions tab for a few days. Then set `"active"`.

## When a change takes effect

Teobeanie reads the three files again a second after the last save, and the
`heuristics/` and `packages/` folders with them. There is no restart. Only the instances you changed
are stopped and started again; everything else keeps running with its timers.

If something is wrong, **nothing changes**: the old set keeps running, and the
reason is shown on the Heuristics tab (and in the add-on log). Typical reasons: a
comma missing in the JSON, an unknown pattern name, an entity that is not in
`allowlist.json`, two instances switching the same light. Fix the file and save
again; it is checked again the same way. The Heuristics tab has a **Reload config**
button for when you want to ask for it by hand.

The add-on's own options (the chats, `shadow_mode`) are not in these files and need a
restart of the add-on.

## Undoing a change

- **In git:** `git diff` shows what changed since the last commit, `git restore
  heuristics.json` puts the file back, and `git log -p heuristics.json` shows every
  earlier version. Save, and the house follows.
- **In the journal:** every change to the working set is recorded next to the
  decisions it affected, for example "the run-on was changed from 5 to 10 min". The
  timeline shows these between the decisions before and after, so you can see which
  edit changed the behaviour, and type the old value back.

The quickest undo for a misbehaving instance is not to edit numbers but to set its
mode to `shadow`, or to press the pause.

## A rule of our own

When no ready-made pattern fits, a rule is a small file in `heuristics/`. It does not
say "when this happens, do that". It says what a thing should be, given the house:
the hallway light should be on when there is motion at night, and off two minutes
after the last motion. Teobeanie works out the timers and the calls, and only acts
when the answer changes, so a light you switch by hand is not fought.

Start from `heuristics/night-light.ts` in the starter, copy it under a new name, and
add a line to `heuristics.json` with `"heuristic": "<the rule's id>"` and
`"params": {}`. Next to it is `night-light.test.ts`: a test that plays out a night
(motion at 23:30, nothing for three minutes) and checks the calls. In the panel's
Studio → Editor you can edit the file and run the test before you save. How rules and tests
are written is in [heuristics.md](heuristics.md), "Your own heuristics, as code".
