import { useState } from "react";
import { api, type JournalRow } from "../api";
import { describeAction, describeInput, rowAt, shortId, type ActionView, type Decision } from "../decisions";
import { fmtTime } from "../format";
import { originLabel } from "../origin";

/** One heuristic decision: why, what it did (or would have), and — on demand — the causation chain. */
export function DecisionCard({ d, showInstance = true }: { d: Decision; showInstance?: boolean }) {
  const [chain, setChain] = useState<JournalRow[] | "loading" | "error" | null>(null);

  const loadChain = () => {
    if (chain !== null) return;
    const head = d.actions[0]?.actionId ?? d.eventId;
    setChain("loading");
    api
      .chain(head)
      .then((r) => setChain(r.chain))
      .catch(() => setChain("error"));
  };

  const readEntries = Object.entries(d.reads);
  // A rule's held/within bookkeeping is not a fact about the house.
  const facts = d.events.filter((e) => e.tag !== "Tracked");

  return (
    <details className={d.failed ? "card dcard dcard-failed" : "card dcard"} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadChain()}>
      <summary className="card-summary dcard-summary">
        {showInstance && (
          <span className="chip chip-teobeanie" title={d.key}>
            {d.instance}
          </span>
        )}
        <span className="dcard-why">{d.failed ? `decide failed: ${d.failed}` : (d.why ?? describeInput(d.input))}</span>
        <time className="card-time tnum">{fmtTime(d.at)}</time>
        {(d.actions.length > 0 || d.timers.length > 0) && (
          <span className="dcard-effects">
            {d.actions.map((a) => (
              <ActionChip key={a.actionId} a={a} />
            ))}
            {d.timers.map((t, i) => (
              <span key={i} className="chip chip-off" title={t.at ? new Date(t.at).toLocaleString() : undefined}>
                {t.op === "set" ? `⏱ ${t.timer} ${t.at ? fmtTime(t.at) : ""}` : `⏱ ${t.timer} cancelled`}
              </span>
            ))}
          </span>
        )}
      </summary>
      <div className="card-body">
        <dl className="kv">
          <dt>Input</dt>
          <dd>{describeInput(d.input)}</dd>
          <dt>Heuristic</dt>
          <dd>
            <code>{d.key}</code> · {d.mode ?? "?"}
          </dd>
          {readEntries.length > 0 && (
            <>
              <dt>Read</dt>
              <dd>
                {readEntries.map(([e, v]) => (
                  <div key={e} className="small">
                    <code>{shortId(e)}</code> = {v === null ? "—" : String(v)}
                  </div>
                ))}
              </dd>
            </>
          )}
          {facts.length > 0 && (
            <>
              <dt>Facts</dt>
              <dd className="small">
                {facts.map((e, i) => (
                  <div key={i}>
                    {e.tag === "DesiredChanged" ? (
                      <>
                        <code>{shortId(String(e.entity))}</code> {fmtDesired(e.from)} → {fmtDesired(e.to)}
                      </>
                    ) : (
                      <>
                        <code>{e.tag}</code> {JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "tag")))}
                      </>
                    )}
                  </div>
                ))}
              </dd>
            </>
          )}
          {d.actions.map((a) => (
            <ActionDetail key={a.actionId} a={a} />
          ))}
        </dl>
        <div className="chain">
          <div className="chain-head small muted">Causation chain</div>
          {chain === "loading" && <span className="muted small">loading…</span>}
          {chain === "error" && <span className="muted small">chain unavailable</span>}
          {Array.isArray(chain) && (
            <ol className="chain-list">
              {chain.map((r) => (
                <li key={r.globalSeq}>
                  <time className="tnum muted small">{fmtTime(rowAt(r))}</time> <code>{r.manifest}</code>{" "}
                  <span className="small">{chainText(r)}</span>
                </li>
              ))}
              {chain.length > 0 && chain[chain.length - 1]!.envelope?.causationId && (
                <li className="muted small">
                  ← signal <code>{chain[chain.length - 1]!.envelope!.causationId}</code> (signals.db)
                </li>
              )}
            </ol>
          )}
        </div>
      </div>
    </details>
  );
}

function chainText(r: JournalRow): string {
  const p = (r.payload ?? {}) as Record<string, any>;
  if (p.why) return p.why;
  if (p.action) return describeAction(p.action);
  if (p.timer) return `${p.timer}${p.at ? ` → ${fmtTime(p.at)}` : ""}`;
  if (p.input) return describeInput(p.input);
  return "";
}

function ActionChip({ a }: { a: ActionView }) {
  const label = describeAction(a.action);
  let cls = "chip chip-on";
  let prefix = "would";
  if (a.disposition === "refused") {
    cls = "chip chip-bad";
    prefix = "refused";
  } else if (a.disposition === "requested") {
    cls = a.completed?.ok === false ? "chip chip-bad" : "chip chip-ok";
    prefix = a.completed === undefined ? "sending" : a.completed.ok ? "did" : "failed";
  }
  return (
    <span className={cls} title={a.reason ?? a.completed?.error ?? label}>
      {prefix} {label}
      {a.seen && <span className="nr-match" title={`${originLabel(a.seen.by)} made the same call ${fmtDelta(a.seen.delta)}`}> · {originLabel(a.seen.by)} ✓</span>}
    </span>
  );
}

function ActionDetail({ a }: { a: ActionView }) {
  return (
    <>
      <dt>{a.disposition === "suppressed" ? "Would" : a.disposition === "refused" ? "Refused" : "Did"}</dt>
      <dd className="small">
        {describeAction(a.action)}
        {a.action.kind === "call" && a.action.data ? <code> {JSON.stringify(a.action.data)}</code> : null}
        {a.reason && <div className="bad-text">{a.reason}</div>}
        {a.completed && <div>{a.completed.ok ? `HA accepted (context ${a.completed.haContextId ?? "?"})` : `failed: ${a.completed.error}`}</div>}
        {a.resend && (
          <div>
            {a.resend.dropped !== undefined
              ? `not resent: ${a.resend.dropped}`
              : `resent after the restart${a.resend.completed === undefined ? "" : a.resend.completed.ok ? ": sent" : `: failed: ${a.resend.completed.error}`}`}
          </div>
        )}
        <div className="muted">
          {a.seen ? `${originLabel(a.seen.by)} made the same call ${fmtDelta(a.seen.delta)}` : a.action.kind === "call" ? "no matching call outside Teobeanie (±15 s)" : ""}
        </div>
      </dd>
    </>
  );
}

function fmtDelta(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  if (Math.abs(s) < 0.5) return "at the same moment";
  return s > 0 ? `${s} s later` : `${-s} s earlier`;
}

/** A rule's desired value as plain text: "on", "30", "on, brightness_pct 30". */
function fmtDesired(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "object") return String(v);
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => (k === "state" ? String(x) : `${k} ${String(x)}`))
    .join(", ");
}
