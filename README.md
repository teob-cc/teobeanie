# Teobeanie

**Behaviours for Home Assistant as tested pure functions, with a journal of every
decision, built with your own AI agent over MCP.**

[![Add repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fteob-cc%2Fteobeanie)

> **Status: alpha (0.2).** Heuristics run in shadow mode next to your existing
> automations: they decide and journal what they *would* do, and the panel shows how
> often your current system did the same.

Getting started with your agent: [docs/getting-started.md](docs/getting-started.md)

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
- **Your agent works on it over MCP.** Read-only tools give it the house scope, state,
  who changed what, decisions and their chains, and the behaviours' source.

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
- Next:
  - facts (derived state)
  - revisions and rollback
  - MCP tools to explore Home Assistant, and to develop and operate behaviours
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

### Releasing

1. Bump the version in `package.json`, `teobeanie/config.yaml` and `SDK_VERSION` in
   `src/packages/manifest.ts` (a test keeps them equal), and add a
   `teobeanie/CHANGELOG.md` entry.
2. Commit, then tag `v<version>` and push the tag.
3. CI tests, lints and builds the `amd64` and `aarch64` images, and pushes
   `ghcr.io/teob-cc/{arch}-teobeanie:<version>` on the tag. `config.yaml`'s `image:`
   points there, so installs and updates pull exactly that version.

Pushes to `main` and pull requests run the same checks and image build without
publishing. Before every push, run the privacy scan (`node scripts/privacy-scan.mjs`,
see [docs/deploy.md](docs/deploy.md#privacy-scan-before-a-push)).

## License

Apache-2.0
