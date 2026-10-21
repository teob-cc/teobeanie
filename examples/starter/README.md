# Our house, for Teobeanie

This folder is what Teobeanie runs on. Change a file, save it, and a second later the
house follows (or tells you what is wrong with the change). Nothing here is code you
have to understand: three small files say what the house does.

| File | It says |
|---|---|
| `heuristics.json` | What runs: one entry per light, reminder or rule, and whether it only watches (`shadow`) or acts (`active`) |
| `allowlist.json` | What Teobeanie may see, and which things it may switch (`"operate": true`) |
| `tiles.json` | How the House tab is laid out: pinned tiles, names, groups |

`packages/` holds the behaviours: Teobeanie puts its starter set there when it starts,
and never overwrites one we changed. `heuristics/` holds rules of our own, written as
code, with a test next to each.
`heuristics/ha.d.ts`, `.teob/` and `tsconfig.json` are for editors; leave them alone.

The ids in this folder are placeholders. Replace them with ours (Home Assistant,
Developer tools, States). Everything starts in `shadow`: Teobeanie writes down what it
would do and does nothing. Switch one entry to `"mode": "active"` when its decisions
in the Decisions tab have looked right for a few days. To go back, set it to `shadow`.

Keep this folder in git: every change is then one line you can read and undo.

The full guide is `docs/working-set.md` in the Teobeanie repository. Typings for the
placeholder ids were written without Home Assistant. For the real house, run this once
and again whenever things are added or renamed:

    HA_URL=http://homeassistant.local:8123 HA_TOKEN=... node dist/studio/cli.js types <this folder>
