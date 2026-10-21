# Architecture: how Teobeanie is put together

Teobeanie is a Home Assistant add-on that runs a house's automations as small,
journaled deciders and keeps the record of everything it saw, decided and did. This
document is the map: what runs where, what is stored, how a decision becomes a service
call, what the outside world connects to, and which parts are the permanent scaffolding
versus the house's own working set. It ends with the design for the two things being
built next: separating that working set so people can view and edit it, and the agent
that reads the same record to make judgements.

Companion documents: [heuristics.md](heuristics.md) is the programming model in depth
(rules, deciders, the journal grammar, modes, testing, replay), [house.md](house.md) the
House view, [deploy.md](deploy.md) how a deploy works. Nothing in this repository names a
real house: entity ids, people, chats and routines live in each house's config folder.

## The shape

```
                    Home Assistant (websocket, ingress)
      state_changed │ triggers │ call_service events │ call_service ▲
                    ▼          ▼                     ▼               │
   ┌──────────── bridge ────────┐          ha-audit: who called   SafeActuator
   │ live cache (every entity)  │          what, when, by whom      │ scope, ownership,
   │ routes → signals.db (30 d) │                 │                 │ bounds, rate, retry
   └──────┬───────────┬─────────┘                 │                 │
          │ signals   │                           │          actions│
          ▼           ▼                           ▼                 │
   heuristic instances ── one in-memory runtime each ── journal.db ─┴─ notices ─▶ Telegram
   (decide → why, events, actions, timers)      │                      main chat · alerts chat
                                                 ▼                      commands ◀ getUpdates
                              projections (views.db) · read API · SSE
                                                 │
                     panel (House · Decisions · Heuristics · Studio · Calls)
                     MCP tools (read · develop · operate; agent port or ingress) · monitor · agent
```

Everything is wired in `src/main.ts`, in numbered steps: config and allowlist; HA
client, notifier, SafeActuator and heuristic host; the stream bus; the sqlite runtime
and audit aggregates; the monitor; the signal store; projections; the call_service
audit; the bridge and attribute signals; Telegram commands; the House service; the read
API; the reloader; the HTTP server with the MCP endpoint, and the agent port. SIGTERM
stops them in reverse.

## 1. Setup

### Running as an add-on

The add-on (packaging in `teobeanie/`, slug `teobeanie`) talks to HA over
`ws://supervisor/core/websocket` with the Supervisor token, and is reached through HA
ingress on port 8099: the panel, the read API and the MCP endpoint all sit behind it.
A second port, 8199 (`ports` in `config.yaml`, the agent port), serves the same MCP
endpoint and nothing else, to agents with a token (section 5). It declares
`homeassistant_api`, `hassio_api` and `ingress`; of the Supervisor REST API it reads
only `addons/self/info`, for the agent port's host port; the deploy scripts do the
rest. Two folders matter:

