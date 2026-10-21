# Changelog

## 0.2.0 — first public alpha

Teobeanie runs a house's behaviours as small pure functions written in TypeScript,
with tests, and journals every decision it makes with the reason and the readings it
used. You build and change those behaviours with your own AI agent, which reads the
house through MCP.

- **Behaviour packages, pre-installed and editable.** Each behaviour is a package in
  the config folder's `packages/<name>/`: a `teobeanie.json` manifest (version, platform
  range, roles, uses), the code, its specs, a README and an example instance. On start
  the add-on adds the starter packages you do not have yet and never overwrites one you
  changed: sensor-light, trigger, hold, button, relay-pulse, door-watch, water-meter,
  leak-guard, appliance, garage-door, climate-guard.
- **Roles.** A package's manifest says which entities each heuristic needs (domain,
  device classes, one or several, optional, read or switched), checked against its
  parameter schema.
- **Lock file.** `teobeanie.lock.json` records where each package came from, its version
  and its hash, so a package you changed shows as modified.
- **Cards.** A heuristic can give each instance a card on the House page: a few values
  and buttons that run the instance's commands, computed by a pure `view`.
- **Journal and causation chains.** Every decision is a journaled event with its
  reason, its actions and the chain back to the sensor change that started it. Timers
  survive restarts.
- **Shadow mode.** Instances (and, by default, the whole add-on) decide and journal
  what they would do without acting. The panel shows how often your existing
  automations made the same call.
- **SafeActuator.** Every service call passes one gate: the house scope, per-entity
  ownership, no `toggle`, value bounds, rate limits, services that are never automated,
  and a global pause.
- **Replay.** `cli.js replay` runs an instance over recorded history before it touches
  anything, and compares its calls with what the house did.
- **Studio.** Your own rules and heuristics in an editor typed against the house scope,
  with their tests running as you type; the packages read-only next to them.
- **House view.** The whole house scope, live and grouped (energy, doors and windows,
  lights, climate, outdoor, presence, safety), with the instances' cards.
- **Instances from the panel.** Add and edit instances with a form built from each
  heuristic's parameter schema; switch modes and pause from the panel. Every change is
  journaled with who made it.
- **MCP read tools.** `house_scope`, `house_state`, `recent_changes`, `history`,
  `heuristics`, `heuristic_source`, `decisions`, `chain`, `signals`, `timeline`,
  `outdoor`, `tool_calls` and `whoami`: read-only and limited to the house scope, every
  call journaled with its caller. `scripts/teobeanie-mcp-bridge.mjs` connects a local
  MCP client.
- **MCP from the LAN.** The tools are reached through Home Assistant ingress from the
  networks in the `mcp_networks` option: the private LAN ranges and Tailscale by
  default. A public address is refused.
- **Telegram.** Notices, a second chat for alerts, `/commands` from the chat, problems
  (Home Assistant down, refused or failed actions, a heuristic throwing, another
  automation on Teobeanie's entities) and an optional daily summary.
- **Privacy scan.** `scripts/privacy-scan.mjs` checks a tree or an exported package for
  one house's data: a private deny list, chat ids, tokens, private addresses and entity
  ids that are not generic placeholders.
- **Prebuilt images** for `amd64` and `aarch64` on GHCR.
