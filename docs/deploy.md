# Deploys and downtime

What a change costs the house while Teobeanie is not running: decisions due in the gap
fire late (timers are journaled and re-armed on start), a notice cut off mid-send is
resent once ([heuristics.md](heuristics.md#journal-grammar)), and nothing reacts to the
house until the first states snapshot is in again.

## Config changes: no downtime

`heuristics.json`, `allowlist.json` and `tiles.json` reload in-process
([heuristics.md](heuristics.md#changing-the-config-while-it-runs)): no HA reconnect, no
gap. An instance whose config changed is down for the time its runtime takes to stop
and replay its own stream, milliseconds; the others are not touched. Before this a
config change was an add-on restart, about 10 s.

The add-on options (Configuration tab) are still read once at start, so changing one
is still a restart.

## Code deploys

`scripts/deploy-local-addon.sh` copies a commit to the box as the local add-on
`local_teobeanie` and lets the Supervisor build the image on the device. `SLUG` names
another local add-on instead (`SLUG=<slug>` deploys to `/addons/<slug>` as
`local_<slug>`, and writes that slug into the copied `config.yaml`), so a house that
already runs one under a different slug keeps its data and config folder. What the
Supervisor does then decides the downtime (`supervisor/apps/app.py`):

| Call | Order | Teobeanie is down for |
|---|---|---|
| `rebuild` | stop and remove the container and the image, build, start | the whole build plus a start: about 33 s measured with an empty journal, more on a slow box or with a cold Docker cache |
| `update` (a new `version`) | build the new image while the old container runs, stop, start | a stop plus a start: the same as a restart, about 10 s |

So for a local add-on the Supervisor does not force stop-then-build: `rebuild` does,
`update` does not. `update` needs the store's version to differ from the installed one,
which a plain code change does not do. The script therefore stamps every deploy as
its own version, `<config.yaml version>-<commit>` (for example `0.2.0-4368ba8`), and
calls `update`; it falls back to `rebuild` only when that exact version is already
installed (the same commit deployed twice). It prints how long the step took.

The build time does not go away, it moves to before the stop. A failed build now
leaves the old version running instead of a stopped add-on.

### The rest of the 10 s

What remains is a container stop and start: SIGTERM and the graceful shutdown
(journal and databases closed), container creation, Node start, the HA websocket
connect and the first states snapshot. The Supervisor runs one container per add-on,
so the two versions cannot overlap; going below a restart would need a handover
inside one container (a supervisor process that starts the new code before stopping
the old), which is not worth it while timers and notices survive a restart.

### Prebuilt images

An install from the repository uses the images CI builds on a version tag,
`ghcr.io/teob-cc/{arch}-teobeanie:<version>`, named by `image:` in `config.yaml`. The
Supervisor then pulls the image while the old container runs, then stops and starts, so
the downtime is the same as a local `update`. It saves the box the build (minutes of
CPU on a small board) at the cost of publishing an image for every version. For branch
deploys the local `update` stays the better fit.

## Privacy scan before a push

The public tree must never hold one real house's data. `node scripts/privacy-scan.mjs`
scans the tracked files (or `node scripts/privacy-scan.mjs <folder>` any folder, such
as an exported package) and fails with `file:line: [rule] reason`. It checks, in order:

- a private deny list of words (people, places, street names), one per line, kept
  outside the repo in `~/.config/teobeanie/privacy-deny.txt` (override the path with
  `PRIVACY_DENY_FILE`, or pass the lines in `PRIVACY_DENY`; CI does this from a
  secret). Without a deny list the scan warns and runs the rest;
- Telegram chat ids and bot tokens, JWT-shaped Home Assistant tokens;
- private and tailnet IPv4 addresses, except the documented placeholders;
- entity ids (`light.hall`) whose object id is not a generic placeholder
  (the list is in `src/privacy.ts`; a file can be exempted with a reason in
  `scripts/privacy-allow.txt`).

Run it before every push, and fix a hit by renaming to a generic placeholder, not by
adding the house's name to an allowlist. The same checks are in `src/privacy.ts`
(`scanFolder`) for the package export. CI runs the scan on every push with the repo
secret `PRIVACY_DENY`.
