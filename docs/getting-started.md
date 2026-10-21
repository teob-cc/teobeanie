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

2. **Mint a token for your agent.** Open **Teobeanie** in the sidebar → **Connect**.
   Name the token after the agent and the machine it runs on ("Claude Code on my
   laptop") and press **Mint a token**. The page shows the token once.

3. **Paste the line.** The page shows the line for Claude Code. Copy it and run it in
   a terminal:

   ```sh
   claude mcp add --transport http teobeanie http://homeassistant.local:8199/mcp --header "Authorization: Bearer <token>"
   ```

   The page fills in the address your browser uses for Home Assistant. If your agent's
   machine reaches Home Assistant by another name (a tailnet name, say), change it on
   the page. The machine must be on your LAN or your tailnet.

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

The agent checks the connection, reads your house and sums it up in one table, one row
per area. It suggests three starter packages that fit what you have: a light that
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

## Reading Home Assistant needs a token

The MCP tools see only what Teobeanie watches. To explore the rest of Home Assistant
while onboarding, to type the scope and to replay history, the agent reads Home
Assistant itself with a long-lived token of an administrator. It asks you for one when
it gets there: in Home Assistant, open your profile → **Security** → **Long-lived
access tokens** and create one. Save it to `~/.config/teobeanie/ha-token` (make the
folder with `mkdir -p ~/.config/teobeanie`, paste the token in with an editor) and keep
it to yourself (`chmod 600 ~/.config/teobeanie/ha-token`).

## Editing the config needs SSH

Reading the house over MCP needs only the agent token. Changing Teobeanie's config folder from your
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

Any MCP client that speaks Streamable HTTP works: the Connect page also shows the JSON
for clients configured with an `mcpServers` file. Mint one token per agent. The tools
are read-only, the same for every client, and every call is journaled with the token's
name (`tool_calls`). A client that speaks only stdio uses the bridge below. The skills
are plain Markdown in [skills/](../skills): an agent that reads instructions can follow
them.

## Agent tokens

- The agent port (8199) serves the MCP endpoint and nothing else: no panel, no API.
  Every request needs a valid agent token, from an address in the add-on's
  `mcp_networks` option (the private LAN ranges and Tailscale by default).
- Teobeanie keeps only a salted hash of each token. Lost the token? Revoke it and mint
  a new one.
- **Revoke** on the Connect page refuses the token from the agent's next request on.
  Minting and revoking are journaled with who did it.
- The port speaks plain HTTP, so the token crosses your LAN unencrypted. Your tailnet
  encrypts it. Do not forward the port to the internet.
- The host port can be changed, or cleared to close the port, on the add-on's
  Configuration tab under **Network**. The Connect page reads the port from there.

## Fallback: the bridge through ingress

Without the agent port (you closed it, or your client speaks only stdio), the bridge
connects through Home Assistant ingress with a long-lived admin token (made as in
[Reading Home Assistant needs a token](#reading-home-assistant-needs-a-token)). It
needs Node.js 22 or later.

```sh
curl -fsSL https://raw.githubusercontent.com/teob-cc/teobeanie/main/scripts/teobeanie-mcp-bridge.mjs -o ~/.config/teobeanie/mcp-bridge.mjs
claude mcp add teobeanie -e HA_URL=http://homeassistant.local:8123 -e HA_TOKEN_FILE=~/.config/teobeanie/ha-token -- node ~/.config/teobeanie/mcp-bridge.mjs
```

Use Home Assistant's address on your LAN or your tailnet for `HA_URL`. Calls through
the bridge are journaled with your Home Assistant user.

## Troubleshooting

| Problem | Fix |
|---|---|
| The agent cannot connect to port 8199 | The address is one your agent's machine cannot reach, or the port is closed or moved: check **Network** on the add-on's Configuration tab, and the address on the Connect page |
| MCP refused: `unauthorized: …` (401) | The token was revoked, or mistyped. Mint a new one on the Connect page and run the new line (`claude mcp remove teobeanie` first) |
| MCP refused: `too many attempts` (429) | Too many wrong tokens from your address. Wait ten minutes |
| The bridge cannot find the add-on ("no Teobeanie add-on is installed", "several Teobeanie add-ons") | Name it: add `-e ADDON=<slug>` to `claude mcp add`. The slug is in the add-on page's address, such as `abcd1234_teobeanie` |
| MCP refused: `forbidden: client … is not in the allowed networks` (403) | Your machine's address is outside the add-on's `mcp_networks` option (default: the private LAN ranges and Tailscale). Add your network there and restart the add-on |
| Home Assistant rejected the token | Make a new long-lived token and save it to the file again |
| A reload was rejected after a push | The add-on keeps the previous config. The reason is in the add-on's log (Settings → Add-ons → Teobeanie → Log) and on the panel's Heuristics tab. Fix the file, commit, push again |
| An instance stays in shadow after "active" | Someone turned the add-on's `shadow_mode` emergency switch on. Turn it off on the add-on's Configuration tab and restart; every instance set to active then acts |

Teobeanie is alpha (0.2). The MCP tools are read-only today. MCP tools to explore Home
Assistant, and to develop and operate behaviours, are on the
[roadmap](../README.md#roadmap), not yet in the add-on.