| Folder | Holds | In HA backups |
|---|---|---|
| `/data` | `journal.db`, `signals.db`, `views.db`, `options.json`, `agent-tokens.json` (names and salted hashes), `revisions/` (the working set's revisions) | yes, except `signals.db` |
| `/config` (`addon_configs/<slug>`) | `heuristics.json`, `allowlist.json`, `tiles.json`, `teobeanie.lock.json`, `heuristics/`, `packages/` — the working set; `teobeanie-move/` the exports for moving to another install ([moving.md](moving.md)) | yes |

Standalone (for development, or HA Container): `HA_WS_URL`, `HA_TOKEN`, `DATA_DIR`
(default `.dev-data`), `CONFIG_DIR`; shadow mode is forced on.

### Options

| Option | Default | Used by |
|---|---|---|
| `shadow_mode` | `false` | emergency switch: when on, forces every instance to shadow |
| `telegram_bot_token`, `telegram_chat_id` | — | the notifier and the command lane |
| `telegram_alerts_chat_id` | — | copies of notices of instances marked `"alerts": true` |
| `telegram_commands` | `false` | long-poll the bot for `/commands` (one reader per bot) |
| `monitor_alerts`, `monitor_ha_down_min`, `monitor_summary_time` | `true`, 5, off | self-monitoring |
| `time_zone` | HA's | the house's zone: rules' `between`, replay, the House view's "today", the MCP tools, the monitor |
| `signal_retention_days` | 30 | the signal store sweep |
| `mcp_networks` | the private LAN ranges and Tailscale | the networks an MCP client may come from through ingress (the agent port is token-only); `MCP_NETWORKS` (comma-separated) overrides it |
| `log_level` | `info` | |
| `llm_provider`, `openrouter_api_key`, `openrouter_model`, `ollama_url`, `llm_monthly_budget_usd` | `none`, —, a default model, —, 10 | declared for the agent; nothing reads them yet (section 7) |

Options need a restart. The three config files reload live: a change is picked up a
second after the last write (or on `POST api/reload`), applied all or nothing, and the
running set is untouched when the new config is rejected.

### Deploying

A code deploy stamps the version `<config version>-<git sha>` and asks the Supervisor
for an *update*, which builds the new image while the old one keeps running and swaps
them in about a second; a *rebuild* would stop first (`docs/deploy.md`). Installed from
the repository, the Supervisor pulls the prebuilt image named by `image:` in
`config.yaml`. CI type-checks, tests and lints on every push, and on a version tag builds
the amd64 and aarch64 images and pushes them to GHCR.

## 2. State

### Three stores and a cache

| Store | What | Written by | Kept |
|---|---|---|---|
| **live cache** (memory) | the current state of every HA entity | the bridge, from `get_states` and `state_changed` | — |
| **signals.db** | one row per routed state change: raw HA state, normalized value, HA context, origin (`ha`, `resync`, baseline) | the bridge, only for entities in the allowlist or watched by an instance, after the route's debounce (`on-change`, `deadband`, `throttle-ema`, `slow-context`) | `signal_retention_days` |
| **journal.db** | every decision and its consequences; the audit of every `call_service` HA saw; every MCP tool call | the heuristic runtimes, the audit aggregate, the MCP wrapper | forever |
| **views.db** | projections over the journal (today one: the newest 200 calls with who made them) | the projection runner, nudged on every persist | rebuildable |
| **facts** (memory, from the journal) | each fact's value, since and `held`/`within` bookkeeping | the host, on a change of what a fact reads, on time, at start | folded from `teob-fact/<id>` at boot |

The cache is read at decision time, so a heuristic sees the house as it is now; the
signals store is history for the panel, the MCP tools and replay; the journal is the
record that lets an instance be rebuilt after a restart and lets anyone ask why. The
facts (section 3) are the state aggregate made explicit: derived values with a since,
kept in memory, journaled only when a value changes.

### The journal

The journal is one SQLite database (teob-ts sqlite runtime) of streams. Category = the
heuristic id, entity = the instance id, so `door-nag/front` is one stream; `ha-audit`
and `mcp-audit` are two more. One decision is one atomic batch. Every event carries an
envelope: `eventId`, `origin` (`heuristic`, `ha`, `mcp`, and the historical `nodered`),
`correlationId` = the instance key, `causationId` = what caused it (the signal's
`obsId`, the fired timer's id, the action's id; domain and action events point back to
their `Decided`).

What the kernel writes, per instance:

| Event | Meaning |
|---|---|
| `Decided { input, why, reads, mode }` | what came in, the reasoning, every entity value read, in which mode |
| `DecideFailed { input, error }` | the heuristic threw |
| `TimerSet`, `TimerCancelled` | the instance's timers (re-armed on recovery) |
| `ActionRequested { actionId, action, at }` | sent in active mode |
| `ActionSuppressed` | shadow mode: decided, journaled, never sent |
| `ActionRefused { reason }` | the SafeActuator said no |
| `ActionCompleted { ok, error?, haContextId? }` | what HA (or the chat) answered; the HA context id ties the call to its audit row |
| `ActionResent`, `ResendDropped` | a notice a restart cut off, sent once more or not, and why |

Rules add `DesiredChanged`, `Reasserted`, `Yielded`, `Tracked` (the `held`/`within`
bookkeeping) and `UnwatchedRead`; the packages' heuristics add their own domain events
(`Opened`, `Nagged`, `Pressed`, `Arrived`, `LeakDetected`, …). The audit stream holds
`HaCallServiceObserved { domain, service, entityIds, serviceData, haContextId, haUserId,
by }`; the MCP stream `ToolCalled { tool, args, caller, ok, ms, revision? }` (the revision a write tool made); `teob-control/pause`
the global pause, `Paused { at, by, reason? }` and `Resumed { at, by }`, folded at boot;
`teob-config/working-set` the working set's edits, `ConfigChanged { at, file, by, summary,
instances? }` (section 6, item 3); `teob-access/agent-tokens` the agent tokens,
`AgentTokenMinted { at, id, name, by }` and `AgentTokenRevoked { at, id, by }` (the
hashes are in `/data/agent-tokens.json`, never in the journal); `teob-move/install` a
move to another install, `InstallExported { at, by, folder, events, lastPosition, signals }`
and `InstallImported { at, folder, version, createdAt, events, lastPosition }`
([moving.md](moving.md)); `teob-fact/<id>` one
stream per fact (correlation `fact/<id>`).

What the host writes, per fact:

| Event | Meaning |
|---|---|
| `FactChanged { fact, value, since, inputs, why?, input }` | the value changed: what it read, the conditions it found, what made it re-evaluate (`signal`, `time`, `fact`, `start`); causation: the signal's `obsId`, the event that began a hold, or the `FactChanged` of a fact it reads |
| `FactTracked { fact, set, clear }` | its `held`/`within` bookkeeping moved without a new value |

`Decided` carries `facts`, the facts the decision read, next to `reads`.

What is persisted per instance is the heuristic's own state, its timers, and its
pending actions (rules: the desired value per entity, when it was last sent, which a
user overrode, the condition tracking). What lives only in memory: rate-limit windows,
the registry of the add-on's own outgoing calls, the HA user list, the registry caches,
when each agent token was last used, the failed attempts on the agent port.

### Recovery

Each fact's stream is folded when the host attaches to the journal, so its value and
since are known before anything starts; the start evaluates every fact again (a value
that changed while the add-on was down gets the boot time as its since) before the
instances get their `start`.

Each instance runs in its own small in-memory runtime over the shared journal. At boot
(and after a reload that changed it) the runtime replays the stream, re-arms every
timer, and settles every action that was still pending when the process stopped: calls
are marked interrupted and never re-fired; a notice less than ten minutes old is sent
once more, marked as a resend. Then a `start` input lets the heuristic reconcile with
the house as it is: a room empty since before the restart is due at `last_changed +
delay`, not `boot + delay`. A `Wake` reaches every instance every two minutes so a
crashed one recovers.

### Reading it back

`api/journal` (by category, entity, cursor, since, causation, correlation),
`api/journal/chain/:eventId` (the causation chain), `api/signals/:entity` (since,
until), `api/timeline` (below), `api/facts`, `api/views/*`, and the MCP tools `decisions`,
`recent_changes`, `history`, `chain`, `signals`, `timeline`, `tool_calls`. The panel's
Decisions tab, the monitor and the agent all read the same rows.

`src/mcp/timeline.ts` reads the record back for both the tools and the panel. `chain`
walks an event's causation ids; a call Teobeanie made continues through its HA context
into the `ActionRequested` whose `ActionCompleted` carries that context, and a decision
a signal started ends at that signal row (the `origin`). `signals` is an entity's rows
over a range with who caused each. `timeline` (for an entity: its changes, the calls on
it, the decisions of the instances that watch, read or own it; for an instance: its
decisions and what it watches and owns) merges those with the pause and the config
changes in time order (and, for an entity, an instance or a fact, `timeline?fact=<id>`,
the `FactChanged` rows of the facts concerned); every row carries its `event_id` or `obs_id`, and a page ends
with a `more` cursor. Config changes are read from the `teob-config` stream as
`ConfigChanged` (section 6, item 3); one that names the instances it touched shows only
in their timelines (and those of the entities they watch, read or own), one without
(a scope change, a row from before the field) in every timeline. The House tab's entity
rows show the same timeline.

## 3. Deciders

### Two ways to write one

A **rule** says what the house should look like and lets the kernel work out the calls:

```ts
rule("hall-light", ({ ha, held }) =>
  ha.light.hall.to(ha.binary_sensor.hall_motion.is("on") ? "on"
    : held(() => ha.binary_sensor.hall_motion.is("off"), minutes(5)) ? "off" : keep));
```

A rule reads typed entities (`ha.domain.object`, generated from the house scope),
`held`/`within` for time, `between` for the clock, `sun` and `outdoor`. It acts only
when its own answer changes, so a person who switched a light off is not overruled; with
`enforce` it also sets back a device that drifts, and with `yieldToUsers` it leaves a
change a user made through HA alone until its answer changes. It compiles to a decider:
the watched entities come from the source and a probe evaluation, the owned ones from
the `.to()` targets, and the kernel maps a desired value to the right service
(`turn_on`, `set_temperature`, `open_cover`, `select_option`, …).

A **decider** (`defineHeuristic`) is the explicit form: `decide(state, input, ctx)`
returns `{ why, events, actions, timers }`, `evolve(state, event)` folds the events. It
is what the starter packages use for anything with its own steps: a countdown with an
announcement, a command with a confirmation, a relay that releases itself.

A **fact** (`fact()`, `kernel/fact.ts`) is the third thing a file can export: derived
state with a value and a since, written like a rule but returning a value instead of
desired states. The host plans the facts with the instances (unique names, no cycle,
in scope), evaluates them ahead of the instances on each signal and on their own
timer, and journals a change in `teob-fact/<id>`. A rule reads `ha.facts.<name>`, a
decider `ctx.fact(id)` with the fact declared in `facts`; a change is a `fact` input.

Both declare what they touch: `watch`, `reads`, `facts`, `actuates` (the ownership claim),
`shares` (others may use it too), `uses`, `commands` (and `commandArg`, the argument it
answers for when several instances share a command; `commandHelp`, its line in the
bot's menu; `commandButtons`, what a chat keyboard offers for it), `triggers` (HA time or MQTT
triggers), `forbids`. The host checks every declaration against the house scope before
an instance starts, and two owners of one entity is an error.

### Inputs

| kind | from | carries |
|---|---|---|
| `start` | the first HA snapshot, or a reload | reconcile with the current world |
| `signal` | a watched entity changed (bridge, on change; attribute-only changes for enforced entities and the weather) | entity, value, state, `obsId`, origin, the HA user who caused it |
| `timer` | a timer the instance set | id, data |
| `fact` | a fact it declares changed its value | fact, value, since, the `FactChanged` event id |
| `trigger` | a declared HA trigger fired (time, sun, MQTT topic) | id, HA variables |
| `command` | the Telegram command lane (later the panel or the agent) | name, args, who sent it and through which channel |
| `outcome` | an action finished | action id, ok, error, HA context id |

### Patterns

The starter packages group heuristics by the control pattern they implement. The label
is metadata (the panel chip, the `heuristics` tool); nothing branches on it.

| Pattern | Shape | Starter packages |
|---|---|---|
| trigger | on when a sensor says so, off after a run-on; people win in between | `sensor-light`, `occupancy-light`, `follow-with-run-on`, `appliance-auto-off` |
| hold | keep a device at a value while a condition holds | `hold`, `climate-guard` |
| momentary | a relay that must be released after a press | `relay-pulse` |
| button | a press maps to a state or position | `button`, `button-cover` |
| command | a named command checks, acts, confirms | `garage-door` |
| notice | tell people, never act | `door-nag`, `sustained-notice`, `night-leak`, `shower-summary` |
| guard | a safety action on a sensor, with a hard deny on the reverse | `leak-shutoff` |

What each one guarantees for the people in the house is in `docs/heuristics.md` and in
the file headers; the short version: a light switched by hand is left alone until the
room empties, a person's setpoint stands until the next run, a relay is released whoever
pressed it, the water valve is never reopened automatically, a cloud unit's stale report
is not a new run, an unavailable sensor is never evidence of an empty room.

### Instances

An instance is a line in `heuristics.json`: `{ heuristic, id, mode, params, alerts, notifyPerHour, commandHelp }`.
`mode` is `off`, `shadow` (decides and journals, never acts) or `active`; `alerts` sends
its notices to the alerts chat as well; `notifyPerHour` sets the instance's cap on notices (default: the heuristic's); `commandHelp` (`{ "garage_open": "Open the shed" }`) its commands' lines in the bot's menu. Instances of the same heuristic are independent
streams. Parameters are the heuristic's: sensors and lights and a run-on for a
`sensor-light`, setpoints and a longest run for a `climate-guard`, a door and a text and
a cadence for a `door-nag`.

### Packages and your own code

The image carries the kernel and the SDK (the `"teobeanie"` module) and no heuristics.
Every behaviour is a **package** in the config folder: `packages/<name>/` with a
`teobeanie.json` (name, version, platform range, pattern, and per heuristic its roles
and uses), the code, its specs, a README and an example instance. A role is an entity
parameter with hints for Home Assistant's registry (domain, device class, several,
optional, switched), checked against the parameter schema when the package loads. The
starter packages (`packages/` in this repository) are copied into the config folder on
start where they are missing, never over one that is there, and recorded in
`teobeanie.lock.json` with their origin, version and hash; one the house changed is
marked modified. The details are in `docs/heuristics.md`.

A house also adds heuristics as files in `/config/heuristics/` that import from
`"teobeanie"` (the old name `"teob"` still works) and default-export a rule, a decider
or an array of them. TypeScript runs as-is. `cli.js types <config folder>` generates
`heuristics/ha.d.ts` from the house scope, so a rule type-checks against the real
entities and `.to()` compiles only for operable ones. The panel's Studio edits these
files with the same types, runs their tests in a web worker against the simulator, and
saves them; a saved file runs after a reload. Tests use `simulate()`: set states,
advance time, fire triggers and commands, and assert on the calls and the `why`s. The
`test_run` MCP tool runs the same specs inside the add-on, with vitest's matchers. Replay
(`cli.js replay`, and the `replay` MCP tool) runs a heuristic over the recorder's last
days, with the facts it reads evaluated over the same history, and compares what it
would have done with what happened, optionally taking over from a named automation.

## 4. Effects

A decision's actions are of two kinds: `call { service, entities, data }` and `notify {
text }`. Every one goes through the SafeActuator, whose verdict is part of the decision
and therefore journaled.

**Vetting**, in order: not paused (a guard, `leak-shutoff`, acts through the pause); a notice within the instance's `notifyPerHour`; a
well-formed service; never `toggle`; a target; for each entity, in the operation scope
(`"operate": true` in `allowlist.json`), owned by this instance or shared with it, not
forbidden (`leak-shutoff` forbids reopening its valve for everyone), within bounds
(climate 15–27 °C, brightness, position and fan percentage 0–100); and under 30 calls
per entity per hour. In shadow mode the vetted action is journaled as suppressed; in
active mode it is requested and executed.

**Executing**: a call registers itself with the own-calls registry before it is sent,
so the audit of HA's `call_service` event can recognise it as the add-on's own (by HA
context id, or by a matching pending request within five seconds). A failure that
another try could fix (a cloud rejection, a timeout) is tried once more after five
seconds; an unknown entity or a malformed request is not. The result comes back as an
`outcome` input and an `ActionCompleted` event.

**Notices** go to the main chat, and to the alerts chat for instances marked `alerts` (not a
reply: what an instance says on a command, marked `reply` by the kernel; not a report: a
notice the heuristic marks `info`, needing nobody to act);
each chat is retried on its own, so neither gets a message twice. The monitor's own
messages and the daily summary go to the main chat only.

**Knowing who did what**: every `call_service` HA emits is journaled with `by`: the
add-on itself (with the instance), `person:<name>` (a non-system HA user, names from
`config/auth/list`), `system:<name>` (the Supervisor, another add-on), or `device` (no
user). The panel's Calls tab, the Heuristics agreement view, the MCP `recent_changes`
tool and the monitor's "another automation is working against it" alert all rest on
this.

## 5. External integrations and surfaces

| Integration | Direction | Used for |
|---|---|---|
| **HA websocket** | both | `state_changed` and `call_service` events; triggers (`subscribe_trigger`); `callService`; `get_states` snapshots on every (re)connect; `config/auth/list`; the entity, device and area registries and their update events; `homeassistant/expose_entity/list` and `get_services` (the explore tools); `get_config` (time zone); recorder history and statistics |
| **HA REST** (`/api/template`) | out | resolving a device id to its entities |
| **HA ingress** | in | the panel, the read API and `/mcp`; the Studio and reload writes accept only the ingress peer |
| **Supervisor API** | out | the add-on reads `addons/self/info` (the agent port's host port, for the Connect page); the scripts deploy, set options, restart |
| **Telegram Bot API** | out | `sendMessage` to the main and alerts chats; with the command lane, `setMyCommands` (the menu, scoped to the main chat), keyboards, `answerCallbackQuery`, `editMessageText` |
| **Telegram Bot API** | in | `getUpdates` long poll for `/commands` and button presses from the main chat only; stale commands are refused, a second reader (409) is waited out |
| **Agent port** (8199) | in | `/mcp` only, `Authorization: Bearer <agent token>`; every other path is a 404 |
| **LAN, Tailscale** | in | the networks (`mcp_networks`) an MCP client may call the endpoint from through ingress; the agent port takes any address with a valid token |
| **GHCR** | out, CI | the add-on images on a version tag, once published |

The surfaces, all behind ingress but MCP, which also has the agent port:

| Surface | What it offers |
|---|---|
| **Panel** | House (the whole scope, grouped and live, with the facts and their timelines), Decisions (the feed with reasons and causation chains), Heuristics (instances, mode, last decision, agreement with other automations, reload), Studio (edit, test and save custom code), Calls (every `call_service` with who made it), Connect (mint, list and revoke agent tokens, with the line to paste); in the header, the global pause with who paused and when |
| **Read API** | `health`, `api/heuristics`, `api/house`, `api/facts`, `api/house/energy-today`, `api/journal`, `api/journal/chain/:id`, `api/signals/:entity`, `api/tiles`, `api/views/*`, `api/recorder/statistics`, `api/device-entities`, `api/studio/*`, `api/reload`, `api/pause`, `api/connect` and `api/agent-tokens` (ingress only), `api/stream` (SSE frames: `hello`, `journal`, `signal`, `house`, `reload`) |
| **MCP** (`/mcp`) | tools of three kinds (below): read (the house scope's record, all of HA), develop (write the working set, in shadow) and operate (change what the house does). Every call journaled with its caller (`agent:<token name>` on the agent port, the HA user through ingress), a write with its revision; a desktop client connects to the agent port with a token (`claude mcp add --transport http …`), or, as a fallback, through HA's ingress session with the stdio bridge script, from the LAN or the tailnet |
| **Telegram** | notices, command replies, the monitor's alerts and the daily summary; `/commands` |
| **CLI** (`dist/studio/cli.js`) | `init` (a starter working set with the starter packages), `types` (generate the house typings) and `replay`; both read the folder's packages, and the starter ones it does not have yet |
| **Monitor** | posts to the chat when HA has been unreachable, an action was refused or failed, a heuristic threw, a system user switched an entity an active instance controls, or someone paused or resumed the heuristics; one message per problem until it clears, at most six an hour; an optional daily summary |

### Who may reach the MCP tools

One MCP server (`src/mcp/index.ts`), two doors, each with its access check in
`src/mcp/access.ts`. The tools are the same behind both, and every call is journaled
with its caller.

- **Ingress** (port 8099): the request comes from the Supervisor's ingress gateway, so
  Home Assistant has authenticated an admin's session; the client's address (the last
  `X-Forwarded-For` hop outside the Supervisor's network) must be in `mcp_networks`.
  Standalone, loopback only. The stdio bridge uses this door.
- **The agent port** (8199): its own server (`agentApp` in `src/server.ts`) mounts
  `/mcp` and a 404 for everything else, so the panel, the read API and every write stay
  behind ingress. It is token-only: every request must send `Authorization: Bearer
  <agent token>`, and `mcp_networks` is not applied, because on Home Assistant OS the
  host's port mapping shows every client as the Supervisor network's gateway
  (172.30.32.1). A valid, unrevoked token is always served. Failed attempts are counted
  per address and in all (20 and 100 in ten minutes); past either, a wrong token gets
  429, and one whose id is unknown gets it before any hash is computed. All clients may
  share one address, so a per-address lockout of valid tokens would let one bad client
  lock out every agent. A token is
  `tbn_<id>_<secret>`, 32 random bytes; `/data/agent-tokens.json` keeps per token a
  random salt and `sha256(salt ‖ secret)`, compared in constant time (an unknown id is
  compared against a decoy, so it takes as long). Revoking removes the record at once.
  The caller is `{ via: "agent", agent: <name>, tokenId, address }`, shown as
  `agent:<name>`.
- **Minting and revoking** (`POST api/agent-tokens`, `DELETE api/agent-tokens/:id`) and
  the list (`GET api/connect`) accept only the ingress peer, like every other write:
  an agent can never mint itself a token. Each mint and revocation is journaled with the
  HA user who did it.
- The agent port is plain HTTP. On the tailnet WireGuard encrypts it; on the LAN the
  token is in the clear, as the LAN's own HA traffic usually is. The owner can move or
  close the port in the add-on's Network section.

### The MCP tools: read, develop, operate

No tool switches a device: behaviours act, through the SafeActuator, and that stays
the only way anything in the house is switched. Each tool is listed with MCP
annotations (`readOnlyHint`, `destructiveHint`), so a client can ask its person before
a call that changes something.

| Kind | Tools | Annotations |
|---|---|---|
| **Read**, the house scope (`src/mcp/tools.ts`) | `house_scope`, `house_state` (with the instances' cards and the facts), `recent_changes`, `history`, `heuristics`, `heuristic_source`, `decisions`, `chain`, `signals`, `timeline`, `tool_calls`, `outdoor`, `whoami` | read-only |
| **Read**, all of HA, never recorded (`src/mcp/ha-tools.ts`) | `ha_registry` (areas, devices, entities; filters and pages), `ha_states`, `ha_history` (at most 7 days, 2000 points a page), `ha_services`, `suggest` (packages whose roles the registry fills, pre-bound) | read-only |
| **Read**, the working set (`src/mcp/develop.ts`) | `package_list`, `file_read`, `test_run` (specs, as the Studio runs them: `src/testing/`), `replay` (the recorder over WebSocket, at most 7 days, facts evaluated), `package_export` (roles for the house's ids, then the privacy scan), `revisions`, `revision_diff`, `twin_compare` | read-only |
| **Develop**: writes to the working set, in shadow | `package_install` (a starter package; a git URL is not built), `package_scaffold`, `file_write` (`heuristics.json`, `allowlist.json`, `tiles.json`, `heuristics/**`, `packages/**`; never the lock or generated files), `types` (generated typings, no revision), `scope_add` (observe only), `instance_upsert` (shadow or off, `twinOf`) | `readOnlyHint: false` |
| **Operate**: what the house does | `instance_mode`, `scope_operate` (with a reason), `rollback`, `promote`, `pause`, `resume`, `command` (to the behaviours, sender `mcp`) | `destructiveHint: true` |

Every write is one change applied through the reload path (`Reloader.write` and
`edit`, `rollback`, `promoteTwin`): all or nothing, the folder put back when the reload
rejects it, and journaled as the next revision with `by: mcp:<caller>`
(`mcp:agent:<token name>`). The answer names the revision and the one to roll back to.
The platform's own guardrails sit in the tools, under the ones the agent skills carry:
`file_write` never adds `operate` or makes an instance active, `scope_add` only
observes, `instance_upsert` never touches an active instance (a twin does), and
`instance_mode` makes an instance active only when its specs pass now and it decided
in shadow within the last 24 hours, else with an `override_reason` that is journaled
in the revision's summary; a guard leaves active only with one too. The pause never
stops a guard (the kernel's rule).

## 6. Scaffolding and the working set

Two things live together today and are about to be separated: the **scaffolding**,
which is the same for every house and ships in the image, and the **working set**,
which is one house's and which its people view and edit.

| | Scaffolding (this repository, the image) | Working set (the config folder) |
|---|---|---|
| Code | `src/kernel` (rules, deciders, host, actuator, simulator), `src/packages` (manifest, loader, lock), `src/house`, `src/mcp`, `src/studio`, `src/monitor.ts`, `src/telegram.ts`, `src/reload.ts`, the panel | `packages/*/` (the starter packages as installed, changed or not, and the house's own) and `heuristics/*.ts` (its own rules and deciders), with their tests |
| Configuration | add-on options (chats, monitor, budget) | `heuristics.json` (instances: mode, params, alerts), `allowlist.json` (scope, operate, routes, outdoor), `tiles.json` (House groups, names, keywords) |
| Generated | — | `heuristics/ha.d.ts`, `.teob/`, `tsconfig.json`, `teobeanie.lock.json` |
| Record | — | `/data` (the journal is the house's, but it is not edited) |
| Starter set | `packages/` (the generic behaviours, copied into the config folder) | — |
| Examples | `examples/` (a starter working set, a custom heuristic) | — |

The rule for the boundary: the scaffolding never names an entity, a person, a chat or
a place. The house time zone comes from HA (or an option), texts and notification caps
are settings with English defaults, the House layout's words come from `tiles.json`, and
the global pause is a journaled command from the panel's header (guards act through it).
One historical exception stays:

- The audit stream and projection keep their historical `nodered` ids, because renaming
  them would orphan existing journals; they are display-mapped, not renamed.

### The separation, as designed

1. **The config folder is the project.** It already is a folder a person can put in
   git. It gets a short `README` from the starter, the generated typings, and a
   `tests/` convention, so `cli.js types` and a test runner work on it as on any
   TypeScript project. `teobeanie init <folder>` writes a starter working set.
2. **Instances are edited as forms, code as code.** Each package's heuristic exports a
   parameter schema (`kernel/params.ts`; the TypeScript types derive from it), so the panel can
   render an instance editor: mode, params with their defaults and units, texts, the
   alerts flag; validation is the same the loader does. A package's source stays
   read-only in Studio, with "copy to config" producing an editable fork under a new id.
   *Built*: the Heuristics tab's editor (`panel/src/components/InstanceEditor.tsx`, its
   model in `panel/src/instanceForm.ts`) renders the form from `describeParams`: entity
   fields pick from the house scope by domain, numbers and durations carry their unit
   and bounds, texts their default as placeholder and their slots, objects, lists and
   `oneOf` nest, optional fields fold away; `alerts`, `notifyPerHour` and `commandHelp`
   are instance fields. A heuristic without a schema takes its params as JSON. The
   panel runs the server's own check (`kernel/instance-check.ts`: a new id is
   kebab-case and unique per heuristic, the loader's rules, `checkParams`) as it is
   typed and shows each problem at its field. `POST api/instances`,
   `PUT api/instances/<heuristic>/<id>` and `DELETE …` (ingress only) check the same,
   answer 422 with the problems before writing anything, else edit heuristics.json in
   place (`working-set.ts`: a changed param replaces that value only, an added instance
   follows the layout of the others, other top-level keys and an instance's own extra
   keys stay), reload through `Reloader.edit` and journal a summary of what changed
   ("door-nag/back: mode shadow → active, params changed (everyMin 5 → 10)"). The
   reload stays the judge of the scope and the owners; a rejection puts the file back.
3. **Every edit is a journaled event.** A change to the working set (from the panel,
   the file watch or the CLI) is applied through the reload path and journaled as
   `ConfigChanged { file, by, summary, instances, revision, parent, files }` next to
   the decisions it affects. The timeline
   then shows "the run-on was changed from 5 to 10 min" between the decisions before
   and after; the agent needs the same event to explain a change in behaviour.
   *Built* (`src/working-set.ts`): every reload that changed a file or an instance is
   journaled in `teob-config/working-set` with `by` = `file` (the watch), the panel's HA
   user, or `cli`, a summary from the reload's diff ("climate-guard/attic: params changed
   (maxRunMin 180 → 240)") and the `instances` it touched; a rejected reload journals
   nothing. The Decisions tab shows the edits between the decisions.
4. **Mode changes and the pause are first-class.** Switching an instance between shadow
   and active, or pausing everything, is a command from the panel that writes the file
   and is journaled with who did it, instead of an edit to JSON. *Built*:
   `POST api/instances/<heuristic>/<id>/mode { mode }` (ingress only) changes the one
   `"mode"` value in heuristics.json, reloads and journals; a rejected reload puts the
   file back. The panel's edits all take this path (`Reloader.edit`: edit the text,
   reload, journal), so instance forms can follow it.
5. **The library is a catalogue.** The Heuristics tab gains the library itself: each
   pattern, its parameters, its guarantees, and a button to add an instance. New
   heuristics ship as starter packages; a house's own live in its folder; both appear
   in the same catalogue, marked.
   *Built*: `GET api/library` lists the library the running set was loaded with (the
   packages' heuristics and the house's own files', re-read on every reload) with
   title, pattern, description, `guarantees` (a field of the definition, plain
   English), its package (name, version, origin, modified), the parameters from
   `describeParams`, and the entities the editor's pickers offer. The Heuristics tab's
   Library view shows them by pattern, the house's own marked "yours" and a starter
   package the house changed marked "changed", each with "Add an instance" (the editor,
   defaults as placeholders) and a link to its source in the Studio, which lists the
   packages read-only (`api/studio/packages`) and where "Copy to edit" forks one into
   `heuristics/`.
   The library itself lives in packages, not in the image. The starter set is
   pre-installed and locked (`src/packages/`); roles describe what each heuristic
   needs, so a later `suggest` can match them to the house's registry.
6. **The record stays whole across versions.** Journal event tags are only ever added;
   a heuristic's events are versioned by name when their meaning changes; replays of an
   old week against new code remain possible.
7. **Every change is a revision, and every revision can be undone.** *Built*
   (`src/revisions.ts`): each journaled ConfigChanged carries `revision`, `parent` and
   `files`, the whole working set after it (`heuristics.json`, `allowlist.json`,
   `tiles.json`, `teobeanie.lock.json`, `heuristics/**`, `packages/**`; not dot files,
   `node_modules` or the generated typings) as path → sha256. The contents are stored
   once each under `/data/revisions/objects/<2>/<hash>`; the journal is the index, so
   the revisions are folded from the teob-config stream at start, and rows from before
   revisions (no `revision`) are skipped. The start records the folder as revision 1,
   or as a new revision (`by: "boot"`) when it differs from the last. With revisions a
   reload journals when any working-set file changed (a spec, a README), not only when
   an instance did. `rollback(n)` writes n's files back (only the ones that differ;
   a working-set file n did not have is removed, with the folders that leaves empty;
   nothing else is touched) through `Reloader.write`, the same all-or-nothing path as
   the panel's edits: a rejected reload puts every file back. It is journaled as a new
   revision, `summary: "rollback to n"`. The facts are part of it: they live in
   `heuristics/` and `packages/`, a reload (a rollback too) plans them with the
   instances, and the commit evaluates every fact again, so a definition that changed
   journals its new value. The file watch is recursive and reloads on the lock and on
   anything under `heuristics/` and `packages/` too. API, the writes
   through ingress only: `GET api/revisions`, `GET api/revisions/<n>` (files; `?path=`
   one file's text), `GET api/revisions/<a>/diff/<b>` (a unified diff per file),
   `POST api/revisions/<n>/rollback`. `listRevisions`, `revisionDetail`,
   `revisionFile`, `diffRevisions` and `rollback` are plain functions for the agent's
   tools.
8. **A new version runs beside the old one before it replaces it.** *Built*
   (`src/twins.ts`, `kernel/host.ts`): an instance with `"twinOf": "<heuristic>/<id>"`
   is its original's shadow twin. It watches and reads what it likes, and may name the
   original's entities: of a pair one claims (the original, unless the twin is active
   or the original off) and the other vets as it, dry (`SafeActuator.vet(…, dry)`:
   ownership, scope, bounds and the pause as the claimer, no rate window), so a twin
   never spends its original's budget. A twin active while its original is, a twin of
   a twin, a second twin of one instance, and a twin switching a third instance's
   entity are rejected. `compareTwin` matches the two streams' `Decided` events by
   their input signal (the causation obsId) or fact change (the `FactChanged` both
   heard: a twin may read the same facts) since the twin's first row and compares
   their actions, whatever their verdict; decisions on start, timers, triggers and
   commands are counted, not compared. `promoteTwin` is one edit of
   `heuristics.json` (`promoteTwinText`): the original removed (its stream stays), the
   twin under the original's id and mode, its own heuristic and params kept, `twinOf`
   gone. One revision, so a rollback undoes it. `GET api/twins`,
   `GET api/twins/<heuristic>/<id>` (`?from=&to=`, default the last day),
   `POST api/twins/<heuristic>/<id>/promote` (ingress only).

## 7. The agent

### What exists

The add-on declares the agent's options (`llm_provider`: none, OpenRouter or Ollama;
model, key, URL, a monthly budget) but nothing reads them. What it does have is the
agent's view of the house: the MCP tools, journaled with their caller, scope-limited
except the explore tools, which read all of HA and record none of it; the develop and
operate tools, which change the working set one revision at a time and never switch a
device; and the design decision behind them, that a model reads the same record a
person does and nothing more. The framework it builds on (teob-ts `ai`) ships the
pieces: an `LLMService` with OpenRouter and OpenAI-compatible factories (`chatWithTools`,
tracked variants for cost), a spend guard, a tool registry over the same `MCPTool` type
the house tools already use (with per-tool `Auto`/`Confirm` permissions), guardrails, a
versioned prompt registry, a recording/replay sandbox for tests, and an `llmJudge`
evaluator.

### Principles

- **It reads the record; it does not act.** The agent's tools are the house tools: state,
  changes with attribution, decisions with reasons, history, the heuristics and their
  source; a desktop agent also develops and operates behaviours through revisions. No
  actuation tools, as the README promises. When a judgement should lead to an
  action, it goes to a person (an ask in the chat) or, later and off by default, through
  a claimed instance and the same SafeActuator as every heuristic.
- **Every judgement is journaled, with its evidence.** A question, the tool calls it
  made, the answer, the model, tokens and cost are one journaled session; the answer
  cites the event ids and signal rows it rests on, so a person can open the chain.
- **The backend is pluggable and budgeted.** One provider interface (OpenRouter; any
  OpenAI-compatible URL, which is how Ollama is reached; none), a monthly budget summed
  from a journal ledger at boot and enforced in-process, and a daily cap on unsolicited
  work.
- **Same surface for every reader.** The in-process agent, a desktop client over MCP and
  an HA-side assistant all use the same tool list, so what the agent could see is
  exactly what a person can check.

### Capabilities, in the order they are built

1. **Explain.** "Why did the hall light go off at 21:14?" The agent takes the decision
   (`decisions`), walks its causation chain (`chain`), reads the signal rows
   (`signals`) and the recorder history around it, and the heuristic's source, and
   answers with the `why` and the evidence. This is the foundation; the tools exist,
   the loop does not yet.
2. **Introspect the timeline.** A `timeline(entity | instance, from, to)` tool merges,
   in time order, the signals (what changed), the audit (who called what), the decisions
   (why), and the config changes (section 6), each row with its `by` and its event id.
   It is the single view the agent reasons over for "what happened in the garden this
   evening", and the panel gets the same view (`api/timeline`, the House tab's entity
   rows).
3. **Judge.** On demand ("is anything odd today?") and proactively: when the monitor
   raises a problem it hands the agent the problem key and the window, and the agent
   adds an explanation to the alert; at the daily summary it turns the digest into an
   assessment: what ran, what was unusual (a device starting by itself, a first action,
   a refusal), what it would look at. Judgements never execute anything; they end in
   text, with evidence.
4. **Ask and consult.** A new action kind, `ask { text, options, timeoutMs, default }`:
   a heuristic can hand a decision to a person (buttons in the chat) or to the agent (a
   judgement with a timeout and a safe default). The answer comes back as an input, so
   the decision stays journaled and replayable. The garage auto-close, a start outside
   the usual hours, anything the agent proposes, go through it.
5. **Draft a heuristic.** From a described routine, the agent writes a rule into the
   working set as a shadow instance, runs the simulator tests it wrote with it, replays
   it against the last week, and reports; a person reviews and activates. The write path
   is the Studio's, the review is the reload's rejection or acceptance.

### Plumbing

In `main.ts`, after the House service: a provider factory over the options; the house
tools registered in an in-process tool registry (the list `createHouseTools` already
builds for MCP), wrapped the way the MCP endpoint wraps them so every call is journaled
with the caller `agent`; a `chatWithToolsTracked` loop with a step limit and the spend
guard; a new journal category `llm-ledger` with `LlmCalled { at, purpose, model, tokens,
costUsd }` and `Judged { question, answer, evidence }`, read at boot to know the month's
spend; the guardrails from the framework on output length and on anything outside the
scope; prompts in the versioned registry so an answer can be traced to the prompt that
produced it. Entry points: a `/ask` command and, when the bot is mentioned or replied
to, free text in the main chat (`telegram.ts` drops free text today); the monitor's
problem and summary hooks; a panel view later. Tests run the loop against the recording
sandbox, so a change to a prompt or a tool is judged against recorded sessions, not
against the live house.

Next:

- an MCP entry point from Home Assistant's own assistant;
- the loop, with the pluggable backend and the budget;
- `ask`;
- free text in the chat;
- the kernel upstream into teob-ts.

## Appendix: file map

```
src/
  main.ts            composition root, numbered steps
  config.ts          options and the add-on / standalone split
  allowlist.ts       the house scope, routes, outdoor sources
  kernel/
    heuristic.ts     Input, Action, Decision, DecideCtx, defineHeuristic, helpers
    rule.ts          rule(): World, Entity handles, held/within/between, enforce, compile
    fact.ts          fact(): derived state; planning (names, cycles, scope) and the pure engine
    step.ts          the pure decide step, the kernel event grammar, resend
    kernel.ts        the teob-ts aggregate per instance, recovery
    host.ts          instances, scope and ownership checks, runtimes, reload diff, commands, the facts' journal
    card.ts          an instance's card (view()) for the House page, its buttons checked
    actuator.ts      SafeActuator (vet, execute, retry), the Telegram notifier
    simulate.ts      the simulator used by tests and the Studio worker
    custom.ts        importing a house's files and packages ("teobeanie" alias)
    clock.ts         local-time helpers
  packages/          behaviour packages: manifest.ts (roles, platform), library.ts (load, starter install), lock.ts, suggest.ts (roles matched to the registry)
  house/             the House view: layout, summary, live service
  mcp/               tools, ha-tools (explore all of HA), develop (develop and operate, annotations), timeline (chain, signals, timeline), access (ingress peer and allowed networks, agent token), agents (agent tokens, teob-access stream), the mcp-audit stream
  testing/           expect (vitest's matchers) and the spec runner: test_run and the Studio's worker
  scope-edit.ts      allowlist.json edited in place (scope_add, scope_operate)
  ha-registry.ts     HA's area, device and entity registries for the explore tools, refreshed on registry events
  studio/            cli (types, replay), house typings (write-types: the CLI and the types tool), file API
  audit.ts           the ha-audit aggregate; attribution.ts: who made each call
  projections.ts     the call timeline view
  telegram.ts        the command lane (getUpdates)
  monitor.ts         self-monitoring and the daily summary
  reload.ts          file watch (recursive), POST api/reload, apply all-or-nothing, the panel's edits
  working-set.ts     the teob-config stream (ConfigChanged), in-place heuristics.json edits, api/instances/…/mode
  revisions.ts       the working set's revisions (/data/revisions), diff, rollback, api/revisions
  twins.ts           shadow twins compared per signal and fact change, promote, api/twins
  replay.ts          replay and parity
  server.ts          HTTP routes, SSE, static panel, MCP mount; the agent port's app (/mcp only)
  connect.ts         the Connect page's API: agent tokens, the agent port's host port
  move.ts            moving to another install: the export (api/move), the import at start
panel/src/           views/ (House, Decisions, Heuristics, Studio, Today=Calls), studio/ (Monaco, test worker)
teobeanie/          add-on packaging: config.yaml, Dockerfile, DOCS.md, translations
packages/            the starter packages (one folder each: teobeanie.json, code, specs, README, example.json)
examples/            starter working set, custom heuristic example
scripts/             deploy-local-addon.sh, teobeanie-mcp-bridge.mjs, config-sync.sh (pull and push a config folder over SSH)
skills/              the agent skills (onboard, develop, operate, explain, nodered-migration); .claude-plugin/ makes the repository a Claude Code plugin marketplace
docs/                getting-started.md, heuristics.md, house.md, deploy.md, moving.md, this file
```
