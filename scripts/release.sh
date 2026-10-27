#!/usr/bin/env bash
# The local part of a release: scripts/release.sh <version>   (DRY_RUN=1 skips the pushes)
#
# Bumps every version spot and the changelog on a branch release/v<version> cut from an
# up-to-date main, runs the gates, commits, and pushes the branch and the tag v<version>.
# main may be ahead of origin/main: a change that names a new image (a new add-on folder)
# must not reach main before its image exists, so it reaches main only through the tag.
# main is NOT touched: the tag's workflow builds and pushes both images, checks that they pull
# anonymously, and only then fast-forwards main. Until then the add-on store keeps offering
# the previous version, whose image exists.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "release: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh <major.minor.patch>"
tag="v$version"
branch="release/$tag"
dry="${DRY_RUN:-}"
pm=npm; command -v pnpm >/dev/null && pm=pnpm
changelog=teobeanie/CHANGELOG.md

step "Preconditions"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
git fetch --quiet origin main --tags
git merge-base --is-ancestor origin/main HEAD || die "origin/main has commits main lacks (pull first)"
ahead="$(git rev-list --count origin/main..HEAD)"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"
git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 && die "branch $branch already exists on origin"
current="$(grep '^version:' teobeanie/config.yaml | cut -d'"' -f2)"
[ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)" = "$version" ] && [ "$current" != "$version" ] \
  || die "$version is not newer than the current $current"
if grep -q '^## Unreleased' "$changelog"; then
  :
elif [ "$(grep -m1 '^## ' "$changelog" | sed -E 's/^## ([0-9.]+).*/\1/')" = "$version" ]; then
  :
else
  die "$changelog has neither an '## Unreleased' section nor a newest '## $version' section"
fi
echo "main is clean and $ahead commit(s) ahead of origin/main; $current -> $version"

step "Branch $branch"
git switch -c "$branch"

step "Version spots"
perl -pi -e 's/^version: "[^"]+"/version: "'"$version"'"/' teobeanie/config.yaml whisper/config.yaml
perl -pi -e 's/^(export const SDK_VERSION = )"[^"]+"/$1"'"$version"'"/' src/packages/manifest.ts
for f in package.json panel/package.json .claude-plugin/plugin.json; do
  perl -0pi -e 's/("version":\s*)"[^"]+"/$1"'"$version"'"/' "$f"
done
perl -pi -e 'if (!$done && s/^## Unreleased/## '"$version"'/) { $done = 1 }' "$changelog"
git diff --stat

step "Gates"
set -o pipefail
$pm run typecheck 2>&1 | tail -5
$pm --filter teobeanie-panel run typecheck 2>&1 | tail -5
$pm test 2>&1 | tail -8
node scripts/privacy-scan.mjs 2>&1 | tail -5

step "Commit and tag"
git add -A
git commit -q -m "release: $version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag -a "$tag" -m "$tag"
git log --oneline -1

step "Push"
if [ -n "$dry" ]; then
  echo "DRY_RUN: would run: git push origin $branch $tag"
else
  git push origin "$branch" "$tag"
fi

cat <<NEXT

Next:
  1. The tag run (Actions, workflow "CI & add-on images" on $tag) tests, builds amd64 and
     aarch64, pushes ghcr.io/teob-cc/{arch}-{teobeanie,teobeanie-whisper}:$version, checks anonymous pulls
     (scripts/check-images.sh $version) and fast-forwards main to $tag.
  2. When it is green, main carries $version and the store offers it. Then: git switch main && git pull --ff-only.
     Delete the branch if you like: git push origin --delete $branch
  3. If "promote" fails because main moved: delete the tag and branch (git push origin --delete $tag $branch),
     and run scripts/release.sh $version again from the new main. If an image build fails, main is untouched:
     fix on main, delete the tag and branch, release again.
NEXT
