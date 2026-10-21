import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, type JournalRow, type TimelineCard } from "../api";
import { Card, type CardData } from "../components/Card";
import { dayKey, fmtDay } from "../format";
import { LEGACY_ORIGIN, originOf } from "../origin";
import type { SseFrame } from "../useSse";

const AUDIT_CATEGORY = "ha-audit";
const PAGE_SIZE = 50;
/** Retained-card cap for live prepends; grows by PAGE_SIZE per explicitly loaded page. */
const CARD_CAP = 1000;

// entityIds is part of the key: one automation run fires N service calls that
// share the same HA context id (and can share at/domain/service) — only the
// target entities distinguish them.
function dupeKeyOf(
  at: number,
  domain: string,
  service: string,
  entityIds: string[],
  contextId: string | null,
): string {
  return `${at}:${domain}.${service}:${entityIds.join(",")}:${contextId ?? ""}`;
}

function fromView(c: TimelineCard, i: number): CardData {
  return {
    key: c.eventId ?? `v-${c.at}-${i}`,
    dupeKey: dupeKeyOf(c.at, c.domain, c.service, c.entityIds, c.contextId),
    at: c.at,
    domain: c.domain,
    service: c.service,
    entityIds: c.entityIds,
    summary: c.summary,
    contextId: c.contextId,
    by: c.by ?? LEGACY_ORIGIN,
    eventId: c.eventId,
  };
}

function fromJournal(r: JournalRow): CardData {
  const p = (r.payload ?? {}) as Record<string, unknown>;
  const at = typeof p.at === "number" ? p.at : r.ts * 1000;
  const domain = typeof p.domain === "string" ? p.domain : "?";
  const service = typeof p.service === "string" ? p.service : "?";
  const entityIds = Array.isArray(p.entityIds) ? (p.entityIds as string[]) : [];
  const contextId = typeof p.haContextId === "string" ? p.haContextId : null;
  return {
    key: r.envelope?.eventId ?? `g-${r.globalSeq}`,
    dupeKey: dupeKeyOf(at, domain, service, entityIds, contextId),
    at,
    domain,
    service,
    entityIds,
    summary: `${domain}.${service} → ${entityIds.join(", ")}`,
    contextId,
    by: originOf(p),
    eventId: r.envelope?.eventId,
    payload: r.payload,
  };
}

/** Map a live SSE journal frame (contract §6.1) to cards. */
function fromSseFrame(frame: SseFrame): CardData[] {
  const frameAt = typeof frame.at === "number" ? frame.at : Date.now();
  const records: any[] = Array.isArray(frame.records) ? frame.records : [];
  return records.map((rec, i) => {
    const p = (rec?.encoded ?? {}) as Record<string, unknown>;
    const at = typeof p.at === "number" ? p.at : frameAt;
    const domain = typeof p.domain === "string" ? p.domain : "?";
    const service = typeof p.service === "string" ? p.service : "?";
    const entityIds = Array.isArray(p.entityIds) ? (p.entityIds as string[]) : [];
    const contextId = typeof p.haContextId === "string" ? p.haContextId : null;
    const eventId: string | undefined = rec?.envelope?.eventId;
    return {
      key: eventId ?? `s-${frameAt}-${rec?.sequenceNr ?? i}`,
      dupeKey: dupeKeyOf(at, domain, service, entityIds, contextId),
      at,
      domain,
      service,
      entityIds,
      summary: `${domain}.${service} → ${entityIds.join(", ")}`,
      contextId,
      by: originOf(p),
      eventId,
      payload: rec?.encoded,
      live: true,
    };
  });
}

