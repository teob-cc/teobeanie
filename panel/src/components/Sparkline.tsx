import type { SignalPoint } from "../api";

/**
 * 120×28 inline-SVG sparkline — no chart library.
 * Numeric series → 2px round-join polyline in the series hue with a
 * surface-ringed end dot. Non-numeric series → a state strip: one segment per
 * sample, held until the next sample (truthy = accent, falsy = recessive,
 * null/unavailable = blank).
 */
export function Sparkline({
  rows,
  width = 120,
  height = 28,
}: {
  rows: SignalPoint[];
  width?: number;
  height?: number;
}) {
  if (rows.length === 0) return null;
  const numeric = rows.filter(
    (r): r is SignalPoint & { value: number } =>
      typeof r.value === "number" && Number.isFinite(r.value),
  );
  if (numeric.length > 0 && numeric.length >= rows.length / 2) {
    return <NumericSpark rows={numeric} width={width} height={height} />;
  }
  return <StateStrip rows={rows} width={width} height={height} />;
}

function NumericSpark({
  rows,
  width,
  height,
}: {
  rows: Array<SignalPoint & { value: number }>;
  width: number;
  height: number;
}) {
  const pad = 3;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const span = last.at - first.at;
  const innerW = width - 2 * pad;
  const xFor = (at: number, i: number) =>
    span > 0
      ? pad + ((at - first.at) / span) * innerW
      : rows.length > 1
        ? pad + (i / (rows.length - 1)) * innerW
        : width - pad;
  const vals = rows.map((r) => r.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const yFor = (v: number) =>
    max > min ? pad + (1 - (v - min) / (max - min)) * (height - 2 * pad) : height / 2;
  const pts = rows.map((r, i) => `${xFor(r.at, i).toFixed(1)},${yFor(r.value).toFixed(1)}`).join(" ");
  const lastX = xFor(last.at, rows.length - 1);
  const lastY = yFor(last.value);
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`sparkline, ${rows.length} samples, last ${last.value}`}
    >
      {rows.length > 1 && (
        <polyline
          points={pts}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <circle cx={lastX} cy={lastY} r="2.5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}

function stripFill(v: SignalPoint["value"]): string | null {
  if (v === null) return null; // unavailable — leave the track blank
  if (v === true) return "var(--series-1)";
  if (v === false) return "var(--grid)";
  return "var(--series-strip)"; // string state — accent wash
}

function StateStrip({ rows, width, height }: { rows: SignalPoint[]; width: number; height: number }) {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const end = Math.max(Date.now(), last.at + 1);
  const span = end - first.at;
  const xFor = (at: number) => (span > 0 ? ((at - first.at) / span) * width : 0);
  const y = height / 2 - 5;
  const lastLabel = last.value === null ? "unavailable" : String(last.value);
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`state strip, ${rows.length} samples, last ${lastLabel}`}
    >
      <rect x="0" y={y} width={width} height="10" rx="2" fill="var(--page)" stroke="var(--grid)" strokeWidth="1" />
      {rows.map((r, i) => {
        const fill = stripFill(r.value);
        if (fill === null) return null;
        const x0 = xFor(r.at);
        const x1 = i + 1 < rows.length ? xFor(rows[i + 1]!.at) : width;
        // 1px surface gap between adjacent segments so runs stay countable
        const w = Math.max(x1 - x0 - 1, 1);
        return <rect key={r.at + ":" + i} x={x0.toFixed(1)} y={y} width={w.toFixed(1)} height="10" fill={fill} />;
      })}
    </svg>
  );
}
