---
name: explain
description: Answer "why did X happen" (or why it did not) in a Teobeanie house from its journal. Finds the row, walks its causation chain to the signal, timer or command that started it, reads the signals and the timeline around it, tells apart a person, an automation, a device and Teobeanie, and cites the event_id or obs_id of every row the answer rests on. Use when asked why a light, switch, cover, climate unit or notice did or did not do something, who changed something, what happened around an entity or instance, or how a heuristic decides.
---

# Explain what happened

Every decision Teobeanie makes is journaled with its input, its reason, the values it
read and what became of each action. Every change and service call it sees is
recorded with who caused it. "Why did the hall light go off at 21:14?" is a few
queries over that record, not log reading.

All of it is read-only MCP tools of the `teobeanie` server (in Claude Code:
`mcp__teobeanie__<tool>`). Explaining changes nothing.

## Rules

- **Cite the record.** Every claim in the answer carries the `event_id` or `obs_id` of
  the row it rests on. *Why:* the owner can open the same chain in the panel's
  Decisions tab and check it.
- **Say who from `by`, never from a guess.** *Why:* "the automation did it" and "you
  did it from the app" lead to very different fixes.
- **Say what the record cannot tell.** Only the house scope (`allowlist.json`) exists
  for these tools. Signal rows are kept 30 days by default, decisions forever. Inputs
  that led to no decision are not journaled. *Why:* "no row" is not "nothing
  happened".
- **Explain, do not fix.** When the answer points at a change (a param, the scope, an
  automation that fights), hand it to `develop` or `operate`, and ask. *Why:* an
  explanation the owner asked for is not a licence to change their house.
- **House time.** Times in and out are house-local; `whoami` gives the zone.

## The tools

| Tool | Gives |
|---|---|
| `house_state` | Current state, unit, last change, operable or not. Find an entity id by name here. Also the facts (derived state the heuristics read): value, since, what each reads and who reads it |
| `recent_changes` | Changes and service calls in the scope, newest first, each with `by` |
| `timeline` | Around an `entity`, an `instance` or a `fact`, in time order: changes, calls, decisions, fact changes (with why and cause), the pause, config changes, each with its id |
| `decisions` | Teobeanie's decisions: input, `why`, each action with its status |
| `chain` | An event's causation chain back to its origin, and what it caused |
| `signals` | One entity's recorded rows over a range, with `by`, `cause` and `obs_id` |
| `history` | One entity's recorder history, further back than the signals |
| `heuristics` | Instances: mode, params, what each watches, reads and owns, last decision |
| `heuristic_source` | A heuristic's code, from its package or the house's own files |
| `tool_calls` | What agents (this one too) asked the tools |

Ranges take `from` and `to` as `"HH:MM"` (today), `"YYYY-MM-DD HH:MM"` (house time)
or ISO. A page that has more ends with `more`: pass it as `cursor`.

## Method

1. **Pin the question.** Which entity (`house_state` with a `domain`, then match the
   name) and which time. "Last night around nine" becomes a `from` and a `to`.
2. **Find the row.** `timeline` with the `entity` and a range of half an hour around
   the moment. The change in question has an `obs_id` and a `by`.
3. **Read `by`.** It says who:

   | `by` | Who |
   |---|---|
   | `Teobeanie <instance>` | A decision of that instance. Go to step 4 |
   | `person:<name>` | A person through Home Assistant: the app, a dashboard, a voice assistant through HA Cloud |
   | `system:<name>` | A system user. Other add-ons, such as Node-RED, call Home Assistant as `Supervisor` |
   | `user:<id>` | A user whose name the add-on could not read |
   | `automation` | A Home Assistant automation |
   | `device` | No user: the device itself (a wall switch, a bound remote, its own schedule), an integration |

4. **Walk the chain.** `chain` with the decision's or the call's `event_id`. It goes
   from the action back to the `Decided` (its `why`, and `reads`: the values it used),
   to the timer or signal that started it, and ends at the origin: a signal row with
   its `obs_id`, a timer, a command.
5. **Check the input.** `signals` for the sensor in the origin, over the same range:
   what it said, when, and who caused it. An `unavailable` there explains a lot.
6. **Read the logic.** `heuristics` for the instance's params, `heuristic_source` with
   the heuristic id for its code. Quote the few lines that produce the `why`.
7. **Look for edits and the pause.** `config` rows in the timeline ("params changed
   (offAfterMin 3 → 5)") and `pause` rows. A behaviour that changed often changed
   there.

### Why something did not happen

- A decision with a `why` and no action **declined**, and says why ("occupied but
  2176 lx: light enough").
- An action with status `shadow` was decided and **not sent**: the instance is in
  shadow.
- `refused: <reason>` is the SafeActuator saying no; `failed: <error>` is Home
  Assistant's answer. The `operate` skill has the reasons.
- **No decision at all**: the instance did not get an input. Check that the sensor is
  in its `watch` (`heuristics`), that it changed (`signals`), that the instance is not
  `off`, and that it started (a reload that refused it leaves it out).

## The answer

One sentence first, then the chain from cause to effect, one line per row with the
time, what happened, who, and the id. End with what to do, if anything, as a question.

> The hall light went off at 21:14 because the hall had been empty for 5 minutes.
>
> - 21:09:02 `binary_sensor.hall_motion` → off, by `device` (obs `9f3c…`)
> - 21:09:02 `sensor-light/hall` set its run-on timer for 21:14 (event `a41b…`)
> - 21:14:02 the timer fired: "vacant 5 min: off" (event `c7d0…`)
> - 21:14:02 `light.turn_off` on `light.hall`, done (event `e2a8…`)
>
> Someone was reading on the sofa, out of the sensor's view. Want a longer run-on in
> the evening? That is a `develop` change, replayed first.
