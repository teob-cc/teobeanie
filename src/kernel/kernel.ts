// kernel.ts — turns a HeuristicDef into a journaled teob-ts Aggregate.
//
// One decision = one atomic journal batch:
//   Decided{input, why, reads}           ← causation: obsId | the TimerSet that fired | the action
//   ...domain events (the heuristic's E)  ← causation: Decided
//   TimerSet / TimerCancelled             ← durable: re-armed from state after a restart
//   ActionRequested | ActionSuppressed | ActionRefused   (active | shadow | vetoed)
// and later, out of band:
//   ActionCompleted{ok, haContextId}      ← causation: ActionRequested
// and after a restart that cut a notice off, in the batch that settles it:
//   ActionResent{of} | ResendDropped{reason}   ← causation: the interrupted action
//
// decideStep() (step.ts) is pure given newId/vet, and shared by the live aggregate,
// the simulator and the Studio, so tests exercise exactly the code that runs in the house.

import {
  CategoryId,
  TimerId,
  andRun,
  done,
  objectCodec,
  persist,
  stampEnvelope,
  tagCodec,
  ulid,
  type Aggregate,
  type Codec,
  type EntityId,
  type Effect,
} from "@lambda-house/teob-ts/core";
import type { AnyHeuristic, HouseFacts, Observed } from "./heuristic.js";
import type { Mode, SafeActuator } from "./actuator.js";
import type { FactReading } from "./rule.js";
import { RESEND_WITHIN_MS, applyEvent, decideStep, inputOf, resendStep, type KCommand, type KState, type StepGate } from "./step.js";

export * from "./step.js";

// ---- live aggregate ----

export interface InstanceRuntime {
  params: unknown;
  mode: Mode;
  /** Notifications per hour this instance sets for itself, over the heuristic's cap. */
  notifyPerHour?: number;
}

/** The cap on notifications per hour when neither the instance nor the heuristic sets one. */
export const DEFAULT_NOTIFY_PER_HOUR = 12;

export interface CompileDeps {
  /** Instance config by entity id (= instance id). */
  instance(id: string): InstanceRuntime | undefined;
  /** Live state of an entity at decision time. */
  observe(entity: string): Observed | undefined;
  actuator: SafeActuator;
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  /** Facts about the house (outdoor sources) every decision sees. */
  house?: HouseFacts;
  /** The derived facts' values now (fact.ts), by id or name. */
  fact?: (name: string) => FactReading | undefined;
  /** The heuristic's state as it now stands: recovered (seen at each command) and after each event. */
  onState?: (state: unknown) => void;
}

export type JournalEvent = { tag: string };

export interface CompiledHeuristic {
  aggregate: Aggregate<KCommand, void, JournalEvent, KState<unknown>>;
  eventCodec: Codec<JournalEvent>;
  stateCodec: Codec<KState<unknown>>;
}

export function compileHeuristic(def: AnyHeuristic, deps: CompileDeps): CompiledHeuristic {
  const category = CategoryId(def.id);
  const resendWithinMs = def.resendWithinMs ?? RESEND_WITHIN_MS;

  const aggregate: Aggregate<KCommand, void, JournalEvent, KState<unknown>> = {
    category,

    initial(id: EntityId) {
      const inst = deps.instance(id);
      return { s: def.initial(inst?.params), timers: {}, pending: {} };
    },

    async decide(ks, cmd, ctx): Promise<Effect<JournalEvent, void>> {
      const inst = deps.instance(ctx.entityId);
      if (inst === undefined) {
        deps.log("warn", `${def.id}/${ctx.entityId}: no such instance configured, ignoring ${cmd.tag}`);
        return done();
      }
      deps.onState?.(ks.s);
      const input = inputOf(ks, cmd);
      if (input === undefined) return done();
      const key = `${def.id}/${ctx.entityId}`;
      const notifyPerHour = inst.notifyPerHour ?? def.notifyPerHour ?? DEFAULT_NOTIFY_PER_HOUR;
      const gate: StepGate = { mode: inst.mode, vet: (action, now) => deps.actuator.vet(key, action, now, notifyPerHour) };
      const decided = decideStep(def, inst.params, ctx.entityId, ks, input, deps.observe, gate, ulid, deps.house, deps.fact);
      // Settling an interrupted action and resending it (a notice) is one batch.
      const resent = cmd.tag === "Interrupted" ? resendStep(ks, cmd.actionId, cmd.at, gate, resendWithinMs, ulid) : undefined;
      const step = resent === undefined ? decided : { ...decided, events: [...decided.events, ...resent.events], fire: [...decided.fire, ...resent.fire] };
      if (step.events.length === 0) return done();

      const stamped = step.events.map((s) =>
        stampEnvelope(s.event, {
          eventId: s.eventId,
          origin: "heuristic",
          correlationId: key,
          ...(s.causationId !== undefined ? { causationId: s.causationId } : {}),
        }),
      );
      return andRun(persist<JournalEvent, void>(...stamped), async () => {
        for (const op of step.timers) {
          if (op.op === "set") {
            await ctx.scheduleOnce(TimerId(op.timer), { tag: "Fire", timer: op.timer, at: op.at }, Math.max(0, op.at - Date.now()));
          } else {
            await ctx.cancelTimer(TimerId(op.timer));
          }
        }
        for (const f of step.fire) {
          void deps.actuator.execute(f.action, key).then((outcome) =>
            ctx.tellSelf({ tag: "Outcome", actionId: f.actionId, at: Date.now(), ...outcome }),
          );
        }
      });
    },

    apply: (ks, event) => {
      const next = applyEvent(def, ks, event);
      deps.onState?.(next.s);
      return next;
    },

    async onRecoveryComplete(ks, ctx) {
      for (const [timer, t] of Object.entries(ks.timers)) {
        await ctx.scheduleOnce(TimerId(timer), { tag: "Fire", timer, at: t.at }, Math.max(0, t.at - Date.now()));
      }
      // A restart between ActionRequested and its outcome: record it. A call is never
      // re-fired (the heuristic re-decides on start); a recent notice is sent once more.
      for (const actionId of Object.keys(ks.pending)) {
        await ctx.tellSelf({ tag: "Interrupted", actionId, at: Date.now() });
      }
    },
  };

  return {
    aggregate,
    eventCodec: tagCodec<JournalEvent>(),
    stateCodec: objectCodec<KState<unknown>>(`${def.id}.state`),
  };
}
