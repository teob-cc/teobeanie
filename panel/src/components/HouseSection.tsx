// HouseSection.tsx — one House section: a header with its one-line summary (always
// visible, also collapsed), the section's picture, and every entity below it,
// grouped (by area, device or kind). Read-only: nothing here calls Home Assistant.

import { useMemo, useState, type ReactNode } from "react";
import { kindLabel, type AreaSource, type LayoutGroup, type LayoutSection } from "../../../src/house/layout";
import type { EnergyToday, HouseEntity, HouseView } from "../../../src/house/view";
import {
  climateSummary,
  compassPoint,
  energySummary,
  isActive,
  isAvailable,
  lightsSummary,
  openingsSummary,
  outdoorSummary,
  presenceSummary,
  safetySummary,
  brightnessPct,
} from "../../../src/house/summary";
import { api, type SignalPoint } from "../api";
import { fmtNum, rel } from "../format";
import { clockTime, fmtWatts, shortName, since, stateText, stateTone, weatherLabel } from "../houseFormat";
import { BarList, Co2Meter, Compass, EnergyFlow, SegBar, SunArc, ThermoRows, type ThermoRow } from "./HouseViz";
import { EntityTimeline } from "./EntityTimeline";
import { Sparkline } from "./Sparkline";

export interface SectionProps {
  section: LayoutSection;
  entities: HouseView["entities"];
  outdoor: HouseView["outdoor"];
  energyToday: EnergyToday | null;
  now: number;
  open: boolean;
  onToggle: () => void;
}

