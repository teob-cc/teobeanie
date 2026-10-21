# Changelog

## Unreleased

- **Explore Home Assistant over MCP.** New read-only tools read all of Home Assistant
  through Teobeanie, outside the house scope too: `ha_registry` (areas, devices,
  entities), `ha_states`, `ha_history` (at most 7 days a call) and `ha_services`.
  Nothing they read is recorded, only the call. Home Assistant's own MCP server is not
  needed. `suggest` names the behaviour packages whose roles your entities fill, with
  the instance's entities bound, the same area's first. `house_state` also returns the
  instances' cards. The onboard skill uses these tools instead of Home Assistant's REST
  API.
- **Connect an agent from the panel.** The add-on opens an agent port (8199) that
  serves the MCP tools and nothing else. Mint a token for each agent on the panel's new
  **Connect** page, paste the `claude mcp add --transport http …` line it shows, and
  revoke the token when the agent should stop. Tokens are kept as salted hashes, and
  minting, revoking and every tool call are journaled with the token's name. No Home
  Assistant token or bridge is needed to connect any more; the bridge through ingress
  stays as the fallback. The port can be moved or closed in the add-on's Network
  section.
- **The agent port refuses a hidden client.** When the host's port mapping shows every
  client as the Supervisor network's gateway (172.30.32.1, inside the default
  172.16.0.0/12), the agent port refuses it with a 403 that says why, and logs it once.
  Use the bridge through ingress, or list `172.30.32.0/23` in `mcp_networks` on purpose.
- **Facts: derived state.** `fact(id, ({ ha, held, within, between, sun, outdoor }) => value)`
  says once what several behaviours need ("nobody near the garage for 5 minutes"), with a
  value and a since. Facts live in packages and in `heuristics/*.ts`, may read other facts
  (a cycle is refused), are journaled only when the value changes (`FactChanged` in
  `teob-fact/<id>`, caused by the signal or the hold behind it) and are typed in
  `ha.d.ts`. Rules read `ha.facts.<name>`, deciders `ctx.fact(id)` with the fact declared
  in `facts`, and `simulate()` runs facts alongside (`sim.fact(id)`). The House page lists
  them with their timelines; `api/facts`, `api/house`, `api/timeline?fact=`, and the MCP
  `house_state` and `timeline` tools show them. door-watch's `door-nag` takes
  `onlyWhileFact`: remind only while a fact such as `nobody-near-garage` holds.

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
- **Shadow mode.** Each behaviour starts in shadow by its own `mode`, and `shadow_mode` is an
  emergency switch, off by default, that forces every instance to shadow. Shadow instances decide and journal
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
