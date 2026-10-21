import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG_CATEGORY, api, type ConfigChange, type JournalRow } from "../api";
import { DecisionCard } from "../components/DecisionCard";
import { OriginChip } from "../components/OriginChip";
import {
  MATCH_WINDOW_MS,
  classifyMiss,
  fmtDelta,
  foldDecisions,
  shortId,
  type Decision,
  type HeuristicInstance,
  type Miss,
  type ObservedCall,
} from "../decisions";
import { dayKey, fmtDay, fmtTime } from "../format";
import type { SseFrame } from "../useSse";
import { useDeviceEntities } from "../useDevices";
import { useSignalHistory } from "../useHistory";

type NrMode = "off" | "owned" | "all";

type Item =
  | { kind: "decision"; at: number; d: Decision }
  | { kind: "call"; at: number; n: ObservedCall; miss?: Miss }
  | { kind: "config"; at: number; c: ConfigChange; eventId: string };

/**
 * The decision feed: every heuristic decision, newest first, optionally
 * interleaved with the calls others made (people, add-ons, automations, Node-RED
 * on old rows) so shadow runs can be compared side by side, and with the working-set
 * edits between them (a mode or a parameter changed, by whom).
 * With `only`, the feed is one instance's history; `select` sets the instance filter
 * from outside (a card's link on the House page).
 */
