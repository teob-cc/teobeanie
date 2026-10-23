// EnergyCharts.tsx — the Energy tab's pictures: the periods' bars (stacked by carrier,
// a fainter bar for a year earlier, hatched where a price was estimated), the price
// curve per slot, and a day's hours. Plain SVG on the panel's color tokens, drawn at
// the container's own pixel width so the text stays its size on a phone; no chart library.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { HourRow, Ledger, PricePoint } from "../../../src/energy/types";
import {
  byCarrier,
  carrierStack,
  clock,
  fmtEur,
  fmtEurShort,
  fmtKwh,
  fmtM3,
  fmtPrice,
  localDate,
  periodLabel,
  periodTitle,
  priceMarks,
  scaleFor,
  stackExtent,
  TONE,
  type Period,
  type Scale,
} from "../energy";

/** The width of the element the ref is on, following resizes; 0 until measured. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const onEnter = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** Gridlines at the scale's round values, € labels on the left. */
function Grid({ scale, left, width, text }: { scale: Scale; left: number; width: number; text: (v: number) => string }) {
  const ticks = [scale.hi, scale.hi / 2, 0, ...(scale.lo < 0 ? [scale.lo] : [])].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <g>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={left} x2={width} y1={scale.y(v)} y2={scale.y(v)} stroke={v === 0 ? "var(--muted)" : "var(--grid)"} strokeWidth={1} />
          <text x={left - 4} y={scale.y(v) + 3.5} textAnchor="end" className="echart-tick">
            {text(v)}
          </text>
        </g>
      ))}
    </g>
  );
}

const axisEur = (v: number) => (v === 0 ? "0" : fmtEurShort(v));

// ---- periods -----------------------------------------------------------------------

