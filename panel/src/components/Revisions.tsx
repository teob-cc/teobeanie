import { useEffect, useState } from "react";
import { api, type EditOutcome, type FileDiff, type RevisionRow, type TwinComparison } from "../api";
import { fmtDay, fmtTime } from "../format";

const outcomeError = (o: EditOutcome): string | null => (o.ok ? null : `rejected, nothing changed: ${o.error ?? "?"}`);

/**
 * The working set's revisions, newest first: each applied change with who made it and
 * what it changed. Diff shows a revision against the one before it; Roll back puts a
 * revision's files back (after a confirm), which is a new revision itself.
 */
export function Revisions({ reloadedAt, onRolledBack }: { reloadedAt?: number; onRolledBack: () => void }) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ n: number; files: FileDiff[] } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api
      .revisions()
      .then((r) => {
        setRows(r.revisions);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reloadedAt]);

  const diff = (r: RevisionRow) => {
    if (open?.n === r.revision) return setOpen(null);
    if (r.parent === undefined) return setOpen({ n: r.revision, files: [] });
    api
      .revisionDiff(r.parent, r.revision)
      .then((d) => setOpen({ n: r.revision, files: d.files }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const rollback = (n: number) => {
    setBusy(true);
    setError(null);
    api
      .rollback(n)
      .then((o) => {
        const err = outcomeError(o);
        if (err) throw new Error(err);
        setConfirm(null);
        setDone(`Rolled back to revision ${n}${"journaled" in o && o.journaled?.revision !== undefined ? ` (now revision ${o.journaled.revision})` : ""}.`);
        onRolledBack();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (error && rows === null) return <div className="banner">Revisions unavailable: {error}</div>;
  if (rows === null) return <p className="muted small">Loading revisions…</p>;
  return (
    <div>
      <p className="muted small">
        Every change to the config folder, from the panel, a file edit or an agent, is a revision. Roll back puts a revision's files back and reloads; that is a revision too, so it
        can be undone the same way.
      </p>
      {done && (
        <div className="banner">
          {done}
          <button className="tab" onClick={() => setDone(null)}>
            OK
          </button>
        </div>
      )}
      {error && <div className="banner">{error}</div>}
      {rows.length === 0 && <p className="muted">No revisions yet.</p>}
      {rows.map((r, i) => (
        <div key={r.revision} className="card">
          <div className="card-summary">
            <span className="small tnum">
              <b>#{r.revision}</b> <span className="muted">{fmtDay(r.at)} {fmtTime(r.at)}</span> · {r.by} · {r.summary}
              <span className="muted"> · {r.file}</span>
            </span>{" "}
            <button className="tab" onClick={() => diff(r)}>
              {open?.n === r.revision ? "Hide diff" : "Diff"}
            </button>{" "}
            {i > 0 && (
              <button className="tab" onClick={() => setConfirm(r.revision)} disabled={busy}>
                Roll back…
              </button>
            )}
          </div>
          {confirm === r.revision && (
            <div className="banner" role="dialog" aria-label={`roll back to ${r.revision}`}>
              Put the config folder back as it was at revision {r.revision}? The files that differ are written back and reloaded; if the reload refuses them, nothing changes.
              <button className="tab" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </button>
              <button className="tab active" onClick={() => rollback(r.revision)} disabled={busy}>
                {busy ? "…" : `Roll back to ${r.revision}`}
              </button>
            </div>
          )}
          {open?.n === r.revision &&
            (open.files.length === 0 ? (
              <p className="muted small">{r.parent === undefined ? "The first revision: nothing to compare it with." : "No file changed."}</p>
            ) : (
              open.files.map((f) => (
                <pre key={f.path} className="card-raw">
                  {f.diff}
                </pre>
              ))
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A shadow twin against its original: on how many input signals they decided the same
 * actions, where they differ, and Promote (after a confirm): the twin takes the
 * original's id and mode in one revision.
 */
export function TwinPanel({ twinKey, onPromoted }: { twinKey: string; onPromoted: () => void }) {
  const [c, setC] = useState<TwinComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .twin(twinKey)
      .then(setC)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [twinKey]);
  const promote = () => {
    setBusy(true);
    setError(null);
    api
      .promote(twinKey)
      .then((o) => {
        const err = outcomeError(o);
        if (err) throw new Error(err);
        setConfirm(false);
        onPromoted();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const act = (a: unknown): string => {
    const x = a as { kind?: string; service?: string; entities?: string[]; text?: string };
    return x.kind === "call" ? `${x.service} ${(x.entities ?? []).join(", ")}` : x.kind === "notify" ? `notify "${x.text}"` : JSON.stringify(a);
  };
  const side = (s?: { why?: string; actions: unknown[] }) =>
    s === undefined ? <span className="muted">no decision</span> : <>{s.actions.length > 0 ? s.actions.map(act).join("; ") : <span className="muted">nothing</span>}{s.why ? <span className="muted"> ({s.why})</span> : null}</>;
  return (
    <div className="card">
      <div className="card-summary">
        <span className="small">
          Shadow twin of <code>{c?.original ?? "…"}</code>
          {c && ` · last 24 h: ${c.compared} inputs compared, ${c.same} the same, ${c.compared - c.same} different`}
          {c && (c.other.original > 0 || c.other.twin > 0) && <span className="muted"> · other decisions {c.other.original} / {c.other.twin} (not compared)</span>}
        </span>{" "}
        <button className="tab" onClick={() => setConfirm(true)} disabled={busy || c === null}>
          Promote…
        </button>
      </div>
      {confirm && c && (
        <div className="banner" role="dialog" aria-label={`promote ${twinKey}`}>
          Promote {twinKey}? It takes {c.original}'s place, with that id and mode; {c.original} is removed (what it did stays in the journal). One revision, so a roll back undoes it.
          <button className="tab" onClick={() => setConfirm(false)} disabled={busy}>
            Cancel
          </button>
          <button className="tab active" onClick={promote} disabled={busy}>
            {busy ? "…" : "Promote"}
          </button>
        </div>
      )}
      {error && <div className="banner">{error}</div>}
      {c && c.differences.length > 0 && (
        <dl className="kv">
          {c.differences.map((d) => (
            <div key={d.obsId} style={{ display: "contents" }}>
              <dt className="small tnum">
                {fmtTime(d.at)} {d.input.entity} {d.input.state}
              </dt>
              <dd className="small">
                original: {side(d.original)}
                <br />
                twin: {side(d.twin)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
