# Teobeanie

Behaviours for Home Assistant as tested pure functions, with a journal of every
decision, built with your own AI agent over MCP. Every decision the house makes is a
journaled event you can inspect, explain and replay.

> **Status: alpha (0.3).** Heuristics run in shadow mode by default: they decide and
> journal, and never act until you allow it. See the
> [roadmap](https://github.com/teob-cc/teobeanie#roadmap).

The add-on installs from prebuilt images for `amd64` and `aarch64`.

## Core ideas

- **Signals ≠ events.** Raw sensor ticks live in a bounded ring store (default
  30 days). The journal records *decisions* — threshold crossings, actuations,
  overrides — and keeps them forever. "Why did the heating come on at 06:42?"
  is a causation-chain query, not log spelunking.
- **Shadow mode first.** Every heuristic starts in shadow: it decides and
  journals what it *would* do without touching anything. You promote it to
  active when the decision log has earned your trust — and demote it back with
  one tap.
- **One actuation choke point.** All service calls pass a safety gate with
  static bounds, per-entity ownership, rate limits, and confirmation tracking.
  LLM features have no actuation tools at all.

## Getting started

**With your agent:** five steps and one prompt, in
[docs/getting-started.md](https://github.com/teob-cc/teobeanie/blob/main/docs/getting-started.md).
The agent explores your house read-only, suggests first behaviours from the starter
packages, sets the ones you pick up in shadow, and makes nothing active until you say
yes. By hand:

1. Start the add-on and open **Teobeanie** in the sidebar. If it isn't there, turn on
   **Show in sidebar** on the add-on's Info tab (or use **Open web UI**).
2. In this add-on's config folder (`addon_configs/…_teobeanie` in the Samba or
   Studio Code Server add-ons) you'll find an `examples/` folder. Copy the files of
   `examples/starter` up into the config folder, replace the entity ids with your
   own, and delete what you don't need. The add-on picks the files up as they are
   saved (see [Configuration files](#configuration-files)). Your own heuristics,
   written as code, go in `heuristics/*.js` (see `examples/custom-heuristic`).
   The behaviours themselves are in `packages/`: the add-on puts its starter set
   there on every start, adding the ones you do not have and never overwriting one
   you changed. Each package has a README and an example instance.
3. Watch the **Decisions** tab. Each card says what the heuristic decided and why,
   and what it *would* have done in shadow mode. Open a card to see the readings it
   used and the causation chain back to the sensor change. If you already run
   automations (Node-RED, HA automations), turn on "Other calls: same entities" to
   see their calls next to Teobeanie's, each labelled with who made it. A green ✓ means
   both made the same call.
4. The **Heuristics** tab shows every instance with its mode, last decision, 24-hour
   activity, agreement count and pending timers.
5. When an instance has earned your trust, set `"mode": "active"` on it
   and disable your old automation for those entities.

How to edit the config folder, for the people of the house, is in
[docs/working-set.md](https://github.com/teob-cc/teobeanie/blob/main/docs/working-set.md).
The heuristic types and their parameters are described in
[docs/heuristics.md](https://github.com/teob-cc/teobeanie/blob/main/docs/heuristics.md).

## Panel

| Tab | Shows |
|---|---|
| House | The whole house scope, live: energy flow and today's totals, doors and windows, lights, climate, outdoor, presence, safety and the rest, each section with a summary on top and its entities below; the heuristic instances' cards, with their buttons (a garage door's open and close). Grouping and names are adjustable in `tiles.json` ([docs/house.md](https://github.com/teob-cc/teobeanie/blob/main/docs/house.md)) |
| Decisions | Every heuristic decision: why, actions (would / did / refused), timers, causation chain; optionally your existing automations' calls interleaved |
| Heuristics | One card per instance: mode, last decision, 24 h activity, agreement with existing automations, pending timers. Click a card for its history and configuration. **Revisions** lists every applied change with who made it, shows its diff and rolls back to any of them; a shadow twin's card shows where it decides differently from its original, and **Promote** swaps them |
| Calls | Every `call_service` in Home Assistant, with who made it: Teobeanie, a person (by HA user name), a system user such as the Supervisor (other add-ons call as it), or `device` when the call carries no user. Reading user names needs an admin token; without one users show as `user <id>` |
| Studio | Your rules and heuristics in an editor typed against the house scope, with their tests running as you type; the packages in `packages/` read-only, with the instances that use them |
| Connect | Agent tokens: mint one per AI agent (shown once, with the line to paste into Claude Code and the JSON for other MCP clients), see when each was made, by whom and last used, and revoke it |

## MCP tools for agents

The add-on serves the house as [MCP](https://modelcontextprotocol.io) tools at `/mcp`.
None of them switches a device: behaviours do, through the SafeActuator. The tools
that read:  `house_scope`, `house_state` (with the instances' cards and the facts, the derived state
the heuristics read), `recent_changes` (who changed what: Teobeanie, a person,
a system user such as the Supervisor, an automation, the device), `history`, `heuristics`,
`heuristic_source`, `decisions`, `chain` (why a journaled event happened, back to the
signal that started it), `signals` (an entity's recorded rows over a range), `timeline`
(changes, calls, decisions, fact changes, the pause and config edits around an entity, an
instance or a fact, in time order), `tool_calls` and `whoami`. Only the house scope
(`allowlist.json`) exists for them, and every call is journaled with its caller.

Five more explore all of Home Assistant, outside the house scope too: `ha_registry`
(areas, devices, entities), `ha_states` (current states), `ha_history` (the recorder,
at most 7 days per call), `ha_services` (services and their fields) and `suggest` (the
behaviour packages whose roles your entities fill, pre-bound). They only read, and
nothing they read is recorded; the calls are journaled like the others. With them an
agent needs no Home Assistant MCP server of its own.

**Develop and operate.** More tools change the config folder, one revision at a time
(the panel's **Revisions** list shows each, journaled as `mcp:<agent>`, and rolls any
of them back). Develop, in shadow: `package_list`, `package_install` (a starter
package), `package_scaffold` (a new package), `file_read`, `file_write` (the working set
only: `heuristics.json`, `allowlist.json`, `tiles.json`, `heuristics/`, `packages/`),
`types`, `test_run` (the specs, as the Studio runs them), `replay` (the recorder's last
days, at most 7), `scope_add` (observe only), `instance_upsert` (shadow or off) and
`package_export` (a package with your entity ids swapped for its roles, after a privacy
scan). Operate: `instance_mode`, `scope_operate` (with a reason), `revisions`,
`revision_diff`, `rollback`, `twin_compare`, `promote`, `pause`, `resume` and `command`.
A change the reload rejects leaves the folder as it was. `instance_mode` makes an
instance active only when its specs pass and it decided in shadow within the last day,
unless the call gives a reason, which is journaled. The operate tools are marked
destructive, so your MCP client can ask you before each one. The agent skills (see
[Getting started](#getting-started)) add the rest of the guardrails: the agent shows
you the evidence and asks before it acts.

There are two ways in. The agent port is protected by the agent token alone (see
[Network](#network)). Ingress accepts only clients from the `mcp_networks`: by default
the private LAN ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10)
and Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48). A public address is refused there
unless you add its network.

**The agent port** (8199, see [Network](#network)) serves `/mcp` and nothing else. Each
request needs `Authorization: Bearer <agent token>`. Mint a token on the panel's
**Connect** page: it is shown once, with the line to paste:

```bash
claude mcp add --transport http teobeanie http://homeassistant.local:8199/mcp \
  --header "Authorization: Bearer <token>"
```

Every call is journaled with the caller `agent:<token name>`. Only a salted hash of
each token is kept (in `/data`). Revoking a token on the Connect page refuses it from
the next request on. Minting and revoking are journaled with who did it, and only an
admin's panel session (through ingress) can do either. After too many wrong tokens
(20 from one address, or 100 in all, in ten minutes) further wrong ones get 429 for a
while; a valid token is always served.

**Home Assistant ingress** is the fallback: Home Assistant authenticates the request.
A local MCP client that speaks only stdio connects through
`scripts/teobeanie-mcp-bridge.mjs`, which opens an ingress session with a long-lived
token of an admin user and finds the installed add-on by itself (`ADDON=<slug>` picks
one):

```bash
claude mcp add teobeanie -e HA_URL=http://homeassistant.local:8123 \
  -e HA_TOKEN_FILE=<file with the token> -- node scripts/teobeanie-mcp-bridge.mjs
```

`HA_URL` is Home Assistant's address on your LAN or your tailnet. Calls through the
bridge are journaled with the Home Assistant user.

## Configuration

| Option | Meaning |
|---|---|
| `llm_provider` | `none` (default), `openrouter`, or `ollama` |
| `openrouter_api_key` / `openrouter_model` | OpenRouter credentials for the AI copilot |
| `ollama_url` | Ollama server URL for local inference |
| `llm_monthly_budget_usd` | Hard LLM spend cap (spend guard) |
| `telegram_bot_token` / `telegram_chat_id` | Optional Telegram notification channel |
| `telegram_alerts_chat_id` | A second chat for watching the house: notices of instances marked `"alerts": true` in `heuristics.json` go there as well. No commands are taken from it |
| `telegram_commands` | Take `/commands` from that chat (off by default). A bot has one reader: switch this on only when no other client polls the bot |
| `monitor_alerts` | Post problems to that chat (on by default): Home Assistant unreachable, a refused or failed action, a heuristic throwing, another automation calling an entity an active instance controls. See [Self-monitoring](#self-monitoring) |
| `monitor_summary_time` | Local time (`HH:MM`) of a daily summary in that chat; empty (the default) for none |
| `monitor_ha_down_min` | Minutes Home Assistant may be unreachable before the chat is told (default 5) |
| `time_zone` | The house's time zone (e.g. `America/New_York`) for time-of-day rules, the daily summary and local times; empty (the default) uses Home Assistant's |
| `signal_retention_days` | Raw-signal ring retention (decisions are kept forever) |
| `mcp_networks` | Networks (CIDR) an MCP client may use the tools from through ingress. Default: the private LAN ranges and Tailscale. Empty: MCP through ingress is closed. The agent port does not use it: the token alone protects that port (see [Network](#network)). The `MCP_NETWORKS` environment variable (comma-separated) overrides it, standalone too |
| `shadow_mode` | Emergency switch: forces every instance to shadow, so nothing actuates (default off) |
| `log_level` | Add-on log verbosity |

## Network

| Port | Meaning |
|---|---|
| `8199/tcp` | The agent port: `/mcp` for AI agents with an agent token, and nothing else. Default host port 8199. Change it here if 8199 is taken on the host; clear it to close the port (the bridge through ingress still works). The Connect page reads the host port from here. Restart the add-on after a change |

The port speaks plain HTTP: on your LAN the token travels unencrypted, on your tailnet
it is encrypted. Do not forward it to the internet. The panel and its API stay behind
ingress only.

The agent port is protected by the agent token alone. It does not check where a client
comes from: on Home Assistant OS the host's port mapping shows every client as the same
address, so the port cannot tell your LAN from anywhere else. Anyone who can reach the
port can try tokens. A token is 256 bits of randomness, one per agent, and revocable on
the Connect page. No tool controls a device. If you do not use the
port, close it here.

## Self-monitoring

With a Telegram chat configured, Teobeanie tells it when something needs a person:

- Home Assistant has been unreachable for `monitor_ha_down_min` minutes, and when it is
  back;
- an action was refused by the safety gate or failed (a notice over its hourly limit
  and a global pause are not problems; an action a restart cut off is settled by the
  resend);
- a system user (another add-on, such as Node-RED, calls Home Assistant as the
  Supervisor) called a service on an entity an active instance controls: another
  automation is working against Teobeanie;
- a heuristic threw an error deciding.

Each problem is posted once, until it clears: the next accepted action, the next
decision, Home Assistant back, or an hour without it happening again. At most 6
messages an hour in all; the rest go to the add-on log, and the next message says how
many were held back. Messages start with `Teobeanie:`.

With `monitor_summary_time` set, a summary follows each day at that local time (the
time zone of your Home Assistant): per instance the calls and notices since the same
time the day before, shadow calls, refusals, failures, errors, an instance's first
action ever, and calls by system users or devices on entities active instances control.
It is read from the journal, so a restart during the day loses nothing.

## Data

Everything durable lives in `/data` (included in Home Assistant backups):
`journal.db` (decisions, kept forever), `views.db` (rebuildable read models),
`revisions/` (the config folder at each revision) and `agent-tokens.json` (the agent
tokens' names and salted hashes, never the tokens).
The raw-signal ring `signals.db` is excluded from backups by design.

Your configuration (`heuristics.json`, the packages in `packages/` with
`teobeanie.lock.json`, optionally `heuristics/*.js`, `allowlist.json`, the house scope,
and `tiles.json`) lives in this add-on's config folder, visible in the `addon_configs` share via the Samba or
Studio Code Server add-ons.

## Configuration files

A saved change to `heuristics.json`, `allowlist.json`, `tiles.json`,
`teobeanie.lock.json` or anything under `heuristics/` and `packages/` is applied
about a second later, without a restart. **Reload config** on the Heuristics tab
does the same on demand.

- Only what changed restarts: an instance that was added, removed, or whose mode,
  params or code changed. It replays its own journal stream, so its timers survive.
  Every other instance keeps running untouched.
- Scope (`allowlist.json`) changes apply to the safety gate, the routing, the House
  view and the MCP tools. Tile and group changes apply to the House view.
- The config is applied all or nothing. Broken JSON, an unknown heuristic, an entity
  outside the scope, two owners of one entity or a custom heuristic that fails to
  load rejects the whole change: the add-on log says why (at warning), the Heuristics
  tab shows it, and the previous configuration keeps running. Fix the file and save
  again.
- Every reload is logged in one line, for example
  `reload (file): +1 −0 ~2 (mode) unchanged 18`.
- Every applied change is a numbered revision. **Roll back…** on the Heuristics tab
  puts the folder back as it was at one, facts and packages included, through the same
  all-or-nothing path; the rollback is a revision too
  ([docs/working-set.md](https://github.com/teob-cc/teobeanie/blob/main/docs/working-set.md#undoing-a-change)).

The add-on options on the Configuration tab (Telegram, `shadow_mode`, log level, ...)
still need an add-on restart.

## Running outside Home Assistant OS

The same app runs standalone (HA Container/Core users, or development on a
laptop) against any Home Assistant instance:

```bash
HA_WS_URL=ws://homeassistant.local:8123/api/websocket \
HA_TOKEN=<long-lived access token> \
node dist/main.js
```

State and `heuristics.json` go to `./.dev-data` (override with `DATA_DIR` /
`CONFIG_DIR`). Standalone mode always runs in shadow mode. The same image runs
under plain Docker; build it from a checkout of the repository:

```bash
docker build -f teobeanie/Dockerfile -t teobeanie .
docker run -d -p 8099:8099 -v teobeanie-data:/data -v ./teobeanie-config:/config \
  -e HA_WS_URL=ws://homeassistant.local:8123/api/websocket -e HA_TOKEN=<token> \
  -e DATA_DIR=/data -e CONFIG_DIR=/config teobeanie
```
