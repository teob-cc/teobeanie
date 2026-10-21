# Moving to another install

Home Assistant restores an add-on's backup only into the same slug. A house that moves
from one Teobeanie install to another, such as the local add-on `local_teobeanie` to the
store's add-on (`<repository hash>_teobeanie`), or to a new Home Assistant box, would
start again with an empty journal. Instead, the old install writes an export, you copy
it into the new install's config folder, and the new install takes it in at its first
start.

## What moves

| | |
|---|---|
| `journal.db` | the whole history: every decision, call, revision and token mint. A consistent copy taken while Teobeanie runs |
| `revisions/` | the config folder at each revision, so **Roll back…** and diffs keep working |
| `agent-tokens.json` | the agent tokens' salted hashes: your agents keep their tokens |
| `signals.db` | only when you tick **include the signals**: the recorded states (large; not in Home Assistant backups either) |
| the config folder | `heuristics.json`, `allowlist.json`, `tiles.json`, `teobeanie.lock.json`, `packages/`, `heuristics/`, `examples/` and anything else you keep there |

What does not move: the add-on's options (the Configuration and Network tabs, owned by
the Supervisor), and `views.db`, which the new install folds again from the journal at
its first start.

Never run two installs at once. Both would act on the same devices, both would want
the agent port 8199, and only one client may poll a Telegram bot.

## Steps

1. **Install the new add-on, but do not start it.** An export is taken in only by an
   install whose journal is empty. Note the new add-on's config folder: it is
   `/addon_configs/<its slug>/`, for example `/addon_configs/local_teobeanie/` for the
   local add-on, and the store's slug starts with the repository's hash. If the folder
   is not there yet, create it.
2. **Export.** In the old install's panel, open **Connect** → **Move this install** and
   press **Export**, with **include the signals** if you want the recorded states too.
   The export is written to `teobeanie-move/<UTC time>/` in the old add-on's config
   folder, for example `/addon_configs/local_teobeanie/teobeanie-move/20261021T143005Z/`.
3. **Stop the old add-on** right after the export, and switch off its **Start on boot**.
   What it journals after the export stays in its own journal.
4. **Copy the export folder** into the new add-on's config folder, under
   `teobeanie-move/`. Over the `addon_configs` Samba share, copy the folder across. With
   the Terminal & SSH add-on on the same box:

   ```bash
   mkdir -p /addon_configs/<new slug>/teobeanie-move
   cp -a /addon_configs/<old slug>/teobeanie-move/<UTC time> /addon_configs/<new slug>/teobeanie-move/
   ```

   For a new box, copy it over the network (Samba to your computer and on to the new
   box, or `scp` between the two SSH add-ons). Copy exactly one export: with two
   waiting, the new install takes neither and says which to keep.
5. **Set the new add-on's options by hand**: the Telegram bot token and chats,
   `telegram_commands`, the monitor settings, `time_zone`, `mcp_networks`,
   `shadow_mode`, and the agent port in the Network section.
6. **Start the new add-on.** Its log says
   `move: imported teobeanie-move/<UTC time> (Teobeanie <version>, <created>, <n> events)`,
   the folder becomes `<UTC time>.imported`, and the journal records the import. Config
   files the import replaced, and working-set files the export did not have, are kept
   in `<UTC time>.imported/replaced/`.
7. **Check**: the Heuristics tab lists the instances and their revisions, Decisions and
   the timeline show the old history, the Connect page shows where the history came
   from, and your agents connect with their old tokens (on a new box, point them at the
   new address).
8. **Clean up** once you are happy: uninstall the old add-on, and delete the export
   folders on both sides. An export holds a full copy of the journal, and the config
   folder is in the add-on's backups.

## Rolling back

Stop the new add-on and start the old one. The old install has everything up to the
export; what the new one journaled since stays in the new one.

## When the import does not happen

The new install starts normally either way; the log and the Connect page say why.

| Log | What to do |
|---|---|
| `not imported: this install's journal already has <n> events` | The new add-on ran before the export was in place. Uninstall it (removing its data), install it again, copy the export in, and start it. The warning repeats at every start until the folder is removed |
| `<n> exports wait in teobeanie-move/ … keep only the one to import` | Remove all but one export folder (the log names the newest) and restart |
| `… differs from the manifest: copy the folder again` | The copy is incomplete or changed. Copy the folder again |
| `written by a newer Teobeanie` | Update the new add-on first |
| `the import failed and the install is as it was` | Nothing was changed: the data dir and the config folder are put back. The reason follows in the log |
| `an import was interrupted` | The add-on stopped in the middle of an import. The data dir was put back, and the import runs again |

## What the import does

At start, before the config folder is read: when `teobeanie-move/` holds exactly one
export that is not yet imported, its manifest's sha256 for every file matches, and the
journal is empty (no `journal.db`, or no events in it), the import

- copies the export's data next to the data dir and checks it again;
- writes the export's config files over the config folder's. The working set
  (`heuristics.json`, `allowlist.json`, `tiles.json`, `teobeanie.lock.json`,
  `heuristics/` and `packages/`) becomes the export's, as its revisions say; every
  other file you keep there stays;
- sets the data dir's `journal.db`, `revisions/`, `agent-tokens.json` and `signals.db`
  aside, with `views.db` and the journal's `-wal` and `-shm` files, and renames the
  copies in;
- renames the export folder `<name>.imported`, which completes the import.

A failure before the rename puts everything back. After the rename, the next start
does not import it again.

Nothing in the journal or the revisions names the add-on's slug or its ingress path.
On a new Home Assistant box the Home Assistant user ids in old rows (who called a
service, who used the panel) belong to the old box; the names the journal resolved
when it recorded them stay as they were.
