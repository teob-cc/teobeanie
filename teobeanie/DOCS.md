# Teobeanie

Behaviours for Home Assistant as tested pure functions, with a journal of every
decision, built with your own AI agent over MCP. Every decision the house makes is a
journaled event you can inspect, explain and replay.

> **Status: alpha (0.2).** Heuristics run in shadow mode by default: they decide and
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
| Heuristics | One card per instance: mode, last decision, 24 h activity, agreement with existing automations, pending timers. Click a card for its history and configuration |
| Calls | Every `call_service` in Home Assistant, with who made it: Teobeanie, a person (by HA user name), a system user such as the Supervisor (other add-ons call as it), or `device` when the call carries no user. Reading user names needs an admin token; without one users show as `user <id>` |
| Studio | Your rules and heuristics in an editor typed against the house scope, with their tests running as you type; the packages in `packages/` read-only, with the instances that use them |

## MCP tools for agents

The add-on serves the house as read-only [MCP](https://modelcontextprotocol.io) tools at
`/mcp`: `house_scope`, `house_state`, `recent_changes` (who changed what: Teobeanie, a person,
a system user such as the Supervisor, an automation, the device), `history`, `heuristics`,
`heuristic_source`, `decisions`, `chain` (why a journaled event happened, back to the
signal that started it), `signals` (an entity's recorded rows over a range), `timeline`
(changes, calls, decisions, the pause and config edits around an entity or an instance,
in time order), `tool_calls` and `whoami`. Only the house scope
(`allowlist.json`) exists for them, and every call is journaled with its caller.

The only way in is Home Assistant ingress, so Home Assistant authenticates every
request, and the client must connect from one of the `mcp_networks`: by default the
private LAN ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10) and
Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48). A public address is refused unless you
add its network. A local MCP client such as Claude Code connects through
`scripts/teobeanie-mcp-bridge.mjs`, which opens an ingress session with a long-lived token
of an admin user and finds the installed add-on by itself (`ADDON=<slug>` picks one):

```bash
claude mcp add teobeanie -e HA_URL=http://homeassistant.local:8123 \
  -e HA_TOKEN_FILE=<file with the token> -- node scripts/teobeanie-mcp-bridge.mjs
```

`HA_URL` is Home Assistant's address on your LAN or your tailnet.

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
| `mcp_networks` | Networks (CIDR) an MCP client may use the tools from, through ingress. Default: the private LAN ranges and Tailscale. Empty: MCP is closed. The `MCP_NETWORKS` environment variable (comma-separated) overrides it, standalone too |
| `shadow_mode` | Emergency switch: forces every instance to shadow, so nothing actuates (default off) |
| `log_level` | Add-on log verbosity |

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
`journal.db` (decisions, kept forever) and `views.db` (rebuildable read models).
The raw-signal ring `signals.db` is excluded from backups by design.

Your configuration (`heuristics.json`, the packages in `packages/` with
`teobeanie.lock.json`, optionally `heuristics/*.js`, `allowlist.json`, the house scope,
and `tiles.json`) lives in this add-on's config folder, visible in the `addon_configs` share via the Samba or
Studio Code Server add-ons.

## Configuration files

A saved change to `heuristics.json`, `allowlist.json` or `tiles.json` is applied
about a second later, without a restart. **Reload config** on the Heuristics tab
does the same on demand, and also picks up edited `heuristics/*.js` files and
packages (saving one from the Studio does not reload by itself).

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
