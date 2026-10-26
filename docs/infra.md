# The Infra tab

The house's infrastructure as Home Assistant sees it now: the internet link, the Wi-Fi
mesh, the devices on the network, the tailnet and Home Assistant's own health, with what
needs a look on top. Everything on it is read live from Home Assistant's states and
registries; nothing is typed in, so nothing on it goes stale. It reads every entity Home
Assistant has, not only the house scope: most infrastructure is outside the scope. It is
read-only and switches nothing. The tab shows once there is something to show.

## Where each part comes from

| Part | Source | Shows |
|---|---|---|
| Alerts | the parts below, and the cards on the tab | what is bad (red) or needs a look (amber), with since when |
| Internet | a gateway that speaks UPnP (the `upnp` integration), by translation key: `wan_status`, `external_ip`, `download_speed`, `upload_speed`, `uptime` | the link up or down, the external address, the traffic now, since when the gateway runs. The uptime sensor is disabled in Home Assistant by default; enable it to see gateway restarts |
| Wi-Fi mesh | TP-Link Deco (`tplink_deco`): its trackers of `device_type` `deco` and their sensors, found by the end of their unique id (`_cpu_usage`, `_mem_usage`, `_client_count`, `_connection_type`, `_backhaul_speed`, `_internet_online`) | each node up or down, the main node, CPU, memory, clients, backhaul, firmware |
| Devices | see below | each device online or offline, since when, how the router sees it |
| Tailnet | Tailscale (`tailscale`): the connectivity sensors | each machine connected or not |
| Home Assistant | `update` entities that are on; devices whose every entity is unavailable; connectivity sensors no other part shows | updates waiting, devices it cannot reach (by integration), bridges and links (a Zigbee bridge, a meter's link) |
| Cards | `tiles.json` `infra.cards` | the instance cards, as on the House page |

## Devices: extracted, not listed

A device is on the list when a live source says it is on the network:

- **Known**: every device Home Assistant integrates that has a MAC address in the device
  registry (a camera, a NAS, a printer, an oven, a climate unit's adapter). Its name is the
  one Home Assistant gives it; two integrations that know the same thing (a TV as a TV and
  as a media renderer) make one row. Online comes from its own integration: a connectivity
  sensor of its own when it has one, else offline when every entity of its own is
  unavailable. When a router's tracker (`source_type: router`) has the same MAC and sees
  it home, the row adds the router's node, band or wire, and address.
- **Ping**: every host the Ping integration watches. This is the way to watch a device no
  integration knows (a switch, an inverter on another Wi-Fi): add the Ping integration
  for its address.
- **Other clients**: the router's clients that are online and match no known device, by
  the name they give. They come and go (phones, laptops, guests); one that leaves is not
  an alert.

A router's own record of a client (the Deco integration makes a device per client) never
counts as a known device: the router shows where a device is, the device's own
integration whether it works.

## Alerts

| Alert | When |
|---|---|
| Internet down | the WAN status is off |
| a node offline, no internet, CPU or memory at 90 % | the mesh node says so |
| a device offline | a known device or Ping host offline for 10 minutes |
| off the tailnet | a Tailscale machine whose device model is `linux` (a server) is not connected; a laptop or phone off the tailnet is normal |
| updates waiting | any `update` entity is on |
| unreachable | a device's every entity unavailable for 30 minutes, by integration |
| disconnected | a leftover connectivity sensor is off (unavailable is no report, not an alert) |
| a card's field | a card on the tab has a field with tone bad or warn |

## Cards on the tab: `infra` in tiles.json

```json
{
  "tiles": [],
  "infra": { "cards": ["health-watch/*", "lan-devices"] }
}
```

Each entry is an instance key (`health-watch/nas`), a heuristic id (`lan-devices`: all its
instances) or a glob (`health-watch/*`). Those cards show on the Infra tab, after its
parts, and leave the House page. Without `infra` every card stays on the House page.

## API

`GET api/infra` (`InfraView` in `src/infra/view.ts`): `{ at, available, registry, alerts,
internet, mesh, devices, servers, ha: { updates, unreachable, links }, cards }`. The panel
reads it on opening the tab and every 15 seconds while the tab is in view. Registries come
from `config/entity_registry/list` and `config/device_registry/list` (with the devices'
MAC connections), cached for 10 minutes and read again after a registry event or a
reconnect.
