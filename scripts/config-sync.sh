#!/usr/bin/env bash
# config-sync.sh — Teobeanie's config folder on Home Assistant OS, as a local working copy.
#
#   scripts/config-sync.sh pull <working copy>
#   scripts/config-sync.sh push <working copy>
#
# pull copies the add-on's config folder (heuristics.json, allowlist.json, tiles.json,
# teobeanie.lock.json, README.md, heuristics/, packages/) into the working copy, a git
# repository (made with `git init` when it is not one yet). It refuses a working copy
# with uncommitted changes.
#
# push checks that every JSON file it would copy parses, that the box has not changed
# since the last pull or push (the panel's editor and Studio write the same files), and
# that the working copy is committed, so the previous commit is always the way back.
# Then it copies packages/, heuristics/, allowlist.json, tiles.json and heuristics.json
# (in that order), never deletes a file on the box, and touches heuristics.json so the
# add-on's file watch reloads everything. It prints the add-on's reload line: a rejected
# reload keeps the running config, and says why in the add-on log and on the panel's
# Heuristics tab.
#
# Needs the "Terminal & SSH" add-on with your public key. Environment:
#   HA_SSH    user@host of that add-on (default root@homeassistant.local)
#   SSH_PORT  its port (default 22)
#   SLUG      the add-on's folder under /addon_configs; default: the one folder there
#             whose name ends in _teobeanie
#   FORCE=1   push over a box that changed since the last pull, or an uncommitted
#             working copy; pull over uncommitted changes
set -euo pipefail

usage() {
  sed -n '3,4p' "$0" | sed 's/^# //' >&2
  exit 2
}
[ $# -eq 2 ] || usage
cmd=$1
wc=${2%/}
case "$cmd" in pull | push) ;; *) usage ;; esac

HA_SSH=${HA_SSH:-root@homeassistant.local}
SSH_PORT=${SSH_PORT:-22}
FORCE=${FORCE:-0}
say() { printf 'config-sync: %s\n' "$*" >&2; }
die() {
  say "$*"
  exit 1
}
on_box() { ssh -o BatchMode=yes -p "$SSH_PORT" "$HA_SSH" "$@"; }

# The add-on's config folder, as the Terminal & SSH add-on sees it.
if [ -n "${SLUG:-}" ]; then
  slug=$SLUG
else
  found=$(on_box 'for d in /addon_configs/*_teobeanie; do [ -d "$d" ] && basename "$d"; done; true') ||
    die "cannot reach $HA_SSH over SSH (port $SSH_PORT): is the Terminal & SSH add-on running, with your key?"
  case $(printf '%s\n' "$found" | grep -c . || true) in
    0) die "no /addon_configs/*_teobeanie on $HA_SSH: is Teobeanie installed and started once? Or set SLUG" ;;
    1) slug=$found ;;
    *) die "several Teobeanie folders on $HA_SSH ($(echo $found)): set SLUG to one of them" ;;
  esac
fi
case "$slug" in *[!A-Za-z0-9_-]* | "") die "SLUG \"$slug\" is not a folder name" ;; esac
remote=/addon_configs/$slug

# The state of the box the working copy was last in step with: one sha256 line per file
# push may overwrite. Kept inside .git, so it is never committed.
remote_hashes() {
  on_box "cd '$remote' && { for f in heuristics.json allowlist.json tiles.json; do [ -f \"\$f\" ] && echo \"\$f\"; done; find heuristics packages -type f 2>/dev/null | grep -v '^heuristics/ha\.d\.ts\$'; } | sort | while read -r f; do sha256sum \"\$f\"; done"
}
state_file() { echo "$(git -C "$wc" rev-parse --absolute-git-dir)/teobeanie-config-sync.sha256"; }
dirty() { [ -n "$(git -C "$wc" status --porcelain)" ]; }

