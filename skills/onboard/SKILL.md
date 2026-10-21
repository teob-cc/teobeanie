---
name: onboard
description: Set up Teobeanie on a Home Assistant house with its owner. Checks the MCP connection, explores the house read-only with the owner's Home Assistant token, sums it up in one table, and suggests three starter packages whose roles fit the entities found, with the bindings and the reason for each. Use when someone has just installed Teobeanie, asks to set it up or onboard their house, or asks what Teobeanie could do for their house or which behaviours to start with.
---

# Onboard a house

Onboarding ends with three things. The owner knows what their house has, as Teobeanie
would see it. They have picked one to three first behaviours from the starter packages.
And nothing in the house or in Teobeanie's config has changed. Building the picked
behaviours is the `develop` skill's job.

Teobeanie is alpha (0.2). Its MCP tools are read-only. The config folder is edited as
files. Behaviours run in shadow until the owner says otherwise.

## Rules

- **Read only.** Use `GET` on Home Assistant's REST API, and `POST /api/template`, which
  only renders a template. Never `POST /api/services/…`, never a websocket
  `call_service`, never a write to the Supervisor. *Why:* onboarding comes before any
  trust. One stray call switches a real light in a real house.
- **Ask before anything that changes the house.** That covers Home Assistant, the
  add-on's options and the add-on's config folder. Onboarding itself changes none of
  them. *Why:* the owner decides, and a change they did not expect is how trust is lost.
- **The token is a secret.** Read it from `~/.config/teobeanie/ha-token` inside the
  command (`$(cat …)`). Never print it, echo it or paste it into the chat. *Why:* a
  long-lived admin token is the whole house.
- **House data stays private.** Entity ids, names, areas and people go into this
  conversation and the owner's own files. They never go into the public Teobeanie
  repository, an issue, a gist or a pull request. *Why:* a house's ids say who lives
  there and when they are home.
- **Say what a match is.** The inventory matches entities to roles by domain and device
  class only. A `switch` can be a coffee machine or the main water valve. Names, areas
  and the owner decide. *Why:* a confident wrong binding becomes a wrong behaviour.

## 1. Check the connection

Call the `teobeanie` MCP server's tools (in Claude Code: `mcp__teobeanie__<tool>`).

1. `whoami`: who the add-on thinks is calling, the network address and the house's
   time zone. Over the agent port the caller is `via: "agent"` with the token's name;
   through the bridge it is `via: "ingress"` with the Home Assistant user. Either way
   it proves the connection and the add-on work.
2. `house_scope`: what Teobeanie observes and may operate. On a fresh install there is
   no `allowlist.json` yet, so the scope is the starter's placeholder ids
   (`light.hallway`, `binary_sensor.front_door`, …). That is expected. `develop` writes
   the real scope.
3. `heuristics`: the instances that already run. A fresh install has none. If there are
   instances, this is not a first setup: show them, and offer `explain` or `develop`
   instead of starting over.

When the tools are missing or fail:

