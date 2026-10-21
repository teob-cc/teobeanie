---
name: operate
description: Run Teobeanie behaviours in a house with the owner's consent. Takes one shadow instance active only after the owner has seen its specs, its replay and at least a day of its shadow decisions and says yes; puts an instance back to shadow; covers the global pause and what to do when an action is refused or fails. Use when asked to activate, enable, go live, switch an instance to active or back to shadow, roll back, pause or resume, or when the panel or the chat reports a refused or failed action.
---

# Operate behaviours

An active instance switches real things in a house where people live. So going active
is the owner's decision, one instance at a time, from evidence they have seen. The
agent prepares the evidence, makes the one-line change, names the way back, and
watches the first real uses.

What exists today (alpha 0.2): the mode is one value in `heuristics.json`, pushed from
the working copy (the `develop` skill's loop), or set with the mode buttons in the
panel. The global pause is a button in the panel's header. The MCP tools are
read-only: the agent cannot press either button, and that is on purpose. `SYNC`, `WC`
and `TB` below are the sync script, the working copy and the Teobeanie clone, set up
as in the `develop` skill.

## Rules

- **Active only on the owner's yes.** Before asking, they have seen: the specs green,
  the replay report, and at least a day of the instance's shadow decisions. A yes is
  for one instance; the next one needs its own. *Why:* the owner lives with what it
  does, so the decision is theirs, from evidence.
- **One change per push.** Going active changes the one `"mode"` value, nothing else.
  *Why:* one change has one undo, and the timeline shows exactly what changed.
- **Name the undo before the change.** *Why:* a way back that is only found during a
  problem is found too late.
- **Never pause or weaken a guard.** Do not put `leak-shutoff` into shadow or off, do
  not edit its forbids, and do not suggest the pause as a way around it, unless the
  owner asks for exactly that. *Why:* a guard acts even through the global pause,
  because a leak does not wait for anyone.
- **Never widen `operate` silently.** Going active needs no scope change. If it seems
  to, stop: that is a `develop` change, shown and asked for on its own. *Why:* scope is
  the last gate the SafeActuator checks.
- **Options and buttons are the owner's.** The `shadow_mode` option, the pause and Home
  Assistant's own automations are changed by the owner, never by the agent. *Why:*
  they affect every behaviour at once.
- **Report what changed.** The instance, its mode before and after, the commit, the
  reload line and its first real action. *Why:* the owner should never have to find
  out from the house.

## 1. Gather the evidence

For the instance `<key>` (such as `sensor-light/hallway`):

1. **Specs**: run them again (the `develop` skill, step 5).
2. **Replay** over the days since it went into shadow (`develop`, step 6).
3. **Shadow decisions**: `decisions` with `instance: "<key>"`, `since_min: 1440` (or
   longer), `actions_only: true`. Each row says what it would have done, why, and
   `shadow` as the outcome. `timeline` with the same instance and a range puts them
   between the house's own changes and calls, with who made each.
4. **Agreement**: for each would-action, did the house do the same (a person, an
   automation) shortly before or after? `timeline` shows both sides. The panel's
   Decisions tab marks agreement with a green tick.

Sum it up for the owner in a few lines, with the `event_id`s: how many would-actions,
at what times, how many the house agreed with, and every surprise explained. Then ask
one question: "Make `<key>` active? It will switch `<entities>`. To undo, …".

Not enough evidence is a valid answer. Less than a day, or a path that never ran (no
one came home after dark), means wait. Say which path is still unseen.

## 2. Go active

1. `$SYNC pull $WC`, and the working copy is clean.
2. Change `"mode": "shadow"` to `"mode": "active"` on that one instance. Show the diff.
3. `git -C $WC commit -am "<key>: active, on the owner's yes"`
4. `$SYNC push $WC`. The reload line says `~1 (mode)`.
5. `heuristics`: the instance shows `mode: active`.

If it still shows `mode: shadow` with `configured_mode: active`, the add-on's
`shadow_mode` option is on (it is by default) and forces every instance to shadow.
Turning it off is the owner's step: the add-on's Configuration tab, then a restart.
Before they do, list every instance whose `configured_mode` is `active`: they all
start acting at that moment. Any the owner has not said yes to go back to shadow
first.

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

- **This instance, quickly:** its mode buttons in the panel (Heuristics tab, the
  instance), or `"mode": "shadow"` pushed from the working copy. The panel's change is
  journaled with the owner's name; pull afterwards so the working copy is in step.
- **The whole change:** `git -C $WC revert <commit>` and push. The previous commit goes
  back to the box.
- **Everything at once:** the pause (next section).

## 5. The global pause

The pause button in the panel's header stops every call and notice of every instance,
except a guard's. Instances still decide and journal, and every action they would take
is refused with `all heuristics paused`. It is journaled with who paused and why, and
survives a restart. The same button resumes.

The agent cannot pause. When something misbehaves and the owner wants it to stop now,
say where the button is. `heuristics` shows, per instance, since when and by whom it is
paused.

## 6. A refused or failed action

`decisions` shows a refused action with its reason, and `chain` on its `event_id`
shows what led to it.

| Reason | Means | Do |
|---|---|---|
| `all heuristics paused` | The pause is on | Expected. Resume is the owner's |
| `<entity> is outside the house's operation scope` | No `"operate": true` on it | A scope change: `develop`, shown and asked |
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
