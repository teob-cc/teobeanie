// projections.ts — read models over the ha-audit journal.

import { SequenceNr, type Journal } from "@lambda-house/teob-ts/core";
import { offsetGuardedFold, runProjection, type ProjectionStore, type SingleStreamProjection } from "@lambda-house/teob-ts/projection";
import { AUDIT_CATEGORY, AUDIT_ENTITY, auditEventCodec, type AuditEvent } from "./audit.js";

export interface TimelineCard {
  at: number;
  domain: string;
  service: string;
  entityIds: string[];
  /** e.g. "light.turn_on → light.hallway" */
  summary: string;
  contextId: string | null;
  /** Who made the call: "teob" (Teobeanie), person:<name>, system:<name>, user:<id>, device; "nodered" on old rows. */
  by: string;
  eventId?: string;
}

export interface TimelineView {
  /** Newest FIRST, capped at 200. */
  cards: TimelineCard[];
  total: number;
}

/**
 * Timeline of every observed call_service, whoever made it. The id is from when
 * Node-RED was the only other caller; the panel reads the view by it.
 */
export const noderedTimeline: SingleStreamProjection<AuditEvent, TimelineView> = {
  projectionId: "nodered-timeline",
  category: "ha-audit",
  initialState: (): TimelineView => ({ cards: [], total: 0 }),
  evolve: (view, event) => {
    const action = `${event.domain}.${event.service}`;
    const card: TimelineCard = {
      at: event.at,
      domain: event.domain,
      service: event.service,
      entityIds: event.entityIds,
      summary: event.entityIds.length > 0 ? `${action} → ${event.entityIds.join(", ")}` : action,
      contextId: event.haContextId,
      by: event.by,
    };
    return { cards: [card, ...view.cards].slice(0, 200), total: view.total + 1 };
  },
};

export interface TimelineFold {
  /** Fold the audit events written since the last fold; returns how many. */
  fold(): number;
  stats(): { cycles: number; lastCycleAt: number | null; lastCycleMs: number | null };
}

/**
 * Keeps the timeline view current by reading only the audit events after its offset.
 *
 * teob-ts' projection runner read the whole ha-audit stream on every cycle (every 2 s,
 * and once for every journal batch of any stream), synchronously. With a few hundred
 * thousand journal rows that held the event loop for seconds at a time, and during a
 * burst of batches for 10 s and more: HA's answers, the call_service events, the
 * heuristics' timers and the chat all waited (24 Nov 19:08: calls HA had run at once
 * "timed out" and were retried). This reads the one audit stream from the view's offset
 * (an index seek), so a fold with nothing new costs next to nothing.
 *
 * start() catches up the way the runner did (every stream of the category, once), then
 * folds after the batches it is told of, and every pollMs as a safety net.
 */
export function createTimelineFold(deps: {
  journal: Pick<Journal, "loadEvents" | "allEvents">;
  store: ProjectionStore;
  now?: () => number;
}): TimelineFold & { catchUp(): void } {
  const now = deps.now ?? Date.now;
  const p = noderedTimeline;
  let cycles = 0;
  let lastCycleAt: number | null = null;
  let lastCycleMs: number | null = null;
  const timed = <T>(f: () => T): T => {
    const at = now();
    const t0 = performance.now();
    try {
      return f();
    } finally {
      cycles++;
      lastCycleAt = at;
      lastCycleMs = performance.now() - t0;
    }
  };
  return {
    catchUp() {
      timed(() => runProjection(p, deps.journal as Journal, deps.store, { eventCodec: auditEventCodec }));
    },
    fold() {
      return timed(() => {
        const from = deps.store.getOffset(p.projectionId, AUDIT_CATEGORY, AUDIT_ENTITY);
        let n = 0;
        for (const { sequenceNr, event } of deps.journal.loadEvents(AUDIT_CATEGORY, AUDIT_ENTITY, SequenceNr(from), auditEventCodec)) {
          const folded = offsetGuardedFold(deps.store, {
            projectionId: p.projectionId,
            category: AUDIT_CATEGORY,
            entityId: AUDIT_ENTITY,
            sequenceNr,
            viewId: AUDIT_ENTITY,
            initialState: p.initialState,
            evolve: p.evolve,
            event,
          });
          if (folded) n++;
        }
        return n;
      });
    },
    stats: () => ({ cycles, lastCycleAt, lastCycleMs }),
  };
}
