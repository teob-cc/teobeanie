// journal.ts — every MCP tool call, journaled: which tool, with what arguments, by
// whom, through which door, and how it went. An agent working on the house is itself
// audited, and the tool_calls tool reads this back.

import {
  CategoryId,
  EntityId,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  type Aggregate,
  type Codec,
} from "@lambda-house/teob-ts/core";
import type { Caller } from "./access.js";

export const MCP_CATEGORY: CategoryId = CategoryId("mcp-audit");
export const MCP_ENTITY: EntityId = EntityId("calls");

export interface ToolCalled {
  tag: "ToolCalled";
  at: number;
  tool: string;
  /** JSON of the arguments, cut at 2 KB. */
  args: string;
  caller: Caller;
  ok: boolean;
  error?: string;
  ms: number;
  /** The working-set revision a write tool made (develop.ts). */
  revision?: number;
}

export type McpCommand = { tag: "Record"; call: Omit<ToolCalled, "tag"> };
export type McpEvent = ToolCalled;

export const mcpAuditAggregate: Aggregate<McpCommand, void, McpEvent, { calls: number }> = {
  category: MCP_CATEGORY,
  initial: () => ({ calls: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag !== "Record") return done();
    return persist(stampEnvelope({ tag: "ToolCalled", ...cmd.call } satisfies ToolCalled, { origin: "mcp" }));
  },
  apply: (state) => ({ calls: state.calls + 1 }),
};

export const mcpEventCodec: Codec<McpEvent> = tagCodec<McpEvent>("ToolCalled");
export const mcpStateCodec: Codec<{ calls: number }> = objectCodec<{ calls: number }>("McpAuditState");
