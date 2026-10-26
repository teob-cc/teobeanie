// Infra.tsx — the Infra tab: what needs a look, the internet link, the Wi-Fi mesh, the
// devices on the network, the tailnet, Home Assistant's own health, and the instance cards
// tiles.json "infra.cards" puts here. Everything is read live (api/infra,
// src/infra/view.ts); nothing on it is typed in. Read-only: it never calls a service.
// Its tab shows once api/infra answers available: true.

import { useEffect, useState, type ReactNode } from "react";
import type { InfraDevice, InfraReading, InfraView } from "../../../src/infra/view";
import { PackageCards } from "../components/PackageCard";
import { rel } from "../format";
import { since } from "../houseFormat";
import { useNow } from "../useHouse";
import { useInfra } from "../useInfra";
import type { VerticalProps } from "../verticals";

export function Infra({ connected, visible, onAvailable, onDecisions }: VerticalProps) {
  const { view, error, loadedAt, reload } = useInfra(visible, connected);
  const available = view?.available === true;
  useEffect(() => onAvailable(available), [available, onAvailable]);
  const now = useNow(5_000);

  if (view === null || !view.available) return null;
  return (
    <div className="infra">
      <header className="view-head">
        <h2>Infra</h2>
        <span className="muted small tnum">{loadedAt !== null ? `updated ${rel(now, loadedAt)}` : ""}</span>
      </header>
      {error !== null && (
        <div className="banner" role="alert">
          could not refresh: {error}
          <button onClick={reload}>retry</button>
        </div>
      )}
      <InfraBody view={view} now={now} onDecisions={onDecisions} />
    </div>
  );
}

