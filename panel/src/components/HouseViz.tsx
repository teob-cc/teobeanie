// HouseViz.tsx — the small pictures on top of each House section: the power flow
// between solar, home and grid, bar lists, a segmented count bar, room temperatures
// against their setpoints, a CO₂ meter, the wind compass and the sun's arc.
// Plain SVG/HTML on the panel's color tokens; no chart library.

import type { ReactNode } from "react";
import { compassPoint, co2Band } from "../../../src/house/summary";
import { fmtNum } from "../format";
import { fmtWatts } from "../houseFormat";

// ---- power flow ----------------------------------------------------------------

/**
 * Solar → Home ⇄ Grid. Link width follows the power; the dashes move the way the
 * power flows. A missing source (no solar sensor) is drawn faint with "no sensor".
 */
export function EnergyFlow({ solar, home, net }: { solar: number | null; home: number | null; net: number | null }) {
  const solarW = solar ?? 0;
  const max = Math.max(solarW, Math.abs(net ?? 0), 1);
  const width = (w: number) => 2 + 6 * Math.min(1, Math.abs(w) / max);
  const importing = (net ?? 0) > 0;
  const gridText = net === null ? "no sensor" : net === 0 ? "0 W" : `${fmtWatts(Math.abs(net))} ${importing ? "in" : "out"}`;
  return (
    <svg className="flow" viewBox="0 0 320 104" role="img" aria-label={`solar ${solar === null ? "unknown" : fmtWatts(solarW)}, home ${home === null ? "unknown" : fmtWatts(home)}, grid ${gridText}`}>
      <FlowLink x1={66} x2={134} watts={solarW} w={width(solarW)} tone="var(--series-2)" reverse={false} title={`solar to home: ${solar === null ? "no sensor" : fmtWatts(solarW)}`} />
      <FlowLink x1={186} x2={254} watts={net ?? 0} w={width(net ?? 0)} tone="var(--series-1)" reverse={importing} title={`grid: ${gridText}`} />
      <FlowNode x={40} label="Solar" value={solar === null ? "—" : fmtWatts(solarW)} tone="var(--series-2)" faint={solar === null} />
      <FlowNode x={160} label="Home" value={home === null ? "—" : fmtWatts(home)} tone="var(--ink-2)" faint={home === null} />
      <FlowNode x={280} label={net === null ? "Grid" : importing ? "Grid · import" : (net ?? 0) < 0 ? "Grid · export" : "Grid"} value={net === null ? "—" : fmtWatts(Math.abs(net))} tone="var(--series-1)" faint={net === null} />
    </svg>
  );
}

function FlowNode({ x, label, value, tone, faint }: { x: number; label: string; value: string; tone: string; faint: boolean }) {
  return (
    <g opacity={faint ? 0.45 : 1}>
      <circle cx={x} cy={44} r={26} fill="var(--surface)" stroke={tone} strokeWidth={2} />
      <text x={x} y={48} textAnchor="middle" className="flow-val">
        {value}
      </text>
      <text x={x} y={94} textAnchor="middle" className="flow-label">
        {label}
      </text>
    </g>
  );
}

function FlowLink({ x1, x2, watts, w, tone, reverse, title }: { x1: number; x2: number; watts: number; w: number; tone: string; reverse: boolean; title: string }) {
  const active = Math.abs(watts) >= 1;
  return (
    <g>
      <title>{title}</title>
      <line x1={x1} y1={44} x2={x2} y2={44} stroke="var(--grid)" strokeWidth={2} strokeLinecap="round" />
      {active && (
        <line
          x1={reverse ? x2 : x1}
          y1={44}
          x2={reverse ? x1 : x2}
          y2={44}
          stroke={tone}
          strokeWidth={w}
          strokeLinecap="round"
          strokeDasharray="6 6"
          className="flow-dash"
        />
      )}
      {/* wide invisible hit target for the tooltip */}
      <line x1={x1} y1={44} x2={x2} y2={44} stroke="transparent" strokeWidth={20} />
    </g>
  );
}

// ---- bars ----------------------------------------------------------------------

export interface BarRow {
  key: string;
  label: string;
  value: number;
  text: string;
  title?: string;
  /** CSS color of the fill; default the first series. */
  tone?: string;
}

