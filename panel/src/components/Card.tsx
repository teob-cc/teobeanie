import { useRef, useState } from "react";
import { api, type SignalPoint } from "../api";
import { OriginChip } from "./OriginChip";
import { Sparkline } from "./Sparkline";
import { fmtNum, fmtTime } from "../format";

export interface CardData {
  /** Unique React key (eventId when known). */
  key: string;
  /** Dedupe key across sources (view / journal / SSE) for the same event. */
  dupeKey: string;
  at: number;
  domain: string;
  service: string;
  entityIds: string[];
  summary: string;
  contextId: string | null;
  /** Who made the call (origin.ts). */
  by: string;
  eventId?: string;
  /** Raw HaCallServiceObserved payload — present for journal/SSE cards. */
  payload?: unknown;
  /** True when the card arrived over the live SSE stream. */
  live?: boolean;
}

const SPARK_SINCE_MS = 3 * 3600e3; // sparkline window: last 3 h
const SPARK_ENTITIES = 3; // fetch signals for the first 3 entity ids

type SparkData = SignalPoint[] | "loading" | "error";

export function Card({ card }: { card: CardData }) {
  const [sparks, setSparks] = useState<Record<string, SparkData>>({});
  const fetched = useRef(false);

  const loadSparks = () => {
    if (fetched.current) return;
    fetched.current = true;
    for (const id of card.entityIds.slice(0, SPARK_ENTITIES)) {
      setSparks((s) => ({ ...s, [id]: "loading" }));
      api
        .signals(id, Date.now() - SPARK_SINCE_MS)
        .then((r) => setSparks((s) => ({ ...s, [id]: r.rows })))
        .catch(() => setSparks((s) => ({ ...s, [id]: "error" })));
    }
  };

  const raw =
    card.payload ??
    ({
      domain: card.domain,
      service: card.service,
      entityIds: card.entityIds,
      at: card.at,
      contextId: card.contextId,
      by: card.by,
      note: "raw payload not loaded yet (projection card)",
    } as unknown);

  return (
    <details
      className={card.live ? "card card-live" : "card"}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) loadSparks();
      }}
    >
      <summary className="card-summary">
        <OriginChip by={card.by} />
        <span className="card-svc">
          {card.domain}.{card.service}
        </span>
        <span className="card-entities" title={card.entityIds.join(", ")}>
          {card.entityIds.join(", ")}
        </span>
        <time className="card-time tnum">{fmtTime(card.at)}</time>
      </summary>
      <div className="card-body">
        {card.entityIds.slice(0, SPARK_ENTITIES).map((id) => (
          <SparkRow key={id} id={id} data={sparks[id]} />
        ))}
        <pre className="card-raw tnum">{JSON.stringify(raw, null, 2)}</pre>
      </div>
    </details>
  );
}

function SparkRow({ id, data }: { id: string; data: SparkData | undefined }) {
  let body;
  if (data === undefined || data === "loading") {
    body = <span className="muted small">loading…</span>;
  } else if (data === "error") {
    body = <span className="muted small">no signal data</span>;
  } else if (data.length === 0) {
    body = <span className="muted small">no samples in last 3 h</span>;
  } else {
    const last = data[data.length - 1]!;
    const lastText =
      last.value === null
        ? "—"
        : typeof last.value === "number"
          ? fmtNum(last.value)
          : String(last.value);
    body = (
      <>
        <Sparkline rows={data} />
        <span className="spark-val tnum">
          {lastText}
          {last.unit ? ` ${last.unit}` : ""}
        </span>
      </>
    );
  }
  return (
    <div className="spark-row">
      <code className="spark-id" title={id}>
        {id}
      </code>
      {body}
    </div>
  );
}
