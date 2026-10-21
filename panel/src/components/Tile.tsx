import type { ReactNode } from "react";
import type { Tile } from "../api";
import { fmtNum, rel } from "../format";

/** House-view entity tile: label, live value, "updated Xs ago". */
export function EntityTile({ tile, now }: { tile: Tile; now: number }) {
  return (
    <div className="tile">
      <div className="tile-label" title={tile.entityId}>
        {tile.label}
      </div>
      <div className="tile-value">{tileValue(tile)}</div>
      <div className="tile-foot muted tnum">
        {tile.stateAt !== null ? `updated ${rel(now, tile.stateAt)}` : "no data yet"}
      </div>
    </div>
  );
}

function tileValue(t: Tile): ReactNode {
  const v = t.value;
  if (v === null) return <span className="muted">—</span>;
  if (typeof v === "boolean") {
    const [onLabel, offLabel] = t.kind === "presence" ? ["home", "away"] : ["on", "off"];
    return <span className={v ? "chip chip-on" : "chip chip-off"}>{v ? onLabel : offLabel}</span>;
  }
  if (typeof v === "number") {
    return (
      <>
        <span className="num tnum">{fmtNum(v)}</span>
        {t.unit && <span className="unit">{t.unit}</span>}
      </>
    );
  }
  return <span className="txt">{v}</span>;
}

/** Small stat tile for the House header row (connection, rates, counts). */
export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value tnum">{value}</div>
      {sub !== undefined && <div className="stat-sub tnum">{sub}</div>}
    </div>
  );
}
