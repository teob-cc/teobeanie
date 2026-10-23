# Changelog

## Unreleased — a heat pump instead of gas

- **A heat pump instead of gas: the ledger answers whether it pays.**
  - Every day also prices an all-electric alternative: the boiler's heat made by a heat
    pump, each hour at the COP of that hour's outdoor temperature (hot water at its own
    COP) and at that hour's price, with the gas connection's fixed charges saved.
  - The Energy tab's new band "Heat pump instead of gas?", `api/energy/seasons` and the
    MCP `energy` view `seasons` compare the gas route with the heat pump for each heating
    season (October to April) and for the last 12 months, per degree day too.
  - The heat pump is set in energy.json's `heatPump`.
- **The supplier's markup.** A tariff's `importMarkup` adds the supplier's € per imported
  kWh, for price entities that leave it out; export is credited without it.
- Every day is closed again after the update.

## 0.5.3 — a wrong split is not kept

- **A day closed again keeps its old gas split only when the signals were purged for the
  whole day.** 0.5.1 kept a day's split whenever it could not be worked out again, so a
  wrong split stayed (the day the signals began, closed with 0.5.1). Every day is closed
  once more after this update.

## 0.5.2 — the gas split needs the whole day

- **A day's gas is split between hot water and heating only when the signals cover the
  whole day.** The signals must hold a gas meter reading from before midnight. A day the
  signals begin during (a new install, a move) stays unattributed. Before, the shares of
  its last hours stood for the whole day.
- **A fix to how days are closed closes every day again.** The ledger's version is now
  part of what each closed day records, so every day is closed again after this update.

## 0.5.1 — closing the days again after a configuration change

- **A change of energy.json or of Home Assistant's energy preferences closes the past days
  again.** Each closed day now records what it was closed with. A day closed with
  other sources, or with another energy.json, is closed again at the next run, in the
  background. Before, a closed day was final, so days closed before energy.json was
  written stayed without its water meter and gas split. A day whose boiler states are no
  longer in the signals keeps the gas split it had. The days 0.5.0 closed are closed
  once more after the update.

## 0.5.0 — the energy ledger and the Energy tab

