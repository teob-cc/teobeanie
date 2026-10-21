// EntityTimeline.tsx — what happened to one entity, newest first (api/timeline): its
// changes and who made them, the calls on it, the decisions of the instances that
// watch, read or own it with what became of each action, the facts that read it, the
// pause and config edits. With a fact instead: its changes, what it reads, and the
// decisions of the instances that read it.

import { useEffect, useState } from "react";
import { api, type Cause, type TimelineEntry } from "../api";
import { describeInput } from "../decisions";
import { fmtDay, fmtTime } from "../format";
import { OriginChip } from "./OriginChip";

const WINDOW_MS = 24 * 3600e3;
const PAGE = 25;

type State = { rows: TimelineEntry[]; more?: string; loading: boolean; error?: string };

export function EntityTimeline({ entity, fact }: { entity?: string; fact?: string }) {
  const [to] = useState(() => Date.now());
  const [s, setS] = useState<State>({ rows: [], loading: true });
  const load = (cursor?: string) => {
    setS((p) => ({ ...p, loading: true }));
    api
      .timeline({ ...(entity !== undefined ? { entity } : {}), ...(fact !== undefined ? { fact } : {}), from: to - WINDOW_MS, to, order: "desc", limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) })
      .then((r) => setS((p) => ({ rows: cursor === undefined ? r.rows : [...p.rows, ...r.rows], ...(r.more !== undefined ? { more: r.more } : {}), loading: false })))
      .catch((err: unknown) => setS((p) => ({ ...p, loading: false, error: String(err) })));
  };
  useEffect(() => load(), [entity, fact]);

  if (s.error !== undefined && s.rows.length === 0) return <div className="etl small muted">timeline: {s.error}</div>;
  if (!s.loading && s.rows.length === 0) return <div className="etl small muted">nothing in the last 24 h</div>;
  return (
    <div className="etl small">
      <ol className="etl-rows">
        {s.rows.map((r) => (
          <li key={`${r.kind}-${"obs_id" in r ? r.obs_id : r.event_id}`} className={`etl-row etl-${r.kind}`} title={"obs_id" in r ? `obs ${r.obs_id}` : `event ${r.event_id}`}>
            <time className="etl-time muted tnum">
              {fmtDay(r.at) === "Today" ? "" : `${fmtDay(r.at)} `}
              {fmtTime(r.at)}
            </time>
            <span className="etl-kind muted">{r.kind}</span>
            <Body r={r} />
          </li>
        ))}
      </ol>
      {s.loading ? (
        <span className="muted">loading…</span>
      ) : (
        s.more !== undefined && (
          <button className="hgroup-more small" onClick={() => load(s.more)}>
            older
          </button>
        )
      )}
    </div>
  );
}

function By({ by }: { by: Cause }) {
  return (
    <>
      <OriginChip by={by.by} />
      {by.instance !== undefined && <span className="muted"> {by.instance}</span>}
    </>
  );
}

function Body({ r }: { r: TimelineEntry }) {
  switch (r.kind) {
    case "change":
      return (
        <span className="etl-body">
          {r.from !== undefined && <span className="muted">{r.from} → </span>}
          <b>{r.to}</b> <By by={r.by} />
        </span>
      );
    case "call":
      return (
        <span className="etl-body">
          {r.service} <By by={r.by} />
        </span>
      );
    case "decision":
      return (
        <span className="etl-body">
          <span className="muted">{r.instance}</span> {describeInput(r.input)}: {r.failed !== undefined ? <span className="bad-text">failed: {r.failed}</span> : (r.why ?? "no reason given")}
          {r.mode === "shadow" && <span className="chip chip-off">shadow</span>}
          {r.actions?.map((a, i) => (
            <span key={a.event_id ?? i} className={a.status === "done" ? "chip chip-ok" : a.status.startsWith("failed") || a.status.startsWith("refused") ? "chip chip-bad" : "chip chip-off"} title={a.action}>
              {a.status}
            </span>
          ))}
        </span>
      );
    case "fact":
      return (
        <span className="etl-body">
          <span className="muted">{r.fact}</span> → <b>{factText(r.value)}</b>
          {r.why !== undefined && <span className="muted"> · {r.why}</span>}
          {r.input !== undefined && <span className="muted"> ({r.input})</span>}
        </span>
      );
    default:
      return <span className="etl-body">{r.summary}</span>;
  }
}

/** A fact's value as text: yes/no for a boolean, else as it is. */
export function factText(v: unknown): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v);
}
