---
name: operate
description: Run Teobeanie behaviours in a house with the owner's consent, over Teobeanie's MCP tools. Takes one shadow instance active only after the owner has seen its specs, its replay and at least a day of its shadow decisions and says yes, naming the rollback revision first; puts an instance back to shadow; rolls back a revision; promotes a shadow twin; covers the global pause, commands, and what to do when an action is refused or fails. Use when asked to activate, enable, go live, switch an instance to active or back to shadow, roll back, promote, pause or resume, send a behaviour a command, or when the panel or the chat reports a refused or failed action.
---

# Operate behaviours

An active instance switches real things in a house where people live. So going active
is the owner's decision, one instance at a time, from evidence they have seen. The
agent prepares the evidence, names the way back, makes the one change, and watches
the first real uses.

It runs over the `teobeanie` MCP tools. The operate tools are marked destructive, so
the client asks the person before each call. Every change is one revision of the
working set, journaled with `mcp:<you>`. The add-on checks too: `instance_mode` refuses
`active` unless the instance's specs pass now and it decided in shadow within the last
24 hours, and a guard leaves `active` only with a reason. The skill's rules come first;
the platform's checks are the floor under them.

## Rules

- **Active only on the owner's yes.** Before asking, they have seen: the specs green,
  the replay report, and at least a day of the instance's shadow decisions. A yes is
  for one instance; the next one needs its own. *Why:* the owner lives with what it
  does, so the decision is theirs, from evidence.
- **Name the rollback revision before the change.** Say which revision the house goes
  back to (`revisions`, the newest) and how (`rollback`, or the instance back to
  shadow). *Why:* a way back that is only found during a problem is found too late.
- **One change per step.** Going active is the one `instance_mode` call, nothing else.
  *Why:* one change has one undo, and the timeline shows exactly what changed.
- **`override_reason` is the owner's, never yours.** Use it only when the owner, told
  exactly which check fails and why it matters, says to go ahead anyway; put their words
  in it. *Why:* it skips the platform's last check, and it is journaled as theirs.
- **Never pause or weaken a guard.** Do not put `leak-shutoff` into shadow or off, do
  not edit its forbids, and do not use the pause as a way around it, unless the owner
  asks for exactly that. *Why:* a guard acts even through the global pause, because a
  leak does not wait for anyone.
- **Never widen `operate` silently.** Going active needs no scope change. If it seems
  to, stop: `scope_operate` is asked for on its own, with the entity, the instance and
  the reason. *Why:* scope is the last gate the SafeActuator checks.
- **Options are the owner's.** The `shadow_mode` option and Home Assistant's own
  automations are changed by the owner, never by the agent. *Why:* they affect every
  behaviour at once.
- **Report what changed.** The instance, its mode before and after, the revision, the
  rollback, and its first real action. *Why:* the owner should never have to find out
  from the house.

## The tools

| Tool | Does |
|---|---|
| `instance_mode` | an instance's mode: off, shadow or active (checked) |
| `scope_operate` | an entity made operable, with the reason |
| `revisions` | the working set's revisions, newest first, with who and what |
| `revision_diff` | what changed between two revisions, per file |
| `rollback` | the working set put back to a revision (itself a revision) |
| `twin_compare` | a shadow twin against its original, input by input |
| `promote` | a twin swapped in for its original, in one revision |
| `pause` | every call and notice stopped, guards excepted |
| `resume` | behaviours act again |
| `command` | a behaviour's named command, with you as the sender |

## 1. Gather the evidence

For the instance `<key>` (such as `sensor-light/hallway`):

1. **Specs:** `test_run` with the instance's `package`.
2. **Replay** over the days since it went into shadow: `replay` with `instance: "<key>"`
   and `days` (at most 7).
3. **Shadow decisions:** `decisions` with `instance: "<key>"`, `since_min: 1440` (or
   longer), `actions_only: true`. Each row says what it would have done, why, and
   `shadow` as the outcome. `timeline` with the same instance and a range puts them
   between the house's own changes and calls, with who made each.
4. **Agreement:** for each would-action, did the house do the same (a person, an
   automation) shortly before or after? `timeline` shows both sides. The panel's
   Decisions tab marks agreement with a green tick.

Sum it up for the owner in a few lines, with the `event_id`s: how many would-actions,
at what times, how many the house agreed with, and every surprise explained. Then ask
one question: "Make `<key>` active? It will switch `<entities>`. To undo: back to
shadow, or `rollback` to revision `<n>`."

Not enough evidence is a valid answer. Less than a day, or a path that never ran (no
one came home after dark), means wait. Say which path is still unseen.