export function HouseSection({ section, entities, outdoor, energyToday, now, open, onToggle }: SectionProps) {
  const members = useMemo(
    () => section.groups.flatMap((g) => g.entities.map((id) => entities[id]).filter((e): e is HouseEntity => e !== undefined)),
    [section, entities],
  );
  const { line, picture } = useMemo(() => summarize(section.id, members, outdoor, energyToday), [section.id, members, outdoor, energyToday]);
  const [showAll, setShowAll] = useState(false);
  const bodyId = `house-sec-${section.id}`;
  return (
    <section className={open ? "hsec" : "hsec hsec-closed"} aria-labelledby={`${bodyId}-h`}>
      <h3 className="hsec-head" id={`${bodyId}-h`}>
        <button className="hsec-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="hsec-chev" aria-hidden="true">
            ▸
          </span>
          <span className="hsec-title">{section.title}</span>
          <span className="hsec-line">{line}</span>
          <span className="hsec-count muted small tnum">{members.length}</span>
        </button>
      </h3>
      {open && (
        <div className="hsec-body" id={bodyId}>
          {picture(now)}
          <button className="hsec-more small" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Hide entities" : members.length === 1 ? "Show the entity" : `All ${members.length} entities`}
          </button>
          {showAll && (
            <div className="hgroups">
              {section.groups.map((g) =>
                g.by === "none" ? (
                  <NoAreaGroup key={g.title} group={g} entities={entities} now={now} />
                ) : (
                  <div className="hgroup" key={g.title}>
                    <GroupTitle group={g} entities={entities} />
                    {g.entities.map((id) => entities[id] && <EntityRow key={id} e={entities[id]!} group={g.title} now={now} />)}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- groups ------------------------------------------------------------------

const SOURCE_LABEL: Record<AreaSource, string> = { entity: "area", device: "device area", group: "group" };
const SOURCE_TITLE: Record<AreaSource, string> = {
  entity: "the entity's area in Home Assistant",
  device: "the area of the entity's device in Home Assistant",
  group: "a group set in tiles.json",
};

/** The group's title and, subtly, where it comes from: area, device area, group, device. */
function GroupTitle({ group, entities }: { group: LayoutGroup; entities: HouseView["entities"] }) {
  let note: string | null = null;
  let title = "";
  if (group.by === "group") [note, title] = [SOURCE_LABEL.group, SOURCE_TITLE.group];
  else if (group.by === "device") [note, title] = ["device", "the entities of one device"];
  else if (group.by === "area") {
    const present = new Set(group.entities.map((id) => entities[id]?.areaSource ?? "entity"));
    const sources = (["entity", "device", "group"] as const).filter((s) => present.has(s));
    note = sources.map((s) => SOURCE_LABEL[s]).join(" · ");
    title = `from ${sources.map((s) => SOURCE_TITLE[s]).join(" and ")}`;
  }
  return (
    <div className="hgroup-title">
      {group.title}
      {note !== null && (
        <span className="hgroup-src" title={title}>
          {note}
        </span>
      )}
    </div>
  );
}

const NO_AREA_ROWS = 6;

/** Entities without an area: one compact list, by kind, with how to place them. */
function NoAreaGroup({ group, entities, now }: { group: LayoutGroup; entities: HouseView["entities"]; now: number }) {
  const [all, setAll] = useState(false);
  const members = group.entities.map((id) => entities[id]).filter((e): e is HouseEntity => e !== undefined);
  const shown = all ? members : members.slice(0, NO_AREA_ROWS);
  return (
    <div className="hgroup hgroup-none">
      <div className="hgroup-title">
        {group.title} <span className="tnum">{members.length}</span>
        <span className="hgroup-src" title="Assign an area to these entities (or to their devices) in Home Assistant, or a group in tiles.json, and they are grouped with it">
          areas set in Home Assistant group these by room
        </span>
      </div>
      {shown.map((e) => (
        <EntityRow key={e.id} e={e} group="" note={kindLabel(e)} now={now} />
      ))}
      {members.length > NO_AREA_ROWS && (
        <button className="hgroup-more small" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "fewer" : `${members.length - NO_AREA_ROWS} more`}
        </button>
      )}
    </div>
  );
}

// ---- entity rows ---------------------------------------------------------------

const HISTORY_MS = 6 * 3600e3;

/** Name · value · "changed 12m ago"; click for the last 6 h from the signal ring and what happened to it. */
function EntityRow({ e, group, note, now }: { e: HouseEntity; group: string; note?: string; now: number }) {
  const [hist, setHist] = useState<SignalPoint[] | "loading" | "none" | null>(null);
  const toggle = () => {
    if (hist !== null) return setHist(null);
    setHist("loading");
    api
      .signals(e.id, Date.now() - HISTORY_MS)
      .then((r) => setHist(r.rows.length > 0 ? [...r.rows].sort((a, b) => a.at - b.at) : "none"))
      .catch(() => setHist("none"));
  };
  const tone = stateTone(e);
  return (
    <div className="hrow">
      <button className="hrow-main" onClick={toggle} title={e.area === undefined ? e.id : `${e.id} · ${e.area}: ${SOURCE_TITLE[e.areaSource ?? "entity"]}`} aria-expanded={hist !== null}>
        <span className="hrow-name">
          {shortName(e.name, group)}
          {note !== undefined && <span className="hrow-note muted"> · {note}</span>}
        </span>
        <span className={tone === "plain" ? "hrow-val tnum" : tone === "muted" ? "hrow-val muted" : `chip chip-${tone}`}>{stateText(e, now)}</span>
        <span className="hrow-age muted small tnum">{e.changedAt > 0 ? rel(now, e.changedAt) : ""}</span>
      </button>
      {hist !== null && (
        <div className="hrow-hist small muted">
          {hist === "loading" ? "loading…" : hist === "none" ? "no recorded history (only allowlisted entities are recorded)" : <Sparkline rows={hist} width={220} height={28} />}
          <code className="hrow-id">{e.id}</code>
        </div>
      )}
      {hist !== null && <EntityTimeline entity={e.id} />}
    </div>
  );
}

// ---- per-section summaries -------------------------------------------------------

interface Summary {
  line: ReactNode;
  picture: (now: number) => ReactNode;
}

function summarize(id: string, es: HouseEntity[], outdoor: HouseView["outdoor"], today: EnergyToday | null): Summary {
  switch (id) {
    case "energy":
      return energy(es, today);
    case "security":
      return security(es);
    case "lights":
      return lights(es);
    case "climate":
      return climate(es);
    case "outdoor":
      return outdoorSection(es, outdoor);
    case "presence":
      return presence(es);
    case "safety":
      return safety(es);
    default:
      return generic(es);
  }
}

function energy(es: HouseEntity[], today: EnergyToday | null): Summary {
  const s = energySummary(es);
  const line =
    s.net === null ? (s.solar === null ? `${es.length} sensors` : `solar ${fmtWatts(s.solar)}`) : s.net >= 0 ? `importing ${fmtWatts(s.net)}` : `exporting ${fmtWatts(-s.net)}`;
  const kwh = (today?.totals ?? []).filter((t) => t.unit === "kWh");
  const other = (today?.totals ?? []).filter((t) => t.unit !== "kWh");
  const LABEL = { grid_import: "Imported", grid_export: "Exported", solar: "Solar", gas: "Gas", water: "Water" } as const;
  const TONE = { grid_import: "var(--series-1)", grid_export: "var(--series-1)", solar: "var(--series-2)", gas: "var(--series-3)", water: "var(--series-3)" } as const;
  return {
    line: (
      <>
        {line}
        {s.solar !== null && s.net !== null && s.solar > 0 && <span className="muted"> · solar {fmtWatts(s.solar)}</span>}
      </>
    ),
    picture: () => (
      <div className="hviz">
        {(s.net !== null || s.solar !== null) && <EnergyFlow solar={s.solar} home={s.home} net={s.net} />}
        {kwh.length > 0 && (
          <div className="hpanel">
            <div className="hpanel-title">Today</div>
            <BarList rows={kwh.map((t) => ({ key: t.kind, label: LABEL[t.kind], value: t.value, text: `${fmtNum(t.value)} kWh`, tone: TONE[t.kind] }))} />
            {other.length > 0 && (
              <div className="hfacts small">
                {other.map((t) => (
                  <span key={t.kind}>
                    {LABEL[t.kind]} <b className="tnum">{fmtNum(t.value)} {t.unit}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {s.consumers.length > 0 && (
          <div className="hpanel">
            <div className="hpanel-title">Using power now</div>
            <BarList rows={s.consumers.slice(0, 6).map((c) => ({ key: c.id, label: c.name, value: c.watts, text: fmtWatts(c.watts) }))} />
          </div>
        )}
        {s.carbon !== null && (
          <div className="hfacts small">
            <span>
              Grid carbon intensity <b className="tnum">{fmtNum(s.carbon.value)}</b> {s.carbon.unit}
            </span>
          </div>
        )}
      </div>
    ),
  };
}

function security(es: HouseEntity[]): Summary {
  const s = openingsSummary(es);
  const total = s.open.length + s.closed + s.unavailable;
  const unlocked = s.locks.unlocked.length;
  const line =
    total === 0 && s.covers.length > 0
      ? `${s.covers.filter(isActive).length} of ${s.covers.length} covers open`
      : s.open.length === 0
        ? "all closed"
        : `${s.open.length} open`;
  return {
    line: (
      <>
        <span className={s.open.length > 0 ? "warn-text" : undefined}>{line}</span>
        {unlocked > 0 && <span className="warn-text"> · {unlocked} unlocked</span>}
      </>
    ),
    picture: (now) => (
      <div className="hviz">
        <SegBar
          label="doors and windows"
          parts={[
            { key: "open", label: "open", count: s.open.length, tone: "var(--warn)" },
            { key: "closed", label: "closed", count: s.closed, tone: "var(--series-1)" },
            { key: "na", label: "not reporting", count: s.unavailable, tone: "var(--grid)" },
          ]}
        />
        {s.open.length > 0 && (
          <ul className="hlist">
            {s.open.map((e) => (
              <li key={e.id}>
                <span className="chip chip-warn">! open</span> {e.name} <span className="muted tnum">for {since(now, e.changedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {(s.locks.locked > 0 || unlocked > 0) && (
          <div className="hfacts small">
            <span>
              Locks: <b className="tnum">{s.locks.locked}</b> locked
            </span>
            {s.locks.unlocked.map((e) => (
              <span key={e.id} className="chip chip-warn">
                ! {e.name} unlocked
              </span>
            ))}
          </div>
        )}
        {s.covers.length > 0 && (
          <BarList
            rows={s.covers.map((e) => {
              const p = typeof e.attributes["current_position"] === "number" ? (e.attributes["current_position"] as number) : isActive(e) ? 100 : 0;
              return { key: e.id, label: e.name, value: p, text: isAvailable(e) ? stateText(e, now) : e.state };
            })}
            max={100}
          />
        )}
        {s.alarms.map((e) => (
          <div key={e.id} className="hfacts small">
            <span>
              {e.name}: <b>{stateText(e, now)}</b>
            </span>
          </div>
        ))}
      </div>
    ),
  };
}

function lights(es: HouseEntity[]): Summary {
  const s = lightsSummary(es);
  const line = s.lights.total > 0 ? `${s.lights.on} of ${s.lights.total} lights on` : `${s.switches.on} of ${s.switches.total} on`;
  return {
    line: (
      <>
        {line}
        {s.lights.total > 0 && s.switches.total > 0 && (
          <span className="muted">
            {" "}
            · {s.switches.on}/{s.switches.total} switches
          </span>
        )}
      </>
    ),
    picture: (now) => (
      <div className="hviz">
        <div className="hbig">
          <span className="hbig-num tnum">{s.lights.on + s.switches.on}</span>
          <span className="muted"> of {s.lights.total + s.switches.total} on</span>
        </div>
        {s.byArea.length > 1 && (
          <BarList rows={s.byArea.map((a) => ({ key: a.area, label: a.area, value: a.total > 0 ? (a.on / a.total) * 100 : 0, text: `${a.on}/${a.total}`, title: `${a.area}: ${a.on} of ${a.total} on` }))} max={100} />
        )}
        {s.on.length > 0 && (
          <div className="hchips">
            {s.on.map((e) => {
              const b = brightnessPct(e);
              return (
                <span key={e.id} className="chip chip-on" title={e.id}>
                  {e.name}
                  {b !== null ? ` · ${b}%` : ""} <span className="muted tnum">{since(now, e.changedAt)}</span>
                </span>
              );
            })}
          </div>
        )}
        {s.lux.length > 0 && (
          <div className="hfacts small">
            {s.lux.map((l) => (
              <span key={l.id}>
                {l.name} <b className="tnum">{fmtNum(l.lux)} lx</b>
              </span>
            ))}
          </div>
        )}
      </div>
    ),
  };
}

function climate(es: HouseEntity[]): Summary {
  const s = climateSummary(es);
  const heatingOn = s.heating.filter((h) => h.on);
  const co2 = s.co2.length > 0 ? Math.max(...s.co2.map((c) => c.ppm)) : null;
  const rows: ThermoRow[] = [
    ...s.thermostats.map((t) => ({
      key: t.id,
      name: t.name,
      current: t.current,
      target: t.mode === "off" ? null : t.target,
      targetLow: t.mode === "off" ? null : t.targetLow,
      targetHigh: t.mode === "off" ? null : t.targetHigh,
      unit: t.unit,
      heating: t.action === "heating",
      cooling: t.action === "cooling",
      extra: <span className={t.mode === "off" ? "chip chip-off" : "chip chip-on"}>{t.action !== null && t.action !== "off" && t.action !== t.mode ? `${t.mode} · ${t.action}` : t.mode}</span>,
    })),
    ...s.rooms.map((r) => ({ key: r.id, name: r.name, current: r.temperature, unit: r.unit, extra: r.humidity !== null ? <span className="muted"> {fmtNum(r.humidity)}%</span> : undefined })),
  ];
  return {
    line: (
      <>
        {s.range !== null ? (s.range.max - s.range.min < 0.05 ? `${fmtNum(s.range.min)}°` : `${fmtNum(s.range.min)}–${fmtNum(s.range.max)}°`) : `${es.length} entities`}
        {co2 !== null && <span className={co2 > 1200 ? "bad-text" : co2 > 800 ? "warn-text" : "muted"}> · CO₂ {Math.round(co2)}</span>}
        {heatingOn.length > 0 && <span className="muted"> · heating</span>}
      </>
    ),
    picture: (now) => (
      <div className="hviz">
        {rows.length > 0 && <ThermoRows rows={rows} />}
        {s.co2.length > 0 && (
          <div className="thermo">
            {s.co2.map((c) => (
              <Co2Meter key={c.id} name={c.name} ppm={c.ppm} />
            ))}
          </div>
        )}
        {(s.heating.length > 0 || s.ventilation.length > 0) && (
          <div className="hchips">
            {s.heating.map((h) => (
              <span key={h.id} className={h.on ? "chip chip-on" : "chip chip-off"} title={h.id}>
                {h.name}: {h.on ? "on" : "off"} <span className="muted tnum">{since(now, h.changedAt)}</span>
              </span>
            ))}
            {s.ventilation.map((v) => (
              <span key={v.id} className={v.on ? "chip chip-on" : "chip chip-off"} title={v.id}>
                {v.name}: {v.on ? (v.percentage !== null ? `${v.percentage}%` : "on") : "off"}
                {v.preset !== null ? ` · ${v.preset}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    ),
  };
}

function outdoorSection(es: HouseEntity[], sources: HouseView["outdoor"]): Summary {
  const s = outdoorSummary(es, sources ?? {});
  const parts = [s.temperature !== null ? `${fmtNum(s.temperature.value)} ${s.temperature.unit}` : null, s.condition !== null ? weatherLabel(s.condition) : null].filter(Boolean);
  return {
    line: parts.length > 0 ? parts.join(" · ") : `${es.length} entities`,
    picture: () => (
      <div className="hviz hout">
        <div className="hout-now">
          {s.temperature !== null && (
            <div className="hbig" title={`from ${s.temperature.source}`}>
              <span className="hbig-num tnum">{fmtNum(s.temperature.value)}</span>
              <span className="muted"> {s.temperature.unit}</span>
            </div>
          )}
          {s.condition !== null && <div>{weatherLabel(s.condition)}</div>}
          <div className="hfacts small">
            {s.humidity !== null && (
              <span title={`from ${s.humidity.source}`}>
                Humidity <b className="tnum">{fmtNum(s.humidity.value)}%</b>
              </span>
            )}
            {s.pressure !== null && (
              <span>
                Pressure <b className="tnum">{fmtNum(s.pressure.value)}</b> {s.pressure.unit}
              </span>
            )}
          </div>
        </div>
        {s.wind !== null && (
          <div className="hout-wind">
            {s.wind.bearing !== null && <Compass bearing={s.wind.bearing} />}
            <div className="small">
              <b className="tnum">{fmtNum(s.wind.speed)}</b> {s.wind.unit}
              {s.wind.bearing !== null && <div className="muted">from {compassPoint(s.wind.bearing)}</div>}
              {s.wind.gust !== null && <div className="muted tnum">gusts {fmtNum(s.wind.gust)}</div>}
            </div>
          </div>
        )}
        {s.sun !== null && (
          <div className="hout-sun">
            <SunArc elevation={s.sun.elevation} azimuth={s.sun.azimuth} above={s.sun.above} />
            <div className="small muted tnum">
              {s.sun.elevation !== null && <span>{Math.round(s.sun.elevation)}° · </span>}
              {s.sun.above ? (s.sun.nextSetting !== null ? `sets ${clockTime(s.sun.nextSetting)}` : "up") : s.sun.nextRising !== null ? `rises ${clockTime(s.sun.nextRising)}` : "down"}
            </div>
          </div>
        )}
      </div>
    ),
  };
}

function presence(es: HouseEntity[]): Summary {
  const s = presenceSummary(es);
  const home = s.people.filter((p) => p.home).length;
  return {
    line: (
      <>
        {s.people.length > 0 ? (home === 0 ? "nobody home" : `${home} of ${s.people.length} home`) : `${s.occupied.length} of ${s.sensors} active`}
        {s.people.length > 0 && s.sensors > 0 && <span className="muted"> · {s.occupied.length} rooms active</span>}
      </>
    ),
    picture: (now) => (
      <div className="hviz">
        {s.people.length > 0 && (
          <div className="hpeople">
            {s.people.map((p) => (
              <div key={p.id} className={p.home ? "hperson hperson-home" : "hperson"} title={p.id}>
                <span className="hperson-av" aria-hidden="true">
                  {p.name.trim().charAt(0).toUpperCase()}
                </span>
                <span>
                  <b>{p.name}</b>
                  <span className="small muted tnum">
                    {" "}
                    {p.home ? "home" : p.state === "not_home" ? "away" : p.state} · {since(now, p.changedAt)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {s.sensors > 0 && (
          <SegBar
            label="occupancy sensors"
            parts={[
              { key: "on", label: "detecting", count: s.occupied.length, tone: "var(--series-1)" },
              { key: "off", label: "clear", count: s.sensors - s.occupied.length, tone: "var(--grid)" },
            ]}
          />
        )}
        {s.occupied.length > 0 && (
          <div className="hchips">
            {s.occupied.map((e) => (
              <span key={e.id} className="chip chip-on" title={e.id}>
                {e.area !== undefined && !e.name.toLowerCase().includes(e.area.toLowerCase()) ? `${e.area} · ` : ""}
                {e.name} <span className="muted tnum">{since(now, e.changedAt)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    ),
  };
}

const KIND_LABEL = { leak: ["leak sensor", "dry"], smoke: ["smoke / gas sensor", "clear"], problem: ["problem sensor", "OK"] } as const;

function safety(es: HouseEntity[]): Summary {
  const s = safetySummary(es);
  return {
    line:
      s.alerts.length > 0 ? (
        <span className="bad-text">✕ {s.alerts.length === 1 ? `${s.alerts[0]!.name}` : `${s.alerts.length} alerts`}</span>
      ) : (
        <>
          <span className="ok-text">✓ all clear</span>
          {s.unavailable.length > 0 && <span className="muted"> · {s.unavailable.length} not reporting</span>}
        </>
      ),
    picture: (now) => (
      <div className="hviz">
        {s.alerts.length > 0 && (
          <ul className="hlist">
            {s.alerts.map((e) => (
              <li key={e.id}>
                <span className="chip chip-bad">✕ {stateText(e, now)}</span> {e.name} <span className="muted tnum">for {since(now, e.changedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <ul className="hlist">
          {s.watching.map((w) => {
            const [noun, okWord] = KIND_LABEL[w.kind];
            const bad = s.alerts.filter((e) => (w.kind === "leak" ? e.role === "leak" : w.kind === "problem" ? e.role === "problem" : e.role !== "leak" && e.role !== "problem")).length;
            return (
              <li key={w.kind}>
                {bad > 0 ? <span className="chip chip-bad">✕ {bad}</span> : <span className="chip chip-ok">✓</span>} {w.total} {noun}
                {w.total === 1 ? "" : "s"}
                <span className="muted">
                  {" "}
                  · {w.ok} {okWord}
                  {w.total - w.ok - bad > 0 ? `, ${w.total - w.ok - bad} not reporting` : ""}
                </span>
              </li>
            );
          })}
        </ul>
        {(s.valves.length > 0 || s.water.length > 0) && (
          <div className="hfacts small">
            {s.valves.map((v) => (
              <span key={v.id}>
                {v.name} <span className={isActive(v) ? "chip chip-on" : "chip chip-off"}>{stateText(v, now)}</span>
              </span>
            ))}
            {s.water.map((w) => (
              <span key={w.id}>
                {w.name} <b className="tnum">{fmtNum(w.value)}</b> {w.unit}
              </span>
            ))}
          </div>
        )}
      </div>
    ),
  };
}

function generic(es: HouseEntity[]): Summary {
  const byDomain = new Map<string, number>();
  for (const e of es) byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);
  const active = es.filter((e) => stateTone(e) === "on").length;
  return {
    line: `${es.length} ${es.length === 1 ? "entity" : "entities"}${active > 0 ? ` · ${active} on` : ""}`,
    picture: () => (
      <div className="hchips">
        {[...byDomain].map(([d, n]) => (
          <span key={d} className="chip chip-off">
            {d.replace(/_/g, " ")} <span className="tnum">{n}</span>
          </span>
        ))}
      </div>
    ),
  };
}
