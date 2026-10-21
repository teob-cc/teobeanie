#!/usr/bin/env bash
# Install or update Teobeanie as a *local* add-on on a Home Assistant OS box, built on
# the device from a commit of this repository (no published images involved).
#
# Needs: SSH to the "Terminal & SSH" add-on (key auth), and a long-lived HA token in
# HA_TOKEN. The add-on's own configuration (heuristics.json, ...) is not touched.
#
#   HA_HOST=homeassistant.local HA_TOKEN=... scripts/deploy-local-addon.sh [commit]
#
# SLUG (default teobeanie) names the local add-on: it lives in /addons/$SLUG and the
# Supervisor knows it as local_$SLUG. A house that already runs a local add-on under
# another slug passes that slug, so the same add-on (its data and config folder) is
# updated in place.
set -euo pipefail
cd "$(dirname "$0")/.."
HA_HOST="${HA_HOST:-homeassistant.local}"
REV="${1:-HEAD}"
: "${HA_TOKEN:?set HA_TOKEN to a long-lived Home Assistant token}"
SLUG="${SLUG:-teobeanie}"
DIR="/local_apps/$SLUG"   # the SSH add-on's view of /addons on current HA OS

# Every commit is its own add-on version (0.2.0-<sha>), so the Supervisor sees an update:
# an update builds the new image while the old container runs and only then swaps
# them, where a rebuild stops the add-on first (docs/deploy.md).
VERSION="$(git show "$REV:teobeanie/config.yaml" | sed -n 's/^version: "\(.*\)"$/\1/p')-$(git rev-parse --short "$REV^{commit}")"

git archive "$REV" | ssh -o BatchMode=yes "root@$HA_HOST" "
  set -e
  rm -rf $DIR.new && mkdir -p $DIR.new && tar -x -C $DIR.new
  cd $DIR.new
  cp teobeanie/Dockerfile teobeanie/DOCS.md teobeanie/CHANGELOG.md .
  cp -r teobeanie/translations .
  # no image: the Supervisor builds locally; the slug names this local add-on
  sed -e '/^image:/d' -e 's/^version: .*/version: \"$VERSION\"/' -e 's/^slug: .*/slug: $SLUG/' teobeanie/config.yaml > config.yaml
  rm -rf teobeanie repository.yaml test
  rm -rf $DIR && mv $DIR.new $DIR"
echo "copied $(git rev-parse --short "$REV^{commit}") to $HA_HOST:$DIR as version $VERSION"

# Install on first run; afterwards update to the new version, or rebuild when this
# version is already installed (the same commit again). Through the websocket
# supervisor API (the REST proxy refuses these calls).
HA_HOST="$HA_HOST" VERSION="$VERSION" ADDON="local_$SLUG" node --input-type=module -e '
  const host = process.env.HA_HOST;
  const addon = process.env.ADDON;
  const ws = new WebSocket(`ws://${host}:8123/api/websocket`);
  let id = 0; const pending = new Map();
  const sv = (endpoint, method = "post", data) => new Promise((res) => { const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, type: "supervisor/api", endpoint, method, ...(data ? { data } : {}), timeout: 1200 })); });
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "auth_required") return ws.send(JSON.stringify({ type: "auth", access_token: process.env.HA_TOKEN.trim() }));
    if (m.type === "auth_invalid") { console.error("HA token rejected"); process.exit(1); }
    if (m.type !== "auth_ok") { if (pending.has(m.id)) pending.get(m.id)(m); return; }
    await sv("/store/reload");
    const info = await sv(`/addons/${addon}/info`, "get");
    const step = !info.success ? "install" : info.result?.version === process.env.VERSION ? "rebuild" : "update";
    const t0 = Date.now();
    const r = await sv({
      install: `/store/addons/${addon}/install`,
      update: `/store/addons/${addon}/update`,
      rebuild: `/addons/${addon}/rebuild`,
    }[step]);
    if (!r.success) { console.error(`${step} failed: ${JSON.stringify(r.error)}`); process.exit(1); }
    console.log(`${step} took ${Math.round((Date.now() - t0) / 1000)} s (${info.result?.version ?? "new"} → ${process.env.VERSION})`);
    if (step === "install") {
      // Show in the sidebar and let the watchdog follow the Docker health check.
      await sv(`/addons/${addon}/options`, "post", { ingress_panel: true, watchdog: true });
      await sv(`/addons/${addon}/start`);
    }
    console.log(`${step} done: ${addon}`);
    ws.close();
  };' 