| Symptom | Fix |
|---|---|
| No `teobeanie` tools at all | The MCP server is not added. Steps 2 and 3 of `docs/getting-started.md`: the panel's **Connect** page mints a token and shows the line to run |
| `unauthorized: …` (401) | The agent token was revoked or mistyped. The owner mints a new one on the Connect page; run `claude mcp remove teobeanie`, then the new line |
| Connection refused, or a timeout, on port 8199 | The address is not reachable from this machine, or the agent port is closed or moved (the add-on's Configuration tab → **Network**) |
| `too many attempts` (429) | Too many wrong tokens from this address. Wait ten minutes |
| The bridge (the fallback) says "no Teobeanie add-on is installed" or "several Teobeanie add-ons" | Add `-e ADDON=<slug>` to `claude mcp add` (the slug is in the add-on page's URL, such as `abcd1234_teobeanie`) |
| `forbidden: client … is not in the allowed networks` | The client's address is outside the add-on's `mcp_networks` option. The owner adds their network there and restarts the add-on |
| The bridge says Home Assistant rejected the token | Make a new long-lived token (profile → Security) and save it to the file again |

## 2. Explore Home Assistant, read-only

The MCP tools see only Teobeanie's scope, so this step reads Home Assistant itself,
with a long-lived token of an administrator in `~/.config/teobeanie/ha-token`. When
the file is missing (`test -s ~/.config/teobeanie/ha-token`), ask the owner to make one:
profile → **Security** → **Long-lived access tokens**, saved to that file with an
editor, `chmod 600` ("Reading Home Assistant needs a token" in
`docs/getting-started.md`). Never ask them to paste it into the chat.

The inventory script reads `GET /api/config`, `GET /api/states` and one
`POST /api/template` for areas and devices. It matches the entities to every starter
package's roles (`teobeanie.json`):

```sh
HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=~/.config/teobeanie/ha-token \
  node "${CLAUDE_PLUGIN_ROOT}/skills/onboard/scripts/house-inventory.mjs"
```

`HA_URL` is Home Assistant's own address (port 8123): the host of the agent port's URL
(`claude mcp get teobeanie` shows it), or the bridge's `HA_URL`. Add
`--json` for every entity with its area, device, model and state. Pass a folder of
packages as the first argument to match other packages than the starter set.

By hand, the same three reads:

```sh
TOKEN="$(cat ~/.config/teobeanie/ha-token)"
curl -s -H "Authorization: Bearer $TOKEN" "$HA_URL/api/config"
curl -s -H "Authorization: Bearer $TOKEN" "$HA_URL/api/states"
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"template": "{{ areas() | map(\"area_name\") | list }}"}' "$HA_URL/api/template"
```

More templates that help: `{{ area_entities('Kitchen') }}` (one area's entities),
`{{ area_name('light.kitchen') }}` (an entity's area, or its device's),
`{{ device_attr('light.kitchen', 'model') }}` (its device's model).

Also find out what already automates the house. Count the `automation.*` entities. Ask
the owner whether Node-RED or another add-on runs automations. Entities that something
else already switches are fine for shadow: replay and the panel compare the two. If
Node-RED runs most of the house, the `nodered-migration` skill is the better path.

## 3. Sum up the house in one table

One row per area. Columns for what behaviours are built from: lights, switches,
presence and motion sensors, doors and windows, leak sensors, climate, covers, meters.
Under the table, one line each: how many entities, how many have no area, how many are
unavailable, how many automations exist.

Keep it to the shape of the house. Do not dump entity ids here. The owner should
recognise their home in it, and correct it ("the attic switch is the heat pump").

## 4. Suggest three starter packages

Pick three heuristics from the inventory's "fits" list. Prefer, in this order:

1. **Clear value for the people.** A light that follows presence in a room they use
   every day. A reminder for a door that is often left open. Ask, do not assume.
2. **Low risk first.** A notice (`door-watch`, `water-meter`) only tells. A light is
   easy to live with when it is wrong. A climate unit, a cover or a garage door moves
   real things: suggest those once the owner trusts the first ones.
3. **One area, complete bindings.** "Areas with every required role" are the easy
   wins.

`leak-guard` closes the main water valve and acts even through the global pause. It is
worth suggesting when the house has a valve and leak sensors. Say plainly what it does
in active mode, and that it never reopens the valve by itself.

For each suggestion, read the package's `README.md` (in
`${CLAUDE_PLUGIN_ROOT}/packages/<name>/`, or `heuristic_source` with the package name)
for its guarantees and its `example.json` for the params. Then give one row:

| # | Package · heuristic | Bindings (role → entities) | Settings to decide | Why |
|---|---|---|---|---|
| 1 | `sensor-light` · `sensor-light` | `sensors` → `binary_sensor.hallway_motion`; `lights` → `light.hallway` | `offAfterMin` (3) | The hallway has a motion sensor and one light, and nobody switches it by hand |

One sentence of "why" each, in the owner's words. Under the table, the guarantee of each
in one line ("a light switched off by hand stays off until the room has been empty").
Mark every entity the behaviour would switch: that entity gets `"operate": true` later.

Then ask which ones to set up. None is a fine answer.

## 5. Hand over to develop

For the picked ones, the `develop` skill does the work: a git working copy of the
config folder, the scope, the instances in shadow, their specs, a replay of the last
days, the push, and the first shadow decisions. Before handing over, check what it
needs and ask before each:

- the **Terminal & SSH** add-on with the owner's public key
  (`ssh -o BatchMode=yes root@homeassistant.local true` succeeds);
- Node.js 22.18 or later and pnpm, for the specs and replay;
- a folder for the working copy (a private git repository, never a public one).

Say what happened so far: the house was read, nothing was changed, so there is nothing
to undo.
