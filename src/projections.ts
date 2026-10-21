// projections.ts — read models over the ha-audit journal.

import type { SingleStreamProjection } from "@lambda-house/teob-ts/projection";
import type { AuditEvent } from "./audit.js";

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
