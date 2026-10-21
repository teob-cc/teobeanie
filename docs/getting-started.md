# Getting started with your agent

You have Home Assistant OS and Claude Code. By the end of this page your agent knows
your house, Teobeanie runs your first behaviours in shadow, and you have seen what they
would have done over the last days. Nothing in the house acts until you say yes.

This is how it goes: five steps to install and connect, then one prompt. The agent
does the rest with you, and asks before anything that changes the house.

## Five steps

1. **Install Teobeanie.** Add the repository with this badge, install **Teobeanie**,
   and start it.

   [![Add repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fteob-cc%2Fteobeanie)

   It starts in shadow. The starter packages are in its config folder.

2. **Make a token.** In Home Assistant, open your profile → **Security** → **Long-lived
   access tokens**, and create one. Save it to `~/.config/teobeanie/ha-token`: make the
   folder (`mkdir -p ~/.config/teobeanie`), paste the token into that file with an
   editor, and keep it to yourself (`chmod 600 ~/.config/teobeanie/ha-token`).

   Make it as an administrator: the bridge opens an ingress session with it. The agent
   reads the house through Teobeanie's tools, so you do not need Home Assistant's own
   MCP server.

3. **Connect your agent.**

   ```sh
   curl -fsSL https://raw.githubusercontent.com/teob-cc/teobeanie/main/scripts/teobeanie-mcp-bridge.mjs -o ~/.config/teobeanie/mcp-bridge.mjs
   claude mcp add teobeanie -e HA_URL=http://homeassistant.local:8123 -e HA_TOKEN_FILE=~/.config/teobeanie/ha-token -- node ~/.config/teobeanie/mcp-bridge.mjs
   ```

   The bridge needs Node.js 22 or later. Use Home Assistant's address on your LAN or
   your tailnet for `HA_URL`.

4. **Add the skills.** In Claude Code:

   ```
   /plugin marketplace add teob-cc/teobeanie
   /plugin install teobeanie@teobeanie
   ```

5. **Paste the prompt.**

   > Set up Teobeanie on my Home Assistant with me. Use the teobeanie onboard skill.
   > Explore my house read-only, then suggest three first behaviours from the starter
   > packages that fit what I have, with the entities you would use and why. For the
   > ones I pick, set them up in shadow mode, run their specs and a replay of the last
   > days, and show me what they would have done. Make nothing active until I say
   > yes, and tell me how to undo each change.

## What happens next

The agent checks the connection, reads your house through Teobeanie (the areas,
devices and entities, their states, the recorder's history) and sums it up in one
table, one row per area. Nothing it reads outside the house scope is recorded. It suggests three starter packages that fit what you have: a light that
follows a motion sensor, a reminder for a door left open, a leak guard. Each comes with
the entities it would use and one sentence on why. You pick.

For the ones you pick, it pulls the add-on's config folder into a git working copy on
your machine, adds the entities to the scope (only the ones it switches may be
switched), adds the instances in **shadow**, runs their specs and replays them over the
last days. You see what they would have done next to what really happened. Then it
asks, and pushes the folder back.

In shadow an instance decides and writes down what it would do, and does nothing. Open
**Teobeanie** in the sidebar: the **Decisions** tab shows every decision with its
reason, marked "would". Turn on **Other calls: same entities** to see your current
automations' calls next to them, with a green tick where both did the same.

A day later, ask your agent how they did. It reads the shadow decisions with you
(`operate` skill), and when you say yes it makes one instance active, and tells you
how to undo it. Ask it "why did the hall light go off at 21:14?" at any time (`explain`
skill): it answers from the journal, with the event ids.

The skills are `onboard`, `develop`, `operate`, `explain` and `nodered-migration`
([skills/](../skills)).

## Editing the config needs SSH

Reading the house needs only the token. Changing Teobeanie's config folder from your
machine needs the **Terminal & SSH** add-on with your public key in its
`authorized_keys` option. `ssh root@homeassistant.local` should log you in without a
password. The agent checks this before it changes anything, and asks you to set it up
if it is missing. The develop skill also uses a clone of this repository, with Node.js
22.18 or later and pnpm, for the specs, the typings and replay.

## Without an agent

Everything the agent does goes through files and the panel, so you can do it by hand.
The panel's **Heuristics** tab has a **Library** of the packages: **Add an instance**
opens a form with the settings, their units and defaults, and checks it as you type.
The mode buttons on an instance switch it between shadow and active. The **Studio**
edits rules of your own, typed against your house, and runs their tests in the
browser. [working-set.md](working-set.md) is the guide to the config folder.

## Other agents

Any MCP client works: give it the same bridge command, `node
~/.config/teobeanie/mcp-bridge.mjs`, with `HA_URL` and `HA_TOKEN_FILE` in its
environment. The tools are read-only, the same for every client, and every call is
journaled (`tool_calls`). The skills are plain Markdown in [skills/](../skills): an
agent that reads instructions can follow them.

## Troubleshooting

| Problem | Fix |
|---|---|
| The bridge cannot find the add-on ("no Teobeanie add-on is installed", "several Teobeanie add-ons") | Name it: add `-e ADDON=<slug>` to `claude mcp add`. The slug is in the add-on page's address, such as `abcd1234_teobeanie` |
| MCP refused: `forbidden: client … is not in the allowed networks` | Your machine's address is outside the add-on's `mcp_networks` option (default: the private LAN ranges and Tailscale). Add your network there and restart the add-on |
| Home Assistant rejected the token | Make a new long-lived token and save it to the file again |
| A reload was rejected after a push | The add-on keeps the previous config. The reason is in the add-on's log (Settings → Add-ons → Teobeanie → Log) and on the panel's Heuristics tab. Fix the file, commit, push again |
| An instance stays in shadow after "active" | Someone turned the add-on's `shadow_mode` emergency switch on. Turn it off on the add-on's Configuration tab and restart; every instance set to active then acts |

Teobeanie is alpha (0.2). The MCP tools are read-only today. They explore all of Home
Assistant (`ha_registry`, `ha_states`, `ha_history`, `ha_services`, `suggest`) and the
house scope's record. MCP tools to develop and operate behaviours are on the
[roadmap](../README.md#roadmap), not yet in the add-on.