/** The tab's sections for a view as it stands. */
export function InfraBody({ view, now, onDecisions }: { view: InfraView; now: number; onDecisions: (key: string) => void }) {
  return (
    <>
      <Alerts view={view} now={now} />
      <Internet view={view} now={now} />
      <Mesh view={view} now={now} />
      <Devices view={view} now={now} />
      <Servers view={view} now={now} />
      <HomeAssistant view={view} now={now} />
      <PackageCards cards={view.cards} now={now} onDecisions={onDecisions} />
      {!view.registry && <p className="muted small">Home Assistant's registries could not be read: no devices, mesh or names until they can.</p>}
    </>
  );
}

// ---- pieces ------------------------------------------------------------------------

/** A reading as people read it: a data rate in the larger unit once it is large. */
function readingText(r: InfraReading): string {
  const rate = /^(Ki?B)\/s$/.exec(r.unit);
  if (rate !== null && r.value >= 1000) return `${(r.value / 1024).toFixed(1)} M${r.unit.slice(1)}`;
  return `${Number.isInteger(r.value) ? r.value : r.value.toFixed(1)}${r.unit === "%" ? " %" : r.unit !== "" ? ` ${r.unit}` : ""}`;
}

function Status({ online, label }: { online: boolean | null; label?: [string, string] }) {
  const [up, down] = label ?? ["online", "offline"];
  if (online === null) return <span className="hrow-val muted">no report</span>;
  return <span className={online ? "chip chip-ok" : "chip chip-bad"}>{online ? up : down}</span>;
}

function Section({ title, line, count, children, closed = false }: { title: string; line?: string; count?: number; children: ReactNode; closed?: boolean }) {
  const [open, setOpen] = useState(!closed);
  return (
    <section className={open ? "hsec" : "hsec hsec-closed"} aria-label={title}>
      <h3 className="hsec-head">
        <button className="hsec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="hsec-chev" aria-hidden="true">
            ▸
          </span>
          <span className="hsec-title">{title}</span>
          {line !== undefined && <span className="hsec-line muted">{line}</span>}
          {count !== undefined && <span className="hsec-count muted small tnum">{count}</span>}
        </button>
      </h3>
      {open && (
        <div className="hsec-body">
          <div className="hgroup">{children}</div>
        </div>
      )}
    </section>
  );
}

function Row({ name, title, children, detail, age }: { name: string; title?: string; children?: ReactNode; detail?: string; age?: string }) {
  return (
    <div className="hrow">
      <div className="hrow-main" title={title}>
        <span className="hrow-name">{name}</span>
        {children}
        <span className="hrow-age muted small tnum">{age ?? ""}</span>
      </div>
      {detail !== undefined && detail !== "" && <div className="hrow-hist small muted">{detail}</div>}
    </div>
  );
}

const forHow = (now: number, at: number | undefined): string | undefined => (at === undefined ? undefined : `for ${since(now, at)}`);

// ---- sections ----------------------------------------------------------------------

function Alerts({ view, now }: { view: InfraView; now: number }) {
  return (
    <section className="hattn" aria-label="needs attention">
      {view.alerts.length === 0 && <span className="chip chip-ok">✓ nothing needs a look</span>}
      {view.alerts.map((a, i) => (
        <span key={i} className={a.tone === "bad" ? "chip chip-bad" : "chip chip-warn"}>
          {a.tone === "bad" ? "✕" : "!"} {a.text}
          {a.since !== undefined ? ` · ${since(now, a.since)}` : ""}
        </span>
      ))}
    </section>
  );
}

function Internet({ view, now }: { view: InfraView; now: number }) {
  const i = view.internet;
  if (i === null) return null;
  const speeds = [i.down !== undefined ? `↓ ${readingText(i.down)}` : "", i.up !== undefined ? `↑ ${readingText(i.up)}` : ""].filter((x) => x !== "").join("  ");
  return (
    <Section title="Internet" line={i.name}>
      <Row name="Link" age={forHow(now, i.since)}>
        <Status online={i.online} label={["up", "down"]} />
      </Row>
      {speeds !== "" && (
        <Row name="Traffic now">
          <span className="hrow-val tnum">{speeds}</span>
        </Row>
      )}
      {i.externalIp !== undefined && (
        <Row name="External address">
          <span className="hrow-val tnum">{i.externalIp}</span>
        </Row>
      )}
      {i.upSince !== undefined && (
        <Row name="Gateway up">
          <span className="hrow-val tnum">{since(now, i.upSince)}</span>
        </Row>
      )}
    </Section>
  );
}

function Mesh({ view, now }: { view: InfraView; now: number }) {
  if (view.mesh.length === 0) return null;
  const clients = view.mesh.reduce((n, m) => n + (m.clients ?? 0), 0);
  return (
    <Section title="Wi-Fi mesh" line={`${view.mesh.filter((m) => m.online).length} of ${view.mesh.length} nodes up${clients > 0 ? `, ${clients} clients` : ""}`} count={view.mesh.length}>
      {view.mesh.map((m) => {
        const parts = [
          m.main ? "main" : m.backhaul !== undefined ? `backhaul ${m.backhaul.type}${m.backhaul.speed !== undefined ? ` ${readingText(m.backhaul.speed)}` : ""}` : "",
          m.cpu !== undefined ? `CPU ${readingText(m.cpu)}` : "",
          m.memory !== undefined ? `memory ${readingText(m.memory)}` : "",
          m.clients !== undefined ? `${m.clients} clients` : "",
          m.internet === false ? "no internet" : "",
          m.firmware !== undefined ? `firmware ${m.firmware}` : "",
        ].filter((x) => x !== "");
        return (
          <Row key={m.name} name={m.name} age={forHow(now, m.since)} detail={parts.join(" · ")}>
            <Status online={m.online} />
          </Row>
        );
      })}
    </Section>
  );
}

function deviceDetail(d: InfraDevice): string {
  return [d.via, d.ip, d.integration !== undefined && d.kind !== "client" ? d.integration : undefined, d.model].filter((x): x is string => x !== undefined && x !== "").join(" · ");
}

function Devices({ view, now }: { view: InfraView; now: number }) {
  const [showClients, setShowClients] = useState(false);
  if (view.devices.length === 0) return null;
  const watched = view.devices.filter((d) => d.kind !== "client");
  const clients = view.devices.filter((d) => d.kind === "client");
  const offline = watched.filter((d) => d.online === false).length;
  return (
    <Section
      title="Devices"
      line={`${watched.length} known${offline > 0 ? `, ${offline} offline` : ""}${clients.length > 0 ? ` · ${clients.length} other clients online` : ""}`}
      count={view.devices.length}
    >
      {watched.map((d) => (
        <Row key={d.key} name={d.name} title={d.kind === "ping" ? "watched by the Ping integration" : `known to Home Assistant (${d.integration ?? "?"})`} age={forHow(now, d.since)} detail={deviceDetail(d)}>
          <Status online={d.online} />
        </Row>
      ))}
      {clients.length > 0 && (
        <div className="hrow">
          <button className="hrow-main" aria-expanded={showClients} onClick={() => setShowClients(!showClients)}>
            <span className="hrow-name">Other clients online</span>
            <span className="hrow-val muted tnum">{clients.length}</span>
            <span className="hrow-age muted small">{showClients ? "hide" : "show"}</span>
          </button>
        </div>
      )}
      {showClients &&
        clients.map((d) => (
          <Row key={d.key} name={d.name} title="a router client that matches no device Home Assistant knows" age={forHow(now, d.since)} detail={deviceDetail(d)}>
            <Status online={d.online} />
          </Row>
        ))}
    </Section>
  );
}

function Servers({ view, now }: { view: InfraView; now: number }) {
  if (view.servers.length === 0) return null;
  return (
    <Section title="Tailnet" line={`${view.servers.filter((s) => s.online === true).length} of ${view.servers.length} connected`} count={view.servers.length}>
      {view.servers.map((s) => (
        <Row key={s.name} name={s.name} age={forHow(now, s.since)}>
          <Status online={s.online} label={["connected", "not connected"]} />
        </Row>
      ))}
    </Section>
  );
}

function HomeAssistant({ view, now }: { view: InfraView; now: number }) {
  const { updates, unreachable, links } = view.ha;
  if (updates.length === 0 && unreachable.length === 0 && links.length === 0) return null;
  const unreachableCount = unreachable.reduce((n, g) => n + g.devices.length, 0);
  const line = [updates.length > 0 ? `${updates.length} update${updates.length === 1 ? "" : "s"} waiting` : "", unreachableCount > 0 ? `${unreachableCount} unreachable` : ""].filter((x) => x !== "").join(" · ");
  return (
    <Section title="Home Assistant" line={line || "all reachable, up to date"}>
      {links.map((l) => (
        <Row key={l.entity} name={l.name} title={l.entity} age={forHow(now, l.since)}>
          <Status online={l.online} label={["connected", "disconnected"]} />
        </Row>
      ))}
      {unreachable.map((g) =>
        g.devices.map((d) => (
          <Row key={`${g.integration}:${d.name}`} name={d.name} age={forHow(now, d.since)} detail={g.integration}>
            <span className="chip chip-warn">unreachable</span>
          </Row>
        )),
      )}
      {updates.map((u) => (
        <Row key={u.entity} name={u.name} title={u.entity}>
          <span className="hrow-val tnum">{u.installed !== undefined && u.latest !== undefined ? `${u.installed} → ${u.latest}` : (u.latest ?? "update")}</span>
        </Row>
      ))}
    </Section>
  );
}
