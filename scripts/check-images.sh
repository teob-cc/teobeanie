#!/usr/bin/env bash
# Fails unless ghcr.io/<owner>/{amd64,aarch64}-{teobeanie,teobeanie-whisper}:<version> can be pulled anonymously,
# which is how a Home Assistant install fetches it. Usage: scripts/check-images.sh [version]
# (default: teobeanie/config.yaml's). OWNER defaults to teob-cc.
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:-$(grep '^version:' teobeanie/config.yaml | cut -d'"' -f2)}"
owner="${OWNER:-teob-cc}"
missing=0
for image in teobeanie teobeanie-whisper; do
for arch in amd64 aarch64; do
  repo="${owner}/${arch}-${image}"
  token="$(curl -fsS "https://ghcr.io/token?scope=repository:${repo}:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/${repo}/manifests/${version}")"
  if [ "$code" = 200 ]; then
    echo "ok       ghcr.io/${repo}:${version}"
  else
    echo "MISSING  ghcr.io/${repo}:${version} (HTTP ${code}: absent, or the package is not public)" >&2
    missing=1
  fi
done
done
exit "$missing"