- **Energy ledger.** Teobeanie now keeps the house's euros and quantities per hour, day,
  ISO week, month and year: grid import and export, solar, gas, water and each device
  of Home Assistant's energy dashboard. Each hour is priced at its own price.
  - Quantities come from Home Assistant's statistics.
  - Today is computed as it goes, with a projection to the end of the day.
  - Each past day is closed once, in the journal (`teob-energy`). At the first start
    every day the statistics hold is closed, up to five years, in the background.
  - A closed day keeps what Home Assistant forgets: the gas split between hot water and
    heating (from the boiler's states while the signals still hold them) and the
    showers `shower-summary` reported.
  - A counter that goes back or jumps (a reset, an integration added again) counts 0
    for that hour, and is flagged.
  - Degree days put heating costs of mild and cold weeks side by side.
- **Real past prices.** With `priceHistory` set and Home Assistant's EnergyZero
  integration, hours without price statistics are priced from EnergyZero's all-in
  hourly prices, through a service call that only returns data. Gas is the market price
  plus the taxes and markup, derived from the days both are known; days priced this way
  are marked estimated.
- **energy.json** (optional, in the working set):
  - tariffs over time: fixed charges, the energy tax credit, and the export price from
    a date on, for when net metering ends;
  - the price history;
  - a water meter the energy dashboard does not list;
  - the boiler states that split the gas;
  - each device's use (heating, cooling, hot water, ventilation).
  See [docs/energy.md](https://github.com/teob-cc/teobeanie/blob/main/docs/energy.md).
- **The Energy tab**:
  - today's euros so far and projected, by carrier and by use;
  - bars of days, weeks, months and years against a year earlier, per degree day;
  - today's and tomorrow's prices, with the cheapest and dearest hours;
  - a day's hours;
  - the showers;
  - what is wrong with the data.
  It reads only; it switches nothing.
- **MCP `energy`** gives an agent the same ledger: today, periods, or a day's hours.

## 0.4.1 — move to another install

- **Move to another install.** Home Assistant restores an add-on's backup only into the
  same slug; now a house can move from one Teobeanie install to another (the local
  add-on to the store's, or to a new Home Assistant box) with its history. **Export** on
  the Connect page writes the journal (a consistent copy taken while running), the
  revisions, the agent tokens' hashes, the config folder and, when asked, the signals to
  `teobeanie-move/<UTC time>/` in the config folder, with a sha256 per file. Copied into
  the new install's config folder, it is taken in at that install's first start when
  its journal is empty: all or nothing, journaled, and never twice. A person exports
  through the panel; no MCP tool does. See
  [docs/moving.md](https://github.com/teob-cc/teobeanie/blob/main/docs/moving.md).
- **Connect: Mint a token** is always clickable; an empty name gets a hint, Enter mints,
  and a disabled button looks disabled. Before, it looked enabled while it waited for a
  name, so a click did nothing.
- **Releases reach the store only with their images.** The store reads the version from
  `main`; `main` now moves to a release only after both images are pushed and pull
  without a login, so an update is never offered before it can be installed.

## 0.4.0 — develop and operate behaviours over MCP

- **Develop and operate over MCP.** New tools let an agent work on the behaviours
  through the same connection it explores with. Develop, in shadow: `package_list`,
  `package_install` (a starter package), `package_scaffold` (a new package with a
  passing spec), `file_read` and `file_write` (the config folder's working set only),
  `types`, `test_run` (the specs, with vitest's matchers, as the Studio runs them),
  `replay` (the recorder's last days, at most 7), `scope_add` (observe only),
  `instance_upsert` (shadow or off, or a twin) and `package_export` (your entity ids
  swapped for the package's roles, after a privacy scan). Operate: `instance_mode`,
  `scope_operate` (with a reason), `revisions`, `revision_diff`, `rollback`,
  `twin_compare`, `promote`, `pause`, `resume` and `command`. Every change is one
  revision, journaled as `mcp:<agent>` and listed with the tool call; a change the
  reload rejects leaves the folder as it was. An instance goes active only when its
  specs pass and it decided in shadow within the last day, or with a reason that is
  journaled. The operate tools are marked destructive, so a client asks first. No tool
  switches a device.
- **Replay evaluates facts.** A heuristic that reads a fact sees it over the replayed
  history, in `cli.js replay` and the `replay` tool.
- **The Studio's tests use vitest's matchers** (`toMatchObject`, `toContainEqual`,
  `toBeUndefined`, `expect.arrayContaining`, …), the same the `test_run` tool uses.
- **The skills develop and operate over the tools.** The SSH loop stays as the
  fallback, and asks for the Home Assistant token its command line needs.

## 0.3.1 — the agent port is token-only

On Home Assistant OS the host's port mapping shows every client of the agent port as
the Supervisor network's gateway, so 0.3.0's network check there refused every agent.
The agent port now trusts the agent token alone and no longer applies `mcp_networks`
(ingress still does, since Home Assistant passes the real client address). A valid,
unrevoked token is always served; wrong tokens are counted per address and in all, and
past the limit they get 429 without being hashed, so one bad client cannot lock out the
others. The local deploy script names a version after the commit, also for a tag.

## 0.3.0 — facts, revisions, explore and connect

- **Revisions and rollback.** Every applied change to the config folder is a numbered
  revision, its files kept under `/data/revisions`; the Heuristics tab lists them with
  who and what, shows a diff, and rolls back to any of them (a revision itself). Facts
  come back with their files and are evaluated again. The file watch now also reloads
  on changes in `heuristics/`, `packages/` and the lock.
- **Shadow twins.** `"twinOf"` runs a new version of an instance beside it in shadow,
  on the same inputs and facts; the panel shows where their decisions differ (per
  signal and per fact change), and Promote swaps
  them in one revision.
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
