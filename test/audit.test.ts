import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedBatch } from "@lambda-house/teob-ts/core";
import { categoryTypes, persist, stampEnvelope } from "@lambda-house/teob-ts/core";
import { createSingleRuntime } from "@lambda-house/teob-ts/inmem";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_CATEGORY,
  AUDIT_ENTITY,
  auditAggregate,
  auditEventCodec,
  auditStateCodec,
  type AuditCommand,
  type AuditEvent,
  type AuditReply,
} from "../src/audit.js";
import { noderedTimeline, type TimelineView } from "../src/projections.js";

const auditCat = categoryTypes<AuditCommand, AuditReply>(AUDIT_CATEGORY);

function command(overrides: Partial<AuditCommand> = {}): AuditCommand {
  return {
    tag: "RecordCallService",
    domain: "light",
    service: "turn_on",
    entityIds: ["light.hallway"],
    serviceData: { brightness_pct: 100, entity_id: "light.hallway" },
    at: 1_752_900_000_000,
    haContextId: "ctx-1",
    haParentId: null,
    haUserId: null,
    by: "device",
    ...overrides,
  };
}

function setup() {
  const batches: PersistedBatch[] = [];
  const { runtime } = createSingleRuntime(auditAggregate, auditEventCodec, auditStateCodec, {
    onPersisted: (batch) => batches.push(batch),
  });
  return { runtime, batches };
}

describe("call_service audit aggregate", () => {
  it("persists HaCallServiceObserved with envelope causationId = HA context id, origin = who made it", async () => {
    const { runtime, batches } = setup();
    await runtime.tell(AUDIT_ENTITY, command({ haUserId: "a1b2c3d4e5f6a7b8", by: "person:alex" }), auditCat);
    await vi.waitFor(() => expect(batches).toHaveLength(1));

    const batch = batches[0]!;
    expect(batch.category).toBe(AUDIT_CATEGORY);
    expect(batch.entityId).toBe(AUDIT_ENTITY);
    expect(batch.records).toHaveLength(1);

    const record = batch.records[0]!;
    expect(record.manifest).toBe("HaCallServiceObserved");
    expect(record.envelope.causationId).toBe("ctx-1");
    expect(record.envelope.origin).toBe("person:alex");
    expect(record.envelope.v).toBe(1);
    expect(typeof record.envelope.eventId).toBe("string");
    expect(record.envelope.eventId.length).toBeGreaterThan(0);

    const encoded = record.encoded as AuditEvent;
    expect(encoded.domain).toBe("light");
    expect(encoded.service).toBe("turn_on");
    expect(encoded.entityIds).toEqual(["light.hallway"]);
    // entity_id/target are lifted into entityIds — stripped from stored serviceData.
    expect(encoded.serviceData).toEqual({ brightness_pct: 100 });
    expect(encoded.haContextId).toBe("ctx-1");
    expect(encoded.haUserId).toBe("a1b2c3d4e5f6a7b8");
    expect(encoded.by).toBe("person:alex");
  });

  it("teob's, a system user's and the device's calls carry their origin", async () => {
    const { runtime, batches } = setup();
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "c1", by: "teob" }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "c2", by: "system:Supervisor" }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "c3", by: "device" }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "c4", by: "user:01234567" }), auditCat);
    await vi.waitFor(() => expect(batches).toHaveLength(4));
    expect(batches.map((b) => [b.records[0]!.envelope.origin, (b.records[0]!.encoded as AuditEvent).by])).toEqual([
      ["teob", "teob"],
      ["system:Supervisor", "system:Supervisor"],
      ["device", "device"],
      ["user:01234567", "user:01234567"],
    ]);
  });

  it("dedupes duplicate HA context ids, but persists distinct ones", async () => {
    const { runtime, batches } = setup();
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "ctx-dup" }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "ctx-dup" }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "ctx-other", service: "turn_off" }), auditCat);
    await vi.waitFor(() => expect(batches).toHaveLength(2));

    expect((batches[0]!.records[0]!.encoded as AuditEvent).haContextId).toBe("ctx-dup");
    expect((batches[1]!.records[0]!.encoded as AuditEvent).haContextId).toBe("ctx-other");
    // Give the mailbox a beat: the duplicate must NOT surface late.
    await new Promise((r) => setTimeout(r, 20));
    expect(batches).toHaveLength(2);
  });

  it("journals every step of one automation run — shared context id, distinct calls", async () => {
    // HA propagates ONE context.id across all service calls of a single
    // automation/script run; only true redeliveries (identical call) may dedupe.
    const { runtime, batches } = setup();
    const ctx = "ctx-automation-run";
    await runtime.tell(
      AUDIT_ENTITY,
      command({ haContextId: ctx, entityIds: ["light.kitchen_ceiling"] }),
      auditCat,
    );
    await runtime.tell(
      AUDIT_ENTITY,
      command({ haContextId: ctx, entityIds: ["light.den_ceiling"] }),
      auditCat,
    );
    await runtime.tell(
      AUDIT_ENTITY,
      command({ haContextId: ctx, domain: "switch", service: "turn_off", entityIds: ["switch.water_valve"] }),
      auditCat,
    );
    // Exact redelivery of step 1 (reconnect duplicate) — must be dropped.
    await runtime.tell(
      AUDIT_ENTITY,
      command({ haContextId: ctx, entityIds: ["light.kitchen_ceiling"] }),
      auditCat,
    );
    await vi.waitFor(() => expect(batches).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => (b.records[0]!.encoded as AuditEvent).entityIds[0])).toEqual([
      "light.kitchen_ceiling",
      "light.den_ceiling",
      "switch.water_valve",
    ]);
  });

  it("persists null-context commands without a causation stamp", async () => {
    const { runtime, batches } = setup();
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: null }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: null }), auditCat);
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    expect(batches[0]!.records[0]!.envelope.causationId).toBeUndefined();
    expect(batches[0]!.records[0]!.envelope.origin).toBe("device");
  });

  it("envelope stamp is invisible to the persisted JSON payload", async () => {
    const { runtime, batches } = setup();
    await runtime.tell(AUDIT_ENTITY, command(), auditCat);
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const json = JSON.stringify(batches[0]!.records[0]!.encoded);
    expect(json).not.toContain("causationId");
    expect(json).not.toContain("eventId");
  });
});