/** Horizontal bars on one scale (one unit only): label · bar · value. */
export function BarList({ rows, max }: { rows: BarRow[]; max?: number }) {
  const top = max ?? Math.max(...rows.map((r) => r.value), 0);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.key} title={r.title ?? `${r.label}: ${r.text}`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${top > 0 && r.value > 0 ? Math.max(1.5, (r.value / top) * 100) : 0}%`, background: r.tone ?? "var(--series-1)" }} />
          </span>
          <span className="bar-val tnum">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Count bar: one segment per part, widths by count; a legend with the counts below. */
export function SegBar({ parts, label }: { parts: Array<{ key: string; label: string; count: number; tone: string }>; label: string }) {
  const total = parts.reduce((a, p) => a + p.count, 0);
  if (total === 0) return null;
  return (
    <div className="seg-wrap">
      <div className="segbar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.count} ${p.label}`).join(", ")}`}>
        {parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <span key={p.key} className="seg-part" style={{ flexGrow: p.count, background: p.tone }} title={`${p.count} ${p.label}`} />
          ))}
      </div>
      <div className="seg-legend small">
        {parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <span key={p.key}>
              <i className="swatch" style={{ background: p.tone }} />
              <span className="tnum">{p.count}</span> {p.label}
            </span>
          ))}
      </div>
    </div>
  );
}

// ---- temperatures ----------------------------------------------------------------

export interface ThermoRow {
  key: string;
  name: string;
  current: number | null;
  target?: number | null;
  targetLow?: number | null;
  targetHigh?: number | null;
  unit: string;
  /** Right-hand detail: humidity, hvac mode/action. */
  extra?: ReactNode;
  heating?: boolean;
  cooling?: boolean;
}

/** One row per room on a shared temperature scale: a dot at the reading, a tick at the setpoint. */
export function ThermoRows({ rows }: { rows: ThermoRow[] }) {
  const vals = rows.flatMap((r) => [r.current, r.target, r.targetLow, r.targetHigh]).filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return null;
  let lo = Math.floor(Math.min(...vals) - 1);
  let hi = Math.ceil(Math.max(...vals) + 1);
  if (hi - lo < 6) {
    const mid = (hi + lo) / 2;
    lo = Math.floor(mid - 3);
    hi = Math.ceil(mid + 3);
  }
  const pct = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="thermo">
      <div className="thermo-row thermo-scale small muted tnum" aria-hidden="true">
        <span />
        <span className="thermo-ends">
          <span>{lo}°</span>
          <span>{hi}°</span>
        </span>
        <span />
      </div>
      {rows.map((r) => {
        const target = r.target ?? null;
        return (
          <div className="thermo-row" key={r.key}>
            <span className="bar-label" title={r.name}>
              {r.name}
            </span>
            <span
              className="thermo-track"
              title={`${r.name}: ${r.current === null ? "—" : `${fmtNum(r.current)} ${r.unit}`}${target !== null ? `, set to ${fmtNum(target)} ${r.unit}` : ""}`}
            >
              {r.targetLow != null && r.targetHigh != null && (
                <span className="thermo-band" style={{ left: pct(r.targetLow), width: `calc(${pct(r.targetHigh)} - ${pct(r.targetLow)})` }} />
              )}
              {target !== null && <span className="thermo-target" style={{ left: pct(target) }} />}
              {r.current !== null && <span className={r.heating ? "thermo-dot thermo-heat" : r.cooling ? "thermo-dot thermo-cool" : "thermo-dot"} style={{ left: pct(r.current) }} />}
            </span>
            <span className="bar-val tnum">
              {r.current === null ? "—" : `${fmtNum(r.current)}°`}
              {target !== null && <span className="muted"> → {fmtNum(target)}°</span>}
              {r.extra}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const CO2_MIN = 400;
const CO2_MAX = 2000;

/** CO₂ on a 400–2000 ppm track with good / fair / poor bands, labelled. */
export function Co2Meter({ name, ppm }: { name: string; ppm: number }) {
  const band = co2Band(ppm);
  const at = Math.min(100, Math.max(0, ((ppm - CO2_MIN) / (CO2_MAX - CO2_MIN)) * 100));
  const edge = (v: number) => `${((v - CO2_MIN) / (CO2_MAX - CO2_MIN)) * 100}%`;
  return (
    <div className="thermo-row" title={`${name}: ${Math.round(ppm)} ppm (${band})`}>
      <span className="bar-label">{name}</span>
      <span className="co2-track">
        <span className="co2-band co2-good" style={{ left: 0, width: edge(800) }} />
        <span className="co2-band co2-fair" style={{ left: edge(800), width: `calc(${edge(1200)} - ${edge(800)})` }} />
        <span className="co2-band co2-poor" style={{ left: edge(1200), right: 0 }} />
        <span className="thermo-dot" style={{ left: `${at}%` }} />
      </span>
      <span className="bar-val tnum">
        {Math.round(ppm)} ppm <span className={`chip chip-${band === "good" ? "ok" : band === "fair" ? "warn" : "bad"}`}>{band === "good" ? "✓ good" : band === "fair" ? "! fair" : "✕ poor"}</span>
      </span>
    </div>
  );
}

// ---- outdoor -------------------------------------------------------------------

/** Wind compass: the arrow flies with the wind, from the bearing it comes from. */
export function Compass({ bearing, size = 64 }: { bearing: number; size?: number }) {
  const c = size / 2;
  const r = c - 6;
  return (
    <svg className="compass" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`wind from ${compassPoint(bearing)} (${Math.round(bearing)}°)`}>
      <title>{`wind from ${compassPoint(bearing)} (${Math.round(bearing)}°)`}</title>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--grid)" strokeWidth={1.5} />
      {(["N", "E", "S", "W"] as const).map((p, i) => {
        const a = (i * Math.PI) / 2;
        return (
          <text key={p} x={c + Math.sin(a) * (r - 7)} y={c - Math.cos(a) * (r - 7) + 3} textAnchor="middle" className="compass-pt">
            {p}
          </text>
        );
      })}
      <g transform={`rotate(${bearing + 180} ${c} ${c})`}>
        <line x1={c} y1={c + r - 12} x2={c} y2={c - r + 14} stroke="var(--series-1)" strokeWidth={2.5} strokeLinecap="round" />
        <path d={`M ${c - 5} ${c - r + 20} L ${c} ${c - r + 11} L ${c + 5} ${c - r + 20} Z`} fill="var(--series-1)" />
      </g>
    </svg>
  );
}

/**
 * The sun over the day: east on the left, west on the right, the horizon as the base
 * line. The dot sits at the sun's azimuth and elevation; under the line at night.
 */
export function SunArc({ elevation, azimuth, above }: { elevation: number | null; azimuth: number | null; above: boolean }) {
  const W = 150;
  const base = 54;
  const t = azimuth === null ? 0.5 : Math.min(1, Math.max(0, (azimuth - 60) / 240));
  const x = 10 + t * (W - 20);
  const elev = elevation ?? (above ? 20 : -10);
  const y = elev >= 0 ? base - (Math.sin((Math.min(elev, 70) * Math.PI) / 180) / Math.sin((70 * Math.PI) / 180)) * 44 : base + Math.min(10, -elev / 2);
  return (
    <svg className="sunarc" width={W} height={70} viewBox={`0 0 ${W} 70`} role="img" aria-label={`sun ${above ? "above" : "below"} the horizon${elevation !== null ? `, elevation ${Math.round(elevation)}°` : ""}`}>
      <title>{`elevation ${elevation === null ? "?" : Math.round(elevation)}°, azimuth ${azimuth === null ? "?" : Math.round(azimuth)}°`}</title>
      <path d={`M 10 ${base} Q ${W / 2} ${base - 88} ${W - 10} ${base}`} fill="none" stroke="var(--grid)" strokeWidth={1.5} strokeDasharray="3 4" />
      <line x1={4} y1={base} x2={W - 4} y2={base} stroke="var(--muted)" strokeWidth={1} />
      <text x={6} y={68} className="compass-pt">
        E
      </text>
      <text x={W - 12} y={68} className="compass-pt">
        W
      </text>
      <circle cx={x} cy={y} r={7} fill={above ? "var(--series-2)" : "var(--surface)"} stroke={above ? "var(--surface)" : "var(--muted)"} strokeWidth={2} />
    </svg>
  );
}