export function PeriodBars({
  period,
  rows,
  earlier,
  selected,
  onSelect,
}: {
  period: Period;
  rows: Ledger[];
  /** A year earlier, by this year's row key. */
  earlier: Map<string, Ledger>;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const hatch = useId();
  const H = 180;
  const top = 18;
  const bottom = 20;
  const left = 40;
  const values = [...stackExtent(rows), ...[...earlier.values()].map((l) => l.total)];
  const scale = scaleFor(values, top, H - top - bottom);
  const slot = rows.length > 0 ? (Math.max(W, 200) - left) / rows.length : 0;
  const ghostShown = earlier.size > 0;
  const barW = Math.min(36, slot * (ghostShown ? 0.42 : 0.6));
  const ghostW = Math.min(16, slot * 0.2);
  const labelEvery = slot >= 34 ? 1 : slot >= 18 ? 2 : 3;
  return (
    <div className="echart" ref={ref}>
      {W > 0 && rows.length > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${rows.length} ${period === "day" ? "days" : `${period}s`} of costs, oldest first`}>
          <defs>
            <pattern id={hatch} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--surface)" strokeWidth={2.5} />
            </pattern>
          </defs>
          <Grid scale={scale} left={left} width={W} text={axisEur} />
          {rows.map((r, i) => {
            const x0 = left + i * slot;
            const cx = x0 + slot / 2 + (ghostShown ? ghostW / 2 + 1 : 0);
            const ghost = earlier.get(r.key);
            const stack = carrierStack(r);
            const yTop = scale.y(Math.max(0, ...stack.map((s) => s.to)));
            const carriers = byCarrier(r)
              .filter((c) => Math.abs(c.value) >= 0.005)
              .map((c) => `${c.label.toLowerCase()} ${fmtEur(c.value)}`)
              .join(", ");
            const title =
              `${periodTitle(period, r.key)}${r.complete ? "" : " (so far)"}: ${fmtEur(r.total)}` +
              (carriers ? ` (${carriers})` : "") +
              (r.estimated ? " · some hours priced from an estimate" : "") +
              (ghost ? ` · a year earlier ${fmtEur(ghost.total)}` : "");
            const sel = selected === r.key;
            return (
              <g key={r.key} className="echart-slot" role="button" tabIndex={0} aria-pressed={sel} aria-label={title} onClick={() => onSelect(r.key)} onKeyDown={onEnter(() => onSelect(r.key))}>
                <title>{title}</title>
                <rect x={x0 + 1} y={top - 14} width={slot - 2} height={H - top - bottom + 14} rx={4} fill={sel ? "var(--wash)" : "transparent"} />
                {ghost !== undefined && (
                  <rect
                    x={cx - barW / 2 - ghostW - 2}
                    y={Math.min(scale.y(ghost.total), scale.y(0))}
                    width={ghostW}
                    height={Math.max(1, Math.abs(scale.y(ghost.total) - scale.y(0)))}
                    rx={2}
                    className="echart-ghost"
                  />
                )}
                {stack.map((s) => (
                  <rect key={s.key} x={cx - barW / 2} y={scale.y(s.to)} width={barW} height={Math.max(0.5, scale.y(s.from) - scale.y(s.to))} fill={s.tone} opacity={r.complete ? 1 : 0.75} />
                ))}
                {r.estimated && stack.length > 0 && (
                  <rect
                    x={cx - barW / 2}
                    y={scale.y(Math.max(0, ...stack.map((s) => s.to)))}
                    width={barW}
                    height={scale.y(Math.min(0, ...stack.map((s) => s.from))) - scale.y(Math.max(0, ...stack.map((s) => s.to)))}
                    fill={`url(#${hatch})`}
                  />
                )}
                {(sel || rows.length <= 7) && (
                  <text x={cx} y={yTop - 4} textAnchor="middle" className="echart-val">
                    {r.estimated ? "≈" : ""}
                    {fmtEurShort(r.total)}
                  </text>
                )}
                {i % labelEvery === (rows.length - 1) % labelEvery && (
                  <text x={cx} y={H - 5} textAnchor="middle" className={sel ? "echart-tick echart-tick-sel" : "echart-tick"}>
                    {periodLabel(period, r.key)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className="seg-legend small">
        <span>
          <i className="swatch" style={{ background: TONE.electricity }} />
          electricity
        </span>
        <span>
          <i className="swatch" style={{ background: TONE.gas }} />
          gas
        </span>
        <span>
          <i className="swatch" style={{ background: TONE.water }} />
          water
        </span>
        <span>
          <i className="swatch" style={{ background: TONE.fixed }} />
          fixed charges
        </span>
        {ghostShown && (
          <span>
            <i className="swatch echart-ghost-swatch" />a year earlier
          </span>
        )}
        {rows.some((r) => r.estimated) && (
          <span>
            <i className="swatch echart-hatch-swatch" />≈ partly estimated prices
          </span>
        )}
      </div>
    </div>
  );
}

// ---- prices ------------------------------------------------------------------------

/** One bar per slot, today's and tomorrow's on one scale; now highlighted, the cheapest and dearest labelled. */
export function PriceBars({ points, at, timeZone, unit = "kWh" }: { points: PricePoint[]; at: number; timeZone: string; unit?: "kWh" | "m³" }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  if (points.length === 0)
    return (
      <div className="echart" ref={ref}>
        <p className="muted small">No prices known.</p>
      </div>
    );
  const H = 150;
  const top = 26;
  const bottom = 20;
  const left = 46;
  const t0 = points[0]!.start;
  const t1 = points[points.length - 1]!.end;
  const w = Math.max(W, 200);
  const x = (t: number) => left + ((t - t0) / (t1 - t0 || 1)) * (w - left);
  const scale = scaleFor(
    points.map((p) => p.price),
    top,
    H - top - bottom,
  );
  const marks = priceMarks(points, at);
  const firstDay = localDate(t0, timeZone);
  const tomorrow = points.find((p) => localDate(p.start, timeZone) !== firstDay);
  // Hour ticks every 6 hours of house time.
  const ticks = points.filter((p) => {
    const c = clock(p.start, timeZone);
    return c.endsWith(":00") && ["00", "06", "12", "18"].includes(c.slice(0, 2)) && p.start > t0;
  });
  const label = (i: number, text: string) => {
    const p = points[i]!;
    // A label near an edge is anchored to it, so it is never cut off.
    const mid = (x(p.start) + x(p.end)) / 2;
    const anchor = mid > left + (w - left) * 0.8 ? "end" : mid < left + (w - left) * 0.2 ? "start" : "middle";
    const cx = anchor === "end" ? Math.min(w - 2, x(p.end)) : anchor === "start" ? Math.max(left + 2, x(p.start)) : mid;
    return (
      <text x={cx} y={Math.min(scale.y(p.price), scale.y(0)) - 5} textAnchor={anchor} className="echart-val">
        {text} {fmtPrice(p.price, unit).replace(`/${unit}`, "")} · {clock(p.start, timeZone)}
      </text>
    );
  };
  return (
    <div className="echart" ref={ref}>
      {W > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${points.length} price slots from ${clock(t0, timeZone)}`}>
          <Grid scale={scale} left={left} width={w} text={(v) => (v === 0 ? "0" : fmtPrice(v, unit).replace(`/${unit}`, ""))} />
          {points.map((p, i) => {
            const x0 = x(p.start);
            const bw = Math.max(1, x(p.end) - x0 - (x(p.end) - x0 > 3 ? 1 : 0));
            const y = Math.min(scale.y(p.price), scale.y(0));
            const h = Math.max(1, Math.abs(scale.y(p.price) - scale.y(0)));
            const now = i === marks.now;
            return (
              <rect key={p.start} x={x0} y={y} width={bw} height={h} fill={now ? "var(--series-1)" : i === marks.min ? "var(--series-3)" : i === marks.max ? "var(--series-2)" : "var(--series-strip)"}>
                <title>{`${clock(p.start, timeZone)}–${clock(p.end, timeZone)}: ${fmtPrice(p.price, unit)}${now ? " (now)" : ""}`}</title>
              </rect>
            );
          })}
          {tomorrow !== undefined && (
            <g>
              <line x1={x(tomorrow.start)} x2={x(tomorrow.start)} y1={top - 18} y2={H - bottom} stroke="var(--muted)" strokeDasharray="3 3" />
              <text x={x(tomorrow.start) + 4} y={top - 10} className="echart-tick">
                tomorrow
              </text>
            </g>
          )}
          {ticks.map((p) => (
            <text key={p.start} x={x(p.start)} y={H - 5} textAnchor="middle" className="echart-tick">
              {clock(p.start, timeZone)}
            </text>
          ))}
          {marks.min >= 0 && label(marks.min, "low")}
          {marks.max >= 0 && marks.max !== marks.min && label(marks.max, "high")}
        </svg>
      )}
    </div>
  );
}

// ---- a day's hours -----------------------------------------------------------------

/** Each hour's cost (import less export, gas, water), a bar up or down from zero. */
export function HourBars({ hours, timeZone }: { hours: HourRow[]; timeZone: string }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = 130;
  const top = 10;
  const bottom = 20;
  const left = 40;
  const w = Math.max(W, 200);
  const scale = scaleFor(
    hours.map((h) => h.cost),
    top,
    H - top - bottom,
  );
  const slot = hours.length > 0 ? (w - left) / hours.length : 0;
  return (
    <div className="echart" ref={ref}>
      {W > 0 && hours.length > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${hours.length} hours of costs`}>
          <Grid scale={scale} left={left} width={w} text={axisEur} />
          {hours.map((h, i) => {
            const y = Math.min(scale.y(h.cost), scale.y(0));
            const hgt = Math.max(h.cost === 0 ? 0 : 1, Math.abs(scale.y(h.cost) - scale.y(0)));
            const t = clock(h.start, timeZone);
            return (
              <g key={h.start}>
                <rect x={left + i * slot + slot * 0.15} y={y} width={slot * 0.7} height={hgt} fill={h.cost < 0 ? "var(--series-3)" : "var(--series-1)"} opacity={h.estimated ? 0.55 : 1}>
                  <title>
                    {`${t}: ${fmtEur(h.cost)}${h.estimated ? " (price estimated)" : ""} · in ${fmtKwh(h.importKwh)}, out ${fmtKwh(h.exportKwh)}` +
                      (h.solarKwh > 0 ? `, solar ${fmtKwh(h.solarKwh)}` : "") +
                      (h.gasM3 > 0 ? `, gas ${fmtM3(h.gasM3)}` : "") +
                      (h.price !== null ? ` · ${fmtPrice(h.price)}` : "")}
                  </title>
                </rect>
                {i % (slot >= 24 ? 3 : 6) === 0 && (
                  <text x={left + i * slot + slot / 2} y={H - 5} textAnchor="middle" className="echart-tick">
                    {t.slice(0, 2)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
