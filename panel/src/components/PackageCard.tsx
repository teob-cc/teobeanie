// PackageCard.tsx — the instances' cards on the House page, one row each: the title, a
// chip for its mode, its values and its buttons. A button runs the instance's command
// as the panel's HA user (POST api/command, journaled like a Telegram command), after
// its confirm text when it has one. "decisions →" opens its decisions in the Studio.

import { useState } from "react";
import { api } from "../api";
import { cardModel } from "../cards";
import type { InstanceCard } from "../../../src/house/view";

export function PackageCards({ cards, now, onDecisions }: { cards: InstanceCard[]; now: number; onDecisions: (key: string) => void }) {
  return (
    <>
      {cards.map((c) => (
        <PackageCard key={c.key} c={c} now={now} onDecisions={() => onDecisions(c.key)} />
      ))}
    </>
  );
}

function PackageCard({ c, now, onDecisions }: { c: InstanceCard; now: number; onDecisions: () => void }) {
  const m = cardModel(c, now);
  const [sending, setSending] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const press = (i: number) => {
    const b = m.buttons[i]!;
    if (b.confirm !== undefined && !window.confirm(b.confirm)) return;
    setSending(i);
    setSendError(null);
    api
      .command(b.command, b.args)
      .catch((e) => setSendError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(null));
  };

  return (
    <section className="hsec pcard" aria-label={`${m.title} (${c.key})`}>
      <div className="pcard-row">
        <div className="pcard-head">
          <span className="pcard-title">{m.title}</span>
          <span className={m.mode.className} title={m.mode.title}>
            {m.mode.text}
          </span>
        </div>
        {m.fields.map((f, i) => (
          <div className="stat" key={i}>
            <div className="stat-label">{f.label}</div>
            <div className={f.className}>
              {f.text}
              {f.unit !== undefined && <span className="unit"> {f.unit}</span>}
            </div>
            {f.sub !== undefined && (
              <div className="stat-sub tnum" title={f.subTitle}>
                {f.sub}
              </div>
            )}
          </div>
        ))}
        <div className="toolbar pcard-actions">
          {m.buttons.map((b, i) => (
            <button key={i} className="tab" disabled={b.disabled || sending !== null} title={`/${[b.command, ...b.args].join(" ")}`} onClick={() => press(i)}>
              {sending === i ? "…" : b.label}
            </button>
          ))}
          <button className="tab muted small" onClick={onDecisions} title={`Its decisions in the Studio (${c.key})`}>
            decisions →
          </button>
        </div>
      </div>
      {m.error !== undefined && <p className="muted small">{m.error}</p>}
      {sendError !== null && (
        <div className="banner" role="alert">
          Not sent: {sendError}
        </div>
      )}
    </section>
  );
}