## 2. Go active

1. `revisions` with `limit: 1`: the newest revision is the rollback target. Say it.
2. `instance_mode` with `key: "<key>"` and `mode: "active"`. The answer has its
   `revision`, the `checks` it ran (specs, the last shadow decision) and the `rollback`.
3. `heuristics`: the instance shows `mode: active`.

A refusal says which check failed. Tell the owner, and go back to gathering evidence
(a red spec is a `develop` fix; no shadow decision means wait). Use `override_reason`
only as the rules say.

If the answer says it `runs: shadow`, the add-on's `shadow_mode` emergency switch is
on and forces every instance to shadow. Turning it off is the owner's step: the
add-on's Configuration tab, then a restart. Before they do, list every instance whose
`configured_mode` is `active` (`heuristics`): they all start acting at that moment. Any
the owner has not said yes to go back to shadow first.

When something else already switches the same entities (an automation, Node-RED), the
owner disables that one in the same minutes, or the two fight. The monitor posts to the
chat when a system user keeps calling an entity an active instance owns. For Node-RED,
the `nodered-migration` skill does this flow by flow.

## 3. Watch the first real uses

`decisions` with the instance and `actions_only: true`: each action now ends `sent`,
`done`, `refused` (with the reason) or `failed` (with the error). Report the first real
use of each path: the light on, the run-on ending, the night case. A path that behaves
differently from its shadow decisions is a reason to go back to shadow and look.

## 4. Undo

Name these before the change, and use the one that fits:

- **This instance, quickly:** `instance_mode` with `mode: "shadow"`. No checks: going
  back is always allowed (a guard aside).
- **The whole change, or several:** `rollback` with `n`, the revision named before.
  `revision_diff` with `a` and `b` shows what it will put back. A rollback is itself a
  revision, so it can be undone the same way.
- **Everything at once:** the pause (section 6).

## 5. A twin, promoted

A change to an active instance runs first as its shadow twin (the `develop` skill).
`twin_compare` with the twin's or the original's `key`: how many inputs both decided
on, how many the same, and each difference with what each side would have done. Show
it like replay's report. On the owner's yes, `promote` with the twin's `key`: the twin
takes the original's id and mode in one revision, and `rollback` undoes it.

## 6. The global pause

`pause` with a `reason` stops every call and notice of every instance, except a guard's.
Instances still decide and journal, and every action they would take is refused with
`all heuristics paused`. It is journaled with who paused and why, survives a restart,
and the panel's header shows it. `resume` ends it.

Pause when the owner asks to stop everything now, and say that guards still act.
Resume only on the owner's word. `heuristics` shows, per instance, since when and by
whom it is paused.

## 7. Commands

`command` with `name` and `args` sends a behaviour's named command (the ones
`heuristics` lists), as the chat would, with you as the sender. The behaviour decides,
and may act: a garage door opens. Send one only when the owner asks for that command.

## 8. A refused or failed action

`decisions` shows a refused action with its reason, and `chain` on its `event_id`
shows what led to it.

| Reason | Means | Do |
|---|---|---|
| `all heuristics paused` | The pause is on | Expected. Resume on the owner's word |
| `<entity> is outside the house's operation scope` | No `"operate": true` on it | A scope change: `scope_operate`, shown and asked |
| `<entity> is owned by <other>` / `is not claimed by <key>` | Another instance owns it | Fix the instances, not the gate: `develop` |
| A guard's forbid reason (reopening the valve) | Forbidden for everyone | By design. Never work around it |
| `… outside 15–27 for <entity>` and other bounds | A param outside the safe bounds | Fix the param |
| `rate limit: <entity> already actuated 30× in the last hour` | Something flaps | Find why with `timeline`; fix the cause |
| `notification rate limit (<n>/h)` | Too many notices | Find why; raise `notifyPerHour` rather than lower it when the notices are real |
| `toggle is banned` | The code asked for `toggle` | Fix the package: absolute states only |

A failed action (`ActionCompleted` not ok) carries the error from Home Assistant: an
unavailable device, a cloud rejection. A call is tried once more after 5 seconds; an
error that says "also after a retry" failed twice. Check the device's state with
`house_state`, and tell the owner.

## Fallback: without the operate tools

On an add-on without them, the mode is one value in `heuristics.json`, pushed from the
working copy (the `develop` skill's fallback), or set with the mode buttons in the
panel; the pause is the button in the panel's header; a rollback is the panel's
Heuristics tab or `git revert` and a push. The rules above stay the same.
