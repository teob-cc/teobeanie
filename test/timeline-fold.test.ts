// The timeline fold reads only what is new in the audit stream: the projection runner it
// replaces read the whole stream on every cycle and held the event loop for seconds.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { categoryTypes, type Journal } from "@lambda-house/teob-ts/core";
import { createSqliteProjectionStore } from "@lambda-house/teob-ts/projection";
import { createSqliteRuntime, registration } from "@lambda-house/teob-ts/sqlite";
import { describe, expect, it, vi } from "vitest";
import { AUDIT_CATEGORY, AUDIT_ENTITY, auditAggregate, auditEventCodec, auditStateCodec, type AuditCommand, type AuditReply } from "../src/audit.js";
import { createTimelineFold, noderedTimeline, type TimelineView } from "../src/projections.js";

const auditCat = categoryTypes<AuditCommand, AuditReply>(AUDIT_CATEGORY);

const command = (i: number): AuditCommand => ({
  tag: "RecordCallService",
  domain: "light",
  service: "turn_on",
  entityIds: ["light.hallway"],
  serviceData: {},
  at: 1_752_900_000_000 + i,
  haContextId: `ctx-${i}`,
  haParentId: null,
  haUserId: null,
  by: "device",
});

async function house(n: number) {
  const path = join(mkdtempSync(join(tmpdir(), "teobeanie-timeline-")), "journal.db");
  const { runtime, journal } = createSqliteRuntime({ path }, [registration(auditAggregate, auditEventCodec, auditStateCodec)]);
  for (let i = 1; i <= n; i++) await runtime.tell(AUDIT_ENTITY, command(i), auditCat);
  await vi.waitFor(() => expect(journal.lastGlobalSeq()).toBe(n));
  const reads = { all: 0, from: [] as number[], rows: [] as number[] };
  const spied: Pick<Journal, "loadEvents" | "allEvents"> = {
    allEvents: (c, codec) => {
      reads.all++;
      return journal.allEvents(c, codec);
    },
    loadEvents: (c, e, from, codec) => {
      const rows = journal.loadEvents(c, e, from, codec);
      reads.from.push(from);
      reads.rows.push(rows.length);
      return rows;
    },
  };
  const store = createSqliteProjectionStore(new Database(":memory:"));
  const fold = createTimelineFold({ journal: spied, store });
  const view = () => store.get(noderedTimeline.projectionId, AUDIT_ENTITY)?.view as TimelineView | undefined;
  const close = async () => {
    await runtime.shutdown();
    journal.close();
  };
  return { runtime, journal, fold, view, reads, close };
}

describe("the timeline fold", () => {
  it("catches up once over the whole stream, as the runner did", async () => {
    const h = await house(30);
    h.fold.catchUp();
    expect(h.view()?.total).toBe(30);
    expect(h.view()?.cards[0]?.contextId).toBe("ctx-30");
    expect(h.reads.all).toBe(1);
    await h.close();
  });

  it("after that, folds only the new events, from the view's offset, never reading the whole stream", async () => {
    const h = await house(30);
    h.fold.catchUp();
    await h.runtime.tell(AUDIT_ENTITY, command(31), auditCat);
    await vi.waitFor(() => expect(h.journal.lastGlobalSeq()).toBe(31));
    expect(h.fold.fold()).toBe(1);
    expect(h.view()?.total).toBe(31);
    expect(h.view()?.cards[0]?.contextId).toBe("ctx-31");
    // Nothing new: one empty read from the end.
    expect(h.fold.fold()).toBe(0);
    expect(h.reads).toEqual({ all: 1, from: [30, 31], rows: [1, 0] });
    expect(h.fold.stats().cycles).toBe(3);
    await h.close();
  });

  it("without a catch-up, the first fold reads from the start and builds the same view", async () => {
    const h = await house(5);
    expect(h.fold.fold()).toBe(5);
    expect(h.view()?.total).toBe(5);
    expect(h.reads.all).toBe(0);
    await h.close();
  });
});