if [ "$cmd" = pull ]; then
  mkdir -p "$wc"
  git -C "$wc" rev-parse --is-inside-work-tree >/dev/null 2>&1 || git -C "$wc" init -q
  if dirty && [ "$FORCE" != 1 ]; then
    die "$wc has uncommitted changes: commit or stash them first (FORCE=1 overwrites them)"
  fi
  on_box "cd '$remote' && set -- && for f in heuristics.json allowlist.json tiles.json teobeanie.lock.json README.md heuristics packages; do [ -e \"\$f\" ] && set -- \"\$@\" \"\$f\"; done; [ \$# -gt 0 ] || { echo '$remote is empty' >&2; exit 1; }; tar -c -f - \"\$@\"" |
    tar -x -f - -C "$wc"
  remote_hashes >"$(state_file)"
  say "pulled $HA_SSH:$remote into $wc"
  git -C "$wc" status --short
  exit 0
fi

# push
git -C "$wc" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$wc is not a git repository: pull into it first"
if dirty && [ "$FORCE" != 1 ]; then
  die "$wc has uncommitted changes: commit them first, so the previous commit is the way back (FORCE=1 pushes anyway)"
fi

paths=()
for p in packages heuristics allowlist.json tiles.json heuristics.json; do
  [ -e "$wc/$p" ] && paths+=("$p")
done
[ ${#paths[@]} -gt 0 ] || die "nothing to push in $wc"

# Every JSON file that goes to the box must parse: a broken one would be rejected by the
# reload anyway, but this says which file and where before anything is copied.
json=()
while IFS= read -r f; do json+=("$f"); done < <(cd "$wc" && find "${paths[@]}" -name node_modules -prune -o -type f -name '*.json' -print)
if [ ${#json[@]} -gt 0 ]; then
  (cd "$wc" && node -e '
    let bad = 0;
    for (const f of process.argv.slice(1)) {
      try { JSON.parse(require("node:fs").readFileSync(f, "utf8")); }
      catch (e) { console.error(`config-sync: ${f}: ${e.message}`); bad = 1; }
    }
    process.exit(bad);' "${json[@]}") || die "fix the JSON above; nothing was copied"
fi

state=$(state_file)
now=$(remote_hashes)
if [ "$FORCE" != 1 ]; then
  [ -f "$state" ] || die "no record of a pull into $wc: pull first (FORCE=1 pushes anyway)"
  if [ "$now" != "$(cat "$state")" ]; then
    say "the box changed since the last pull or push (the panel's editor, the Studio, an add-on update):"
    diff <(cat "$state") <(printf '%s\n' "$now") | grep '^[<>]' | awk '{ print "  " $NF }' | sort -u >&2 || true
    die "pull first and merge, or FORCE=1 to overwrite those files"
  fi
fi

last_reload() { on_box "{ ha apps logs '$slug' 2>/dev/null || ha addons logs '$slug' 2>/dev/null; } | grep 'reload (' | tail -n 1" 2>/dev/null || true; }
before=$(last_reload)

# bsdtar (macOS) would add AppleDouble files and extended attributes.
extra=()
if tar --version 2>/dev/null | grep -q bsdtar; then extra=(--no-xattrs --no-mac-metadata); fi
COPYFILE_DISABLE=1 tar -c -f - ${extra[@]+"${extra[@]}"} --exclude '.DS_Store' --exclude 'node_modules' --exclude 'heuristics/ha.d.ts' -C "$wc" "${paths[@]}" |
  on_box "cd '$remote' && tar -x -o -f - && { [ -f heuristics.json ] && touch heuristics.json; true; }"
remote_hashes >"$state"
say "pushed $wc to $HA_SSH:$remote ($(git -C "$wc" rev-parse --short HEAD 2>/dev/null || echo 'no commit'))"

# The reload is a second after the last write; give it a moment, then show its line.
sleep 4
line=$(last_reload)
if [ -z "$line" ] || [ "$line" = "$before" ]; then
  say "no new reload line in the add-on log yet: check the panel's Heuristics tab"
elif printf '%s' "$line" | grep -q 'rejected'; then
  printf '%s\n' "$line" >&2
  die "the add-on rejected the new config and keeps running the previous one"
else
  printf '%s\n' "$line"
fi
