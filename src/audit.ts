// audit.ts — the call_service audit aggregate: journals every HA call_service event
// (Teobeanie's own calls, people's, other add-ons', automations', everything) into the
// ha-audit category, forever, each with who made it (`by`, see attribution.ts).
//
// The stream keeps the id it had when Node-RED was the only other automation
// ("nodered"): renaming it would orphan the rows already journaled. Those rows carry
// envelope origin "nodered" and no `by`; the codec upcasts them to by: "nodered".

import {
  CategoryId,
  EntityId,
  type Aggregate,
  type Codec,
  codecWithUpcasts,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  upcast,
} from "@lambda-house/teob-ts/core";
import { LEGACY_ORIGIN, type Origin } from "./attribution.js";

export type AuditCommand = {
  tag: "RecordCallService";
  domain: string;
  service: string;
  entityIds: string[];
  serviceData: Record<string, unknown>;
  at: number;
  haContextId: string | null;
  haParentId: string | null;
  haUserId: string | null;
  by: Origin;
};

export type AuditEvent = {
  tag: "HaCallServiceObserved";
  domain: string;
  service: string;
  entityIds: string[];
  serviceData: Record<string, unknown>;
  at: number;
  haContextId: string | null;
  haUserId: string | null;
  /** Who made the call; "nodered" on rows journaled before attribution. */
  by: Origin | typeof LEGACY_ORIGIN;
};

export interface AuditState {
  observed: number;
  /** Recently seen dedupe keys (see dedupeKeyOf) — cap 200, newest last. */
  recentContextIds: string[];
}

export type AuditReply = never;

export const AUDIT_CATEGORY: CategoryId = CategoryId("ha-audit");
/** Historical name, kept so the rows already journaled stay one stream (see above). */
export const AUDIT_ENTITY: EntityId = EntityId("nodered");

const RECENT_CAP = 200;

/**
 * Composite dedupe key. HA propagates ONE context.id across every service call
 * of a single automation/script run, so deduping on the bare context id would
 * drop all but the first of an automation's N action steps. The composite key
 * still collapses true reconnect duplicates (same event redelivered ⇒ identical
 * timeFired/domain/service/entityIds) while never collapsing distinct calls.
 * Null when the event carries no context id (no dedupe possible).
 */
function dedupeKeyOf(e: {
  haContextId: string | null;
  at: number;
  domain: string;
  service: string;
  entityIds: string[];
}): string | null {
  if (e.haContextId === null) return null;
  return `${e.haContextId}|${e.at}|${e.domain}.${e.service}|${e.entityIds.join(",")}`;
}

export const auditAggregate: Aggregate<AuditCommand, AuditReply, AuditEvent, AuditState> = {
  category: AUDIT_CATEGORY,

  initial: (): AuditState => ({ observed: 0, recentContextIds: [] }),

  async decide(state, cmd) {
    // HA can deliver duplicate call_service events around reconnects — dedupe on
    // the composite key (NOT the bare context id, which is shared across all
    // service calls of one automation run).
    const key = dedupeKeyOf(cmd);
    if (key !== null && state.recentContextIds.includes(key)) {
      return done();
    }
    // serviceData verbatim minus keys already lifted into entityIds.
    const serviceData: Record<string, unknown> = { ...cmd.serviceData };
    delete serviceData["entity_id"];
    delete serviceData["target"];
    const event: AuditEvent = {
      tag: "HaCallServiceObserved",
      domain: cmd.domain,
      service: cmd.service,
      entityIds: cmd.entityIds,
      serviceData,
      at: cmd.at,
      haContextId: cmd.haContextId,
      haUserId: cmd.haUserId,
      by: cmd.by,
    };
    return persist(
      stampEnvelope(event, { causationId: cmd.haContextId ?? undefined, origin: cmd.by }),
    );
  },

  apply(state, event) {
    const key = dedupeKeyOf(event);
    const recentContextIds =
      key === null
        ? state.recentContextIds
        : [...state.recentContextIds, key].slice(-RECENT_CAP);
    return { observed: state.observed + 1, recentContextIds };
  },
};

export const auditEventCodec: Codec<AuditEvent> = codecWithUpcasts(
  tagCodec<AuditEvent>("HaCallServiceObserved"),
  // Rows from before attribution, when every call was labelled Node-RED's.
  [upcast("HaCallServiceObserved", "HaCallServiceObserved", (d) => ({ by: LEGACY_ORIGIN, ...(d as object) }))],
);

export const auditStateCodec: Codec<AuditState> = objectCodec<AuditState>("AuditState");