export function Decisions({
  subscribe,
  instances,
  only,
  select,
}: {
  subscribe: (fn: (f: SseFrame) => void) => () => void;
  instances: HeuristicInstance[];
  only?: HeuristicInstance;
  /** Filter the feed to this instance key; n tells two asks for the same key apart. */
  select?: { key: string; n: number } | null;
}) {
  const [rows, setRows] = useState<Map<number, JournalRow>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [nrMode, setNrMode] = useState<NrMode>(only ? "owned" : "off");
  const [filter, setFilter] = useState<string>("");
  useEffect(() => {
    if (select) setFilter(select.key);
  }, [select]);
  const [windowDays, setWindowDays] = useState(1);
  const busy = useRef(false);

  const heuristicIds = useMemo(() => new Set(instances.map((i) => i.heuristic)), [instances]);

  /**
   * Load the time window: each heuristic category (or the one instance) plus the audited
   * calls over the same span. Per-category queries keep a busy audit stream from
   * crowding decisions out of a fixed-size page.
   */
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const since = Date.now() - windowDays * 24 * 3600e3;
      const queries = only
        ? [api.journal({ category: only.heuristic, entity: only.id, since, limit: 1000 })]
        : [...heuristicIds].map((h) => api.journal({ category: h, since, limit: 1000 }));
      queries.push(api.journal({ category: "ha-audit", since: since - MATCH_WINDOW_MS, limit: 1000 }));
      queries.push(api.journal({ category: CONFIG_CATEGORY, since, limit: 1000 }));
      const pages = await Promise.all(queries);
      setRows(new Map(pages.flatMap((p) => p.rows).map((r) => [r.globalSeq, r])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [heuristicIds, only, windowDays]);

  useEffect(() => {
    if (heuristicIds.size > 0 || only) void load();
  }, [load, heuristicIds, only]);

  // Live: any heuristic or audit batch → refetch the newest page (debounced).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribe((f) => {
      if (f.type !== "journal" && f.type !== "hello") return;
      const shared = f.type === "journal" && (f.category === "ha-audit" || f.category === CONFIG_CATEGORY);
      if (f.type === "journal" && !shared && !heuristicIds.has(f.category)) return;
      if (only && f.type === "journal" && !shared && (f.category !== only.heuristic || f.entityId !== only.id)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 800);
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [subscribe, load, heuristicIds, only]);

  const rowList = useMemo(() => [...rows.values()], [rows]);
  const devices = useDeviceEntities(rowList);

  const owned = useMemo(() => new Set((only ? [only] : instances).flatMap((i) => i.actuates)), [instances, only]);

  const folded = useMemo(() => foldDecisions(rowList, heuristicIds, devices), [rowList, heuristicIds, devices]);

  // Recorded values of the owned entities others called without a Teobeanie match, from a
  // day before the window, so a re-send to a device already in that state is recognised.
  const unmatched = useMemo(
    () => folded.others.filter((n) => !folded.matched.has(n) && n.entityIds.some((e) => owned.has(e))),
    [folded, owned],
  );
  const historySince = useMemo(() => Date.now() - (windowDays + 1) * 24 * 3600e3, [windowDays]);
  const history = useSignalHistory(
    [...new Set(unmatched.flatMap((n) => n.entityIds.filter((e) => owned.has(e))))],
    historySince,
    rows,
  );

  const items = useMemo((): Item[] => {
    const { decisions, others, matched } = folded;
    const shown = decisions.filter((d) => (only ? true : filter === "" || d.key === filter));
    const out: Item[] = shown.map((d) => ({ kind: "decision", at: d.at, d }));
    // An edit that names the instances it touched shows with those; one that does not, everywhere.
    const key = only?.key ?? filter;
    for (const r of rowList) {
      if (r.category !== CONFIG_CATEGORY || r.manifest !== "ConfigChanged") continue;
      const c = r.payload as ConfigChange;
      if (key !== "" && c.instances !== undefined && !c.instances.includes(key)) continue;
      out.push({ kind: "config", at: typeof c.at === "number" ? c.at : r.ts * 1000, c, eventId: r.envelope?.eventId ?? String(r.globalSeq) });
    }
    if (nrMode !== "off") {
      const lo = shown.length ? Math.min(...shown.map((d) => d.at)) - MATCH_WINDOW_MS : 0;
      for (const n of others) {
        if (n.at < lo) continue;
        const touchesOwned = n.entityIds.some((e) => owned.has(e));
        if (nrMode === "owned" && !touchesOwned) continue;
        const missed = touchesOwned && !matched.has(n);
        out.push({ kind: "call", at: n.at, n, ...(missed ? { miss: classifyMiss(n, owned, decisions, history) } : {}) });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [folded, history, filter, nrMode, owned, only, rowList]);

  const stats = useMemo(() => {
    let calls = 0;
    let matched = 0;
    const missed = { "no-op": 0, timing: 0, unexplained: 0 };
    for (const it of items) {
      if (it.kind === "decision") {
        for (const a of it.d.actions) {
          if (a.action.kind !== "call" || a.disposition === "refused") continue;
          calls++;
          if (a.seen) matched++;
        }
      } else if (it.kind === "call" && it.miss) missed[it.miss.kind]++;
    }
    return { calls, matched, missed };
  }, [items]);

  let lastDay = "";
  return (
    <div className="timeline">
      <header className="view-head">
        <h2>{only ? "Decisions" : "Decision feed"}</h2>
        <span className="muted small tnum">
          {stats.calls > 0 && `${stats.matched}/${stats.calls} calls also made outside Teobeanie`}
          {nrMode !== "off" && missSummary(stats.missed)}
        </span>
      </header>
      <div className="toolbar">
        {!only && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="heuristic instance">
            <option value="">All heuristics</option>
            {instances.map((i) => (
              <option key={i.key} value={i.key}>
                {i.id} · {i.title}
              </option>
            ))}
          </select>
        )}
        <span className="seg" role="radiogroup" aria-label="Calls made outside Teobeanie">
          <span className="muted small">Other calls:</span>
          {(["off", "owned", "all"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={nrMode === m} className={nrMode === m ? "tab active" : "tab"} onClick={() => setNrMode(m)}>
              {m === "owned" ? "same entities" : m}
            </button>
          ))}
        </span>
      </div>
      {error && (
        <div className="banner" role="alert">
          {error}
          <button onClick={() => void load()}>retry</button>
        </div>
      )}
      {items.length === 0 && !error && <p className="muted">No decisions journaled yet.</p>}
      {items.map((it) => {
        const d = dayKey(it.at);
        const divider = d !== lastDay ? <div className="day-div">{fmtDay(it.at)}</div> : null;
        lastDay = d;
        return (
          <Fragment key={it.kind === "decision" ? it.d.eventId : it.kind === "config" ? `cfg-${it.eventId}` : `nr-${it.n.eventId ?? it.at}`}>
            {divider}
            {it.kind === "decision" ? (
              <DecisionCard d={it.d} showInstance={!only} />
            ) : it.kind === "config" ? (
              <div className="nr-row cfg-row" title={it.c.summary}>
                <OriginChip by={it.c.by} />
                <span className="small">
                  {it.c.file}: {it.c.summary}
                </span>
                <time className="card-time tnum">{fmtTime(it.at)}</time>
              </div>
            ) : (
              <div className={it.miss ? `nr-row nr-miss-${it.miss.kind}` : "nr-row"}>
                <OriginChip by={it.n.by} />
                <span className="small">
                  {it.n.domain}.{it.n.service} {it.n.entityIds.length ? it.n.entityIds.map(shortId).join(", ") : `device ${it.n.deviceIds.join(", ") || "?"}`}
                </span>
                {it.miss && <MissLabel miss={it.miss} />}
                <time className="card-time tnum">{fmtTime(it.at)}</time>
              </div>
            )}
          </Fragment>
        );
      })}
      <p className="center">
        <span className="muted small">Showing the last {windowDays === 1 ? "24 hours" : `${windowDays} days`}. </span>
        <button className="tab" onClick={() => setWindowDays((d) => d + 1)}>
          Load one more day
        </button>
      </p>
    </div>
  );
}

/** " · 3 other calls without a Teobeanie decision · 14 that Teobeanie makes at another time · 8 re-sends to a device already in that state" */
function missSummary(m: Record<Miss["kind"], number>): string {
  const parts: string[] = [];
  if (m.unexplained > 0) parts.push(`${m.unexplained} other call${m.unexplained === 1 ? "" : "s"} without a Teobeanie decision`);
  if (m.timing > 0) parts.push(`${m.timing} that Teobeanie makes at another time`);
  if (m["no-op"] > 0) parts.push(`${m["no-op"]} re-send${m["no-op"] === 1 ? "" : "s"} to a device already in that state`);
  return parts.map((p) => ` · ${p}`).join("");
}

function MissLabel({ miss }: { miss: Miss }) {
  switch (miss.kind) {
    case "no-op":
      return <span className="small muted">already {miss.value ? "on" : "off"}</span>;
    case "timing":
      return (
        <span className="small">
          Teobeanie {miss.deltaMs > 0 ? `${fmtDelta(miss.deltaMs)} later` : `${fmtDelta(miss.deltaMs)} earlier`} ({miss.key.slice(miss.key.indexOf("/") + 1)})
        </span>
      );
    default:
      return <span className="small bad-text">no matching Teobeanie decision</span>;
  }
}