/** Dedupe by dupeKey (first occurrence wins — order richer sources first), newest first. */
function mergeCards(...groups: CardData[][]): CardData[] {
  const seen = new Set<string>();
  const out: CardData[] = [];
  for (const group of groups) {
    for (const c of group) {
      if (seen.has(c.dupeKey)) continue;
      seen.add(c.dupeKey);
      out.push(c);
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

export function Today({ subscribe }: { subscribe: (fn: (f: SseFrame) => void) => () => void }) {
  const [cards, setCards] = useState<CardData[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const cursor = useRef<number | null>(null);
  const journalLoaded = useRef(false);
  const endRef = useRef(false);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // Live prepends are capped so a wall-panel tab open for weeks stays bounded;
  // the cap grows with every explicitly loaded page so infinite scroll is never
  // trimmed. slice(0, cap) keeps the NEWEST cards (list is sorted newest first).
  const maxCards = useRef(CARD_CAP);
  const capCards = useCallback((merged: CardData[]): CardData[] => {
    return merged.length > maxCards.current ? merged.slice(0, maxCards.current) : merged;
  }, []);

  const loadPage = useCallback(async () => {
    if (busy.current || endRef.current) return;
    busy.current = true;
    try {
      const params: { category: string; limit: number; cursor?: number } = {
        category: AUDIT_CATEGORY,
        limit: PAGE_SIZE,
      };
      if (cursor.current !== null) params.cursor = cursor.current;
      const r = await api.journal(params);
      const mapped = r.rows.map(fromJournal);
      if (!journalLoaded.current) {
        journalLoaded.current = true;
        // First journal page replaces overlapping view cards (same events, now
        // with raw payloads); keep live SSE cards and any older view cards.
        setCards((prev) =>
          mergeCards(
            prev.filter((c) => c.live),
            mapped,
            prev.filter((c) => !c.live),
          ),
        );
      } else {
        setCards((prev) => mergeCards(prev, mapped));
      }
      maxCards.current += PAGE_SIZE; // paged-in cards must never be trimmed by the live cap
      cursor.current = r.nextCursor;
      if (r.nextCursor === null) {
        endRef.current = true;
        setExhausted(true);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, []);

  // Initial load: fast paint from the projection view, then the authoritative
  // journal page 1 (raw payloads + pagination cursor).
  useEffect(() => {
    api
      .timelineView()
      .then((v) => {
        setTotal(v.view.total);
        if (!journalLoaded.current) {
          setCards((prev) => mergeCards(prev, v.view.cards.map(fromView)));
        }
      })
      .catch(() => {
        // 404 until the first audit event exists — not an error.
      });
    void loadPage();
  }, [loadPage]);

  // Live-prepend new cards from SSE journal frames; backfill gaps on reconnect.
  useEffect(() => {
    // The server sends a hello frame on every SSE (re)open. Events journaled
    // while the EventSource was down (add-on restart, ingress drop) were never
    // streamed, so on every hello after the first refetch journal page 1 (no
    // cursor) and merge — mergeCards dedupes and re-sorts, leaving pagination
    // state untouched.
    let helloSeen = false;
    return subscribe((f) => {
      if (f.type === "hello") {
        if (helloSeen) {
          api
            .journal({ category: AUDIT_CATEGORY, limit: PAGE_SIZE })
            .then((r) => {
              const mapped = r.rows.map(fromJournal);
              if (mapped.length > 0) setCards((prev) => capCards(mergeCards(prev, mapped)));
            })
            .catch(() => {
              // transient — the next reconnect (or live frames) will catch up
            });
        }
        helloSeen = true;
        return;
      }
      if (f.type !== "journal" || f.category !== AUDIT_CATEGORY) return;
      const fresh = fromSseFrame(f);
      if (fresh.length === 0) return;
      setCards((prev) => capCards(mergeCards(fresh, prev)));
      setTotal((t) => (t === null ? t : t + fresh.length));
    });
  }, [subscribe, capCards]);

  // Infinite scroll: sentinel at the bottom of the list.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadPage();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadPage]);

  let lastDay = "";
  return (
    <div className="timeline">
      <header className="view-head">
        <h2>Decision timeline</h2>
        <span className="muted small tnum">
          {total !== null ? `${total.toLocaleString()} call_service events journaled` : "…"}
        </span>
      </header>
      {error && (
        <div className="banner" role="alert">
          {error}
          <button onClick={() => void loadPage()}>retry</button>
        </div>
      )}
      {cards.length === 0 && !error && (
        <p className="muted">No calls journaled yet — waiting for call_service events.</p>
      )}
      {cards.map((c) => {
        const d = dayKey(c.at);
        const divider = d !== lastDay ? <div className="day-div">{fmtDay(c.at)}</div> : null;
        lastDay = d;
        return (
          <Fragment key={c.key}>
            {divider}
            <Card card={c} />
          </Fragment>
        );
      })}
      <div ref={sentinel} aria-hidden="true" />
      {exhausted && cards.length > 0 && <p className="muted small center">— end of journal —</p>}
    </div>
  );
}
