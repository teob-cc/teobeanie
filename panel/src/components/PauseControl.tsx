import { useState } from "react";
import { api, type PauseState } from "../api";
import { fmtDay, fmtTime } from "../format";
import { originLabel } from "../origin";

/** "alex, Today 14:02:10": who paused or resumed, and when. */
function byWhen(s: PauseState): string {
  const who = s.by !== undefined ? originLabel(s.by) : "?";
  return s.at !== undefined ? `${who}, ${fmtDay(s.at)} ${fmtTime(s.at)}` : who;
}

const hhmm = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The global pause in the header: whether heuristics act, and who paused them when.
 * A click opens the confirmation; pausing takes an optional reason. The new state
 * comes back on the journal frame too, so every open panel follows.
 */
export function PauseControl({ state, onChanged }: { state: PauseState | null; onChanged: (s: PauseState) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state === null) return null;

  const submit = () => {
    setBusy(true);
    setError(null);
    api
      .setPause(!state.paused, reason.trim() || undefined)
      .then((s) => {
        onChanged(s);
        setOpen(false);
        setReason("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const title = state.paused
    ? `All heuristics paused by ${byWhen(state)}${state.reason ? ` (${state.reason})` : ""}. Guards still act. Click to resume.`
    : `Heuristics act${state.by !== undefined ? ` (resumed by ${byWhen(state)})` : ""}. Click to pause them all.`;

  return (
    <div className="pause">
      <button className={state.paused ? "pause-btn pause-btn-paused" : "pause-btn"} onClick={() => setOpen(!open)} title={title} aria-expanded={open}>
        <span className={state.paused ? "dot dot-warn" : "dot dot-ok"} />
        {state.paused ? `Paused · ${state.by !== undefined ? originLabel(state.by) : "?"}${state.at !== undefined ? ` ${hhmm(state.at)}` : ""}` : "Active"}
      </button>
      {open && (
        <div className="pause-pop" role="dialog" aria-label={state.paused ? "resume heuristics" : "pause heuristics"}>
          {state.paused ? (
            <p>
              Paused by {byWhen(state)}
              {state.reason ? `: ${state.reason}` : ""}. Resume every heuristic?
            </p>
          ) : (
            <>
              <p>Pause every heuristic? They keep deciding, but nothing is switched or sent until they are resumed. Guards (the leak shutoff) still act.</p>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)" aria-label="reason" maxLength={200} />
            </>
          )}
          {error && <p className="pause-error">{error}</p>}
          <div className="pause-actions">
            <button className="tab" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button className="tab active" onClick={submit} disabled={busy}>
              {busy ? "…" : state.paused ? "Resume" : "Pause all"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
