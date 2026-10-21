import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type HealthReport } from "../api";
import type { HouseEntity, HouseView, TileSpecView } from "../../../src/house/view";
import { attention, compassPoint, num } from "../../../src/house/summary";
import { HouseSection } from "../components/HouseSection";
import { PackageCards } from "../components/PackageCard";
import { StatTile } from "../components/Tile";
import { fmtBytes, fmtNum, rel } from "../format";
import { since, stateText } from "../houseFormat";
import { useEnergyToday, useHouse, useNow } from "../useHouse";
import type { SseFrame } from "../useSse";

const HEALTH_POLL_MS = 10_000;
const OPEN_KEY = "teobeanie-house-open";
/** The key before the rename to Teobeanie, still read when the new one is absent. */
const OLD_OPEN_KEY = "teob-house-open";

/** A viewer's own open/closed choice per section; config "collapsed" is the default. */
function useSectionOpen(): [Record<string, boolean>, (id: string, open: boolean) => void] {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? localStorage.getItem(OLD_OPEN_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const set = useCallback((id: string, open: boolean) => {
    setState((prev) => {
      const next = { ...prev, [id]: open };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: the choice lasts for this page load
      }
      return next;
    });
  }, []);
  return [state, set];
}

export function House({
  subscribe,
  connected,
  onDecisions,
}: {
  subscribe: (fn: (f: SseFrame) => void) => () => void;
  connected: boolean;
  /** Open the Decisions feed filtered to an instance (a card's link). */
  onDecisions: (key: string) => void;
}) {
  const { view, error, reload, lastFrameAt } = useHouse(subscribe, connected);
  const now = useNow(1000);
  const hasEnergy = view?.sections.some((s) => s.id === "energy") ?? false;
  const energyToday = useEnergyToday(hasEnergy);
  const [openState, setOpen] = useSectionOpen();
  const all = useMemo(() => (view === null ? [] : Object.values(view.entities).filter((e) => e.section !== "")), [view]);
  const att = useMemo(() => attention(all), [all]);

  return (
    <div className="house">
      <header className="view-head">
        <h2>House</h2>
        {view !== null && (
          <span className="muted small tnum">
            {all.length} entities{view.scoped ? " in scope" : ""} · {connected ? (lastFrameAt !== null ? `live, last change ${rel(now, lastFrameAt)}` : "live") : "reconnecting…"}
          </span>
        )}
      </header>

      {error && (
        <div className="banner" role="alert">
          house view unavailable: {error}
          <button onClick={reload}>retry</button>
        </div>
      )}
      {view === null && !error && <p className="muted">loading the house…</p>}

      {view !== null && (
        <>
          <Attention att={att} now={now} />
          <Pinned view={view} now={now} />
          <PackageCards cards={view.cards ?? []} now={now} onDecisions={onDecisions} />
          {view.sections.map((s) => (
            <HouseSection
              key={s.id}
              section={s}
              entities={view.entities}
              outdoor={view.outdoor}
              energyToday={energyToday}
              now={now}
              open={openState[s.id] ?? !s.collapsed}
              onToggle={() => setOpen(s.id, !(openState[s.id] ?? !s.collapsed))}
            />
          ))}
          {!view.registry && <p className="muted small">Areas and devices are unavailable (Home Assistant's registries could not be read); grouping uses entity kinds only.</p>}
        </>
      )}

      <AddonStatus />
    </div>
  );
}

// ---- needs attention -------------------------------------------------------------

function Attention({ att, now }: { att: ReturnType<typeof attention>; now: number }) {
  const [showNa, setShowNa] = useState(false);
  const quiet = att.alerts.length === 0 && att.open.length === 0 && att.lowBatteries.length === 0;
  return (
    <section className="hattn" aria-label="needs attention">
      {quiet && <span className="chip chip-ok">✓ nothing open, no alarms</span>}
      {att.alerts.map((e) => (
        <span key={e.id} className="chip chip-bad" title={e.id}>
          ✕ {e.name}: {stateText(e, now)} · {since(now, e.changedAt)}
        </span>
      ))}
      {att.open.map((e) => (
        <span key={e.id} className="chip chip-warn" title={e.id}>
          ! {e.name} open · {since(now, e.changedAt)}
        </span>
      ))}
      {att.lowBatteries.map((e) => (
        <span key={e.id} className="chip chip-warn" title={e.id}>
          ! {e.name}: battery {stateText(e, now)}
        </span>
      ))}
      {att.unavailable.length > 0 && (
        <button className="chip chip-off hattn-na" aria-expanded={showNa} onClick={() => setShowNa((v) => !v)}>
          {att.unavailable.length} not reporting
        </button>
      )}
      {showNa && (
        <div className="hattn-list small muted">
          {att.unavailable.map((e) => (
            <span key={e.id} title={e.id}>
              {e.name} <i>({e.state || "no state"})</i>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- pinned: tiles.json tiles + groups.pin --------------------------------------

function tileValue(t: TileSpecView, e: HouseEntity | undefined, now: number): { value: string; unit: string } {
  if (e === undefined) return { value: "—", unit: "" };
  if (t.attribute !== undefined) {
    const v = e.attributes[t.attribute];
    const unitKey = t.attribute.startsWith("wind") && t.attribute !== "wind_bearing" ? "wind_speed_unit" : t.attribute.endsWith("temperature") ? "temperature_unit" : `${t.attribute}_unit`;
    const u = typeof e.attributes[unitKey] === "string" ? (e.attributes[unitKey] as string) : t.attribute === "humidity" ? "%" : "";
    const bearing = e.attributes["wind_bearing"];
    const extra = t.kind === "wind" && typeof bearing === "number" ? ` ${compassPoint(bearing)}` : "";
    return { value: typeof v === "number" ? fmtNum(v) : v === undefined || v === null ? "—" : String(v), unit: `${u}${extra}`.trim() };
  }
  const n = num(e);
  if (n !== null) {
    const u = e.attributes["unit_of_measurement"];
    return { value: fmtNum(n), unit: typeof u === "string" ? u : "" };
  }
  return { value: stateText(e, now), unit: "" };
}

function Pinned({ view, now }: { view: HouseView; now: number }) {
  const tiles: Array<{ key: string; label: string; entity: HouseEntity | undefined; spec?: TileSpecView }> = [
    ...view.tiles.map((t, i) => ({ key: `t${i}`, label: t.label, entity: view.entities[t.entityId], spec: t })),
    ...view.pinned.filter((id) => !view.tiles.some((t) => t.entityId === id && t.attribute === undefined)).map((id) => ({ key: id, label: view.entities[id]?.name ?? id, entity: view.entities[id] })),
  ];
  if (tiles.length === 0) return null;
  return (
    <section className="tile-grid tile-grid-pinned" aria-label="pinned">
      {tiles.map((t) => {
        const v = t.spec !== undefined ? tileValue(t.spec, t.entity, now) : { value: t.entity ? stateText(t.entity, now) : "—", unit: "" };
        return (
          <div className="tile" key={t.key} title={t.entity?.id}>
            <div className="tile-label">{t.label}</div>
            <div className="tile-value">
              {/^[-\d.,]+$/.test(v.value) ? <span className="num tnum">{v.value}</span> : <span className="txt">{v.value}</span>}
              {v.unit && <span className="unit">{v.unit}</span>}
            </div>
            <div className="tile-foot muted tnum">{t.entity !== undefined && t.entity.changedAt > 0 ? `changed ${rel(now, t.entity.changedAt)}` : "no data yet"}</div>
          </div>
        );
      })}
    </section>
  );
}

// ---- add-on status (was the House view's header row) ----------------------------

function AddonStatus() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [eventsPerMin, setEventsPerMin] = useState<number | null>(null);
  const prevSample = useRef<{ at: number; eventsSeen: number } | null>(null);

  // Health poll: stats row + events/min from consecutive eventsSeen samples.
  useEffect(() => {
    let stopped = false;
    const poll = () => {
      api
        .health()
        .then((h) => {
          if (stopped) return;
          setHealth(h);
          const sample = { at: Date.now(), eventsSeen: h.ha.eventsSeen };
          const prev = prevSample.current;
          if (prev && sample.at > prev.at) {
            const delta = sample.eventsSeen - prev.eventsSeen;
            setEventsPerMin(delta >= 0 ? (delta * 60_000) / (sample.at - prev.at) : null);
          }
          prevSample.current = sample;
        })
        .catch(() => {
          // keep the last health snapshot; the connection dot signals trouble
        });
    };
    poll();
    const t = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const haConnected = health?.ha.connected ?? false;
  return (
    <section className={open ? "hsec" : "hsec hsec-closed"}>
      <h3 className="hsec-head">
        <button className="hsec-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="hsec-chev" aria-hidden="true">
            ▸
          </span>
          <span className="hsec-title">Add-on</span>
          <span className="hsec-line">
            <span className={haConnected ? "ok-text" : "bad-text"}>{haConnected ? "✓ Home Assistant connected" : "✕ Home Assistant disconnected"}</span>
            {eventsPerMin !== null && <span className="muted"> · {fmtNum(eventsPerMin)} events/min</span>}
          </span>
        </button>
      </h3>
      {open && (
        <div className="stat-row hsec-body" aria-label="system status">
          <StatTile
            label="Home Assistant"
            value={<span className={haConnected ? "chip chip-ok" : "chip chip-bad"}>{haConnected ? "connected" : "disconnected"}</span>}
            sub={health ? `${health.ha.haVersion ?? "version ?"} · ${health.ha.reconnects} reconnects` : "waiting for health…"}
          />
          <StatTile label="Events / min" value={eventsPerMin === null ? "—" : fmtNum(eventsPerMin)} sub={health ? `${health.ha.eventsSeen.toLocaleString()} seen total` : "…"} />
          <StatTile label="Signal rows" value={health ? health.signals.rows.toLocaleString() : "—"} sub={health ? `${fmtBytes(health.signals.dbBytes)} ring` : "…"} />
          <StatTile label="Journal events" value={health ? health.journal.globalSeq.toLocaleString() : "—"} sub={health ? `${health.projections.cycles} projection cycles` : "…"} />
        </div>
      )}
    </section>
  );
}
