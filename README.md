# Teobeanie

**Behaviours for Home Assistant as tested pure functions, with a journal of every
decision, built with your own AI agent over MCP.**

[![Add repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fteob-cc%2Fteobeanie)

Your house's behaviour, engineered the way serious software is. Home Assistant stays
the source of truth; Teobeanie keeps a small typed model of the part that matters and
runs behaviours on it as deterministic pure functions over an event-sourced journal of
immutable events. Every change goes through continuous delivery for the house: specs,
a replay against your real history, shadow, then active, and every step can be undone.
Your AI agent is the workbench: it explores, writes, tests and explains with the whole
record and the code in reach. Execution is plain deterministic code, with no LLM in the
loop.

> **Status: alpha (0.4).** Behaviours run in shadow next to your existing automations
> until you switch them on: they decide and journal what they *would* do, and the panel
> shows how often your current system did the same.

## Start with your agent

For Home Assistant OS and Claude Code:

1. Add the repository with the badge above, install **Teobeanie**, start it. It starts in shadow.
2. Open **Teobeanie** in the sidebar → **Connect**, name a token for your agent ("Claude Code on my laptop") and mint it.
3. Paste the line the page shows into a terminal: `claude mcp add --transport http teobeanie http://homeassistant.local:8199/mcp --header "Authorization: Bearer <token>"`.
4. Add the skills: `/plugin marketplace add teob-cc/teobeanie`, then `/plugin install teobeanie@teobeanie`.
5. Paste the prompt from [docs/getting-started.md](docs/getting-started.md): the agent explores your house read-only, suggests three first behaviours, and sets the ones you pick up in shadow.

The whole walk-through, with what happens next and troubleshooting, is
[docs/getting-started.md](docs/getting-started.md). An agent that speaks only stdio
connects through Home Assistant ingress with
[`scripts/teobeanie-mcp-bridge.mjs`](scripts/teobeanie-mcp-bridge.mjs) instead (the
fallback there).

**Skills** ([skills/](skills)): `onboard` (explore the house, suggest starter packages),
`develop` (a behaviour in shadow: scope, instance, specs, replay), `operate` (go active
with the owner's yes, the rollback named first, undo, the pause, refused actions),
`explain` (why something happened, from the journal), `nodered-migration` (move
Node-RED flows over, one at a time). They carry the guardrails the agent follows.

## What it is

- **Behaviours are code.** Each one is a package: a manifest, a pure `decide` function
  in TypeScript, its specs, a README and an example. The starter packages come
  pre-installed in the add-on's config folder, and they are yours to change.
- **Every decision is journaled** with its reason, the readings it used and the chain
  back to the sensor change that started it. "Why did the light go off at 21:14?" is a
  query, not log reading.
- **Shadow mode first.** An instance decides and journals without acting until you
  switch it to active.
- **One gate for every call.** The SafeActuator checks scope, ownership, bounds and rate
  limits on every service call, and a global pause stops them all.
- **Replay** runs a behaviour over recorded history before it touches anything.
- **Your agent works on it over MCP.** Read tools give it the house scope, state,
  who changed what, decisions and their chains, and the behaviours' source. Others
  explore all of Home Assistant (registries, states, history, services) and suggest
  the packages that fit, without recording what they read: Home Assistant's own MCP
  server is not needed. Develop and operate tools write the config folder one
  revision at a time (scope, instances in shadow, package code, specs, replay, going
  active, rollback, the pause); none of them switches a device. Each agent connects
  with a token of its own, minted and revoked in the panel, and every call is
  journaled with its name.

Built on [teob-ts](https://github.com/teob-cc/teob-ts), an event-sourcing framework.

## Install

Teobeanie is a Home Assistant **add-on** (Home Assistant OS or Supervised):

1. Click the badge above, or add `https://github.com/teob-cc/teobeanie` under
   **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Install **Teobeanie** (add-on slug `teobeanie`). The Supervisor pulls a prebuilt
   image for `amd64` or `aarch64`.
3. Start it. A **Teobeanie** panel appears in the sidebar, and it starts in **shadow
   mode**: nothing is actuated until you say so.

Updates use the normal add-on update flow: an **Update** button with the changelog.
Running Home Assistant Container or Core? The same app runs standalone with a
long-lived access token: see [DOCS](teobeanie/DOCS.md#running-outside-home-assistant-os).

## Architecture (short version)

```
HA WebSocket ──► allowlist bridge ──► signals.db (ring, 30 d)
   events           + detectors   └─► semantic commands ──► aggregates ──► journal.db (forever)
                                                               │                │
                                            SafeActuator ◄─────┘                └──► projections ──► ingress panel
                                        (bounds · ownership                          (timeline, live tiles,
                                         · shadow gate)                               energy, heuristics)
```

One Node.js process and SQLite files in `/data`. The long version is
[docs/architecture.md](docs/architecture.md); how heuristics are written, journaled and
tested is in [docs/heuristics.md](docs/heuristics.md), example config folders are in
[examples/](examples).

This repository is the plumbing (kernel, safety layer, panel, add-on) and the starter
packages in [`packages/`](packages). A house's own configuration and behaviours live in
the add-on's config folder, never in here.

## Roadmap

- Behaviour packages ✓
- Cards on the House page ✓
- MCP tools to explore Home Assistant ✓
- Facts (derived state) ✓
- Revisions and rollback ✓
- MCP tools to develop and operate behaviours ✓
- Next:
  - a Home Assistant notify channel
  - the landing page, teob.cc/home

## Development

```bash
pnpm install
pnpm build:all          # server (dist/) + panel (panel-dist/)
pnpm test
HA_WS_URL=ws://homeassistant.local:8123/api/websocket HA_TOKEN=... pnpm start
```

Standalone runs keep state in `./.dev-data` and read config from `CONFIG_DIR` (default
`./.dev-data`). They always run in shadow mode. Panel development with hot reload:
`pnpm --filter teobeanie-panel dev` (proxies `/api` to :8099).

To develop against a local teob-ts checkout, add a `link:../teob-ts` override in
`pnpm-workspace.yaml` locally (see the comment there); CI and images use npm.

### Running your branch on your own Home Assistant

`scripts/deploy-local-addon.sh [commit]` copies a commit to the box and installs it as
the local add-on `local_teobeanie`, or updates it if it is already installed. Home
Assistant builds the image itself. It needs the Terminal & SSH add-on with your key, and
`HA_TOKEN`. `SLUG=<slug>` deploys to a local add-on under another slug instead
(`local_<slug>`, its own data and config folder). Each commit deploys as its own
version, so the new image is built while the old one still runs;
[docs/deploy.md](docs/deploy.md) has the downtime of each kind of change.

### Moving a house to another install

A backup restores only into the same slug. To move from a local add-on to the store's,
or to a new Home Assistant box, export on the panel's Connect page and copy the export
into the new add-on's config folder before its first start:
[docs/moving.md](docs/moving.md).

### Releasing

1. Bump the version in `package.json`, `teobeanie/config.yaml`, `SDK_VERSION` in
   `src/packages/manifest.ts` and `.claude-plugin/plugin.json` (a test keeps them
   equal), and add a `teobeanie/CHANGELOG.md` entry.
2. Commit, then tag `v<version>` and push the tag.
3. CI tests, lints and builds the `amd64` and `aarch64` images, and pushes
   `ghcr.io/teob-cc/{arch}-teobeanie:<version>` on the tag. `config.yaml`'s `image:`
   points there, so installs and updates pull exactly that version.

Pushes to `main` and pull requests run the same checks and image build without
publishing. Before every push, run the privacy scan (`node scripts/privacy-scan.mjs`,
see [docs/deploy.md](docs/deploy.md#privacy-scan-before-a-push)).

## License

Apache-2.0