describe("noderedTimeline projection", () => {
  function event(i: number): AuditEvent {
    return {
      tag: "HaCallServiceObserved",
      domain: "light",
      service: "turn_on",
      entityIds: [`light.lamp_${i}`],
      serviceData: {},
      at: 1_752_900_000_000 + i,
      haContextId: `ctx-${i}`,
      haUserId: null,
      by: "device",
    };
  }

  it("builds a newest-first view capped at 200 cards, counting the total", () => {
    let view: TimelineView = noderedTimeline.initialState();
    for (let i = 0; i < 205; i++) {
      view = noderedTimeline.evolve(view, event(i), AUDIT_ENTITY);
    }
    expect(view.total).toBe(205);
    expect(view.cards).toHaveLength(200);
    expect(view.cards[0]!.entityIds).toEqual(["light.lamp_204"]); // newest first
    expect(view.cards[199]!.entityIds).toEqual(["light.lamp_5"]); // oldest 5 evicted
    expect(view.cards[0]!.summary).toBe("light.turn_on → light.lamp_204");
    expect(view.cards[0]!.contextId).toBe("ctx-204");
    expect(view.cards[0]!.by).toBe("device");
  });

  it("summarizes entity-less calls without an arrow", () => {
    const view = noderedTimeline.evolve(
      noderedTimeline.initialState(),
      { ...event(0), entityIds: [] },
      AUDIT_ENTITY,
    );
    expect(view.cards[0]!.summary).toBe("light.turn_on");
  });
});

describe("rows journaled before attribution", () => {
  // The aggregate as it was: no `by`, every row stamped origin "nodered".
  const legacyAggregate = {
    ...auditAggregate,
    async decide(_s: unknown, cmd: AuditCommand) {
      const { tag: _t, haParentId: _p, by: _b, ...rest } = cmd;
      return persist(stampEnvelope({ tag: "HaCallServiceObserved", ...rest }, { causationId: cmd.haContextId ?? undefined, origin: "nodered" }));
    },
  } as unknown as typeof auditAggregate;

  it("still load: the stream recovers over them, and they read back as by nodered", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "teobeanie-audit-")), "journal.db");
    const old = createSqliteRuntime({ path }, [registration(legacyAggregate, auditEventCodec, auditStateCodec)]);
    await old.runtime.tell(AUDIT_ENTITY, command({ haContextId: "ctx-old" }), auditCat);
    await vi.waitFor(() => expect(old.journal.lastGlobalSeq()).toBe(1));
    await old.runtime.shutdown();
    old.journal.close();

    const { runtime, journal } = createSqliteRuntime({ path }, [registration(auditAggregate, auditEventCodec, auditStateCodec)]);
    // Same stream: the old row's dedupe key survived recovery, so its redelivery is dropped.
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "ctx-old" }), auditCat);
    await runtime.tell(AUDIT_ENTITY, command({ haContextId: "ctx-new", haUserId: "a1b2c3d4e5f6a7b8", by: "person:alex" }), auditCat);
    await vi.waitFor(() => expect(journal.lastGlobalSeq()).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(journal.lastGlobalSeq()).toBe(2);

    const rows = journal.queryEvents({ category: AUDIT_CATEGORY, order: "asc", limit: 10 });
    expect(rows.map((r) => [r.entityId, r.envelope?.origin, (r.payload as { by?: string }).by])).toEqual([
      ["nodered", "nodered", undefined],
      ["nodered", "person:alex", "person:alex"],
    ]);
    const decoded = rows.map((r) => auditEventCodec.decode(r.manifest, r.payload));
    expect(decoded.map((e) => e.by)).toEqual(["nodered", "person:alex"]);
    let view: TimelineView = noderedTimeline.initialState();
    for (const e of decoded) view = noderedTimeline.evolve(view, e, AUDIT_ENTITY);
    expect(view.cards.map((c) => [c.contextId, c.by])).toEqual([
      ["ctx-new", "person:alex"],
      ["ctx-old", "nodered"],
    ]);
    await runtime.shutdown();
    journal.close();
  });
});
