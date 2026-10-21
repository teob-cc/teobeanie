---
name: nodered-migration
description: Move a Home Assistant house's automations from Node-RED to Teobeanie heuristics, flow by flow, with shadow, replay, a per-flow cut-over and a watched first day. Use when asked to port, migrate or take over Node-RED flows (lights, appliances, climate, relays, buttons, notifications, a Telegram bot), to check what still runs on Node-RED, or to roll a cut-over back.
---

# Node-RED → Teobeanie migration

The goal is not to translate nodes. It is to find the **intent** of each flow, express it
as a heuristic instance (a pattern with parameters), prove it would have done the same
or better on the house's own history, and only then move control over: one flow at a
time, reversibly, watched.

Background: `${CLAUDE_PLUGIN_ROOT}/docs/heuristics.md` (patterns, rules, modes, replay,
"Porting from Node-RED"). Teobeanie's side goes through its MCP tools: the scope, the
instance in shadow, the specs and the replay as in the `develop` skill, going active
as in the `operate` skill. Node-RED's side goes through the two scripts of this skill,
in `${CLAUDE_PLUGIN_ROOT}/skills/nodered-migration/scripts/` (below: `NR`).

The scripts talk to Home Assistant itself, so they need a Home Assistant token: a
long-lived token of an administrator in `~/.config/teobeanie/ha-token` ("The command
line needs a Home Assistant token" in `docs/getting-started.md`). Ask the owner for it
when you get to step 1. They read `HA_URL` and `HA_TOKEN`; pass the token from its file
inside the command, `HA_TOKEN="$(cat ~/.config/teobeanie/ha-token)"`, never print it.

## Ground rules

- **Privacy.** Entity ids, people's names, chat ids, routines, Node-RED node ids and the
  inventory belong in the private working copy (next to `heuristics.json`), never in
  the public Teobeanie repository. Tests and examples there use made-up names.
- **Ask before touching Node-RED.** Name the exact node ids to disable and what they do;
  wait for a yes per batch. Never delete nodes during a migration — disable.
- **Scope before the instance:** the reload refuses an instance that watches or
  switches an entity outside the scope, and nothing changes. `scope_add` (and, on the
  owner's yes, `scope_operate`) first, then `instance_upsert`.
- **Keep everything reversible:** every flow has a written rollback (instance back to
  shadow + the node ids to re-enable).

## 1. Inventory: what still acts

```sh
node $NR/nodered.mjs effects          # every acting node: LIVE / dead / off, with its triggers
node $NR/nodered.mjs trace <node id>  # where its input comes from, everything it feeds
```

For each LIVE effect write one row in the private inventory: flow → intended behaviour →
Teobeanie pattern + instance → parity notes → node ids to disable → rollback.

Look hard at:
- **Shared triggers.** One "room is empty" node often feeds several flows (lights *and*
  an appliance). Trace downstream before planning to disable anything upstream.
- **Dead flows.** No inbound wire, triggers on entities that no longer exist (renamed
  after a re-pair), disabled injects. Port the intent deliberately or drop it, and say so.
- **Device-targeted calls** (`deviceId`, no entity): resolve to entities first.
- **Bare data that HA ignores** (e.g. `"100"` as JSONata data): Node-RED never actually
  set it; don't "preserve" it.

## 2. Map intent to a pattern

| Node-RED shape | Teobeanie |
|---|---|
| sensor on → light on, off after N min | `sensor-light` (trigger) |
| demand on → device on, off N min after | `follow-with-run-on` |
| off after a room is empty, keep-on window, scheduled on | `appliance-auto-off` |
| set a value whenever a device drifts | rule with `enforce` (+ `yieldToUsers`) — e.g. `climate-guard` |
| relay press → release after 1 s | `relay-pulse` |
| button event → cover position / switch | `button-cover`, `button` (MQTT triggers need no HA entity) |
| "still open" reminders, visitor/lingering notices | `door-nag`, `sustained-notice` |
| leak → close valve + alert | `leak-shutoff` (never reopens automatically) |
| chat command → check, act, confirm | command pattern, e.g. `garage-door` |

Use the user's migration to fix what Node-RED got wrong, and write each difference into
the parity notes: decide from Teobeanie's own answer rather than re-sending on every edge;
"all sensors quiet" rather than "any"; people win (a light switched off by hand stays
off for that visit; a person's setpoint stands until the next run); reconcile at start
from `last_changed` (`heldSince`), not from boot.

## 3. Scope and shadow

`scope_add` for each entity the instance watches or reads; `scope_operate` with the
reason for each it switches, after the owner's yes. Then `instance_upsert` with
`mode: "shadow"`, and `test_run` for its package. A house package of its own starts
with `package_scaffold`, specs first (the `develop` skill). The add-on option
`shadow_mode` (an emergency switch, default false) forces every instance to shadow
regardless of the file; if it is on, the owner turns it off before an instance can act.

Shadow journals `ActionSuppressed` rows: what Teobeanie would have done. New parameters
get a spec with `simulate()` first (made-up entity names).

## 4. Prove parity on history

`replay` with `instance: "<heuristic>/<id>"`, `days: 7` and `replaces: "Supervisor"`.

- Node-RED calls HA as the system user **Supervisor**. `replaces: "Supervisor"` drops its
  recorded switches and lets Teobeanie drive, then compares: both / only Teobeanie / only Node-RED.
- Live shadow is **blind** for a heuristic that reads its own targets: Node-RED switches
  first, so Teobeanie sees the light already on and stays quiet. Judge those by replay, use
  live shadow only for runtime health.
- Explain every "Teobeanie only" / "house only" (Node-RED) row before cutting over; most are
  improvements (no re-sends, both-sensors rule) — write them down.

## 5. Cut over one flow

1. Get the user's OK for the exact node ids.
2. Disable the **effect** nodes (the call-service / sender), not shared triggers:
   `node $NR/nodered.mjs disable <id>...` (backs the flows up, deploys only those
   nodes, reads them back). Same seconds:
3. `instance_mode` with the instance's `key` and `mode: "active"` (the `operate` skill:
   the rollback revision named first, one instance per step, the `shadow_mode` switch
   must be off). Its specs must pass and it must have decided in shadow within the last
   day, or the add-on refuses.
4. Start a watcher and keep it running for at least a day:
   `node $NR/cutover-watch.mjs <heuristic>/<id> <entities...> >> cutover.log`
   It prints Teobeanie's decisions and calls, state changes with who made them (Teobeanie, a
   person, a device, a system user) and **ALERT** lines for: a system user (Node-RED,
   another add-on) calling an owned entity, refused or failed actions. The add-on's
   monitor (`monitor_alerts`, on with a Telegram chat) posts the same alerts to the
   chat by itself; the watcher adds the per-event detail.
5. Record the time, node ids and rollback in the private inventory.

Rollback: `instance_mode` with `mode: "shadow"`, then `node $NR/nodered.mjs enable <ids>`.

## 6. Watch the first real uses

A cut-over is done only after each path has run for real at least once: the morning
schedule, the run-on ending, a button press each way, the night case. Report each
first use to the user (time, what happened, ok). Typical findings and their fixes:

- **Attribution.** Teobeanie and Node-RED both call HA as Supervisor, and the HA audit can't
  tell them apart; Teobeanie's own calls are known by `ActionCompleted.haContextId`. A call
  from a person's own user is theirs, never Node-RED's — check `haUserId` before
  raising an alarm.
- **Gaps between switches.** A device switched by something else during a run-on, or
  switched on in an already empty room, must still get the full run-on and be switched
  off later; add a test for each case found live, then fix.
- **No-op calls.** Don't send `turn_off` to something already off.
- **Restarts.** An add-on update or restart takes it away for about 30 s (a config push
  does not restart it). Timers persist; anything due during the gap fires at start.
  Update outside scheduled moments (not at 07:00 when something switches on at
  07:00).
- **Devices with their own schedules** (cloud air conditioners) fight an enforced
  setpoint; find and remove the device-side schedule rather than out-writing it.

## 7. Messaging and chat commands go last, together

A Telegram bot has one update stream: only one consumer may poll `getUpdates`. Teobeanie can
send through the same bot while Node-RED still owns it (send-only notifier), but chat
**commands** move all at once:

1. Shadow-compare every notifier instance (door nags, notices, leak) against what
   Node-RED sent (`ActionSuppressed` texts vs. the chat).
2. Give the add-on the bot token and chat id (the user enters them in the add-on
   configuration — never copy secrets through chat or logs).
3. In one step: stop Node-RED's bot from polling (disable its command nodes and set the
   bot config to send-only, or disable all its Telegram nodes), activate Teobeanie's
   receiver and the notifier/command instances.
4. Test each command once with the user; check replies and confirmations.

The leak shutoff closes a main valve: test its path with the user present, and keep
"never reopen automatically".

## 8. Clean up

After several clean days: delete the disabled Node-RED nodes and the triggers that no
longer feed anything (`effects` / `trace` show them), keep the flows backup, and mark
the inventory rows done. Then Node-RED itself can be stopped.
