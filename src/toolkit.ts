// toolkit.ts — the "teobeanie" module: everything a rule or heuristic file in the config
// folder may import. The custom loader resolves the bare specifier "teobeanie" (or
// "teob", its old name) to this
// file, and the Studio and the generated types describe the same module:
//
//   import { rule, keep, minutes } from "teobeanie";

export {
  anyOn,
  call,
  cancelTimer,
  commandArgs,
  defineHeuristic,
  fill,
  heldSince,
  hours,
  minutes,
  notify,
  outdoorEntities,
  readOutdoor,
  seconds,
  setTimer,
  type Action,
  type AnyHeuristic,
  type Card,
  type CardButton,
  type CardField,
  type CommandSource,
  type DecideCtx,
  type Decision,
  type HouseFacts,
  type HeuristicDef,
  type Input,
  type Json,
  type Observed,
  type Outdoor,
  type OutdoorSources,
  type Pattern,
  type TimerOp,
  type Value,
  type ViewCtx,
} from "./kernel/heuristic.js";
export {
  actionsFor,
  EVAL,
  keep,
  release,
  rule,
  type Desired,
  type DesiredFor,
  type Entity,
  type EntityId,
  type Fact,
  type FactId,
  type FactReading,
  type Facts,
  type FactValueOf,
  type Ha,
  type Keep,
  type Release,
  type LightAttributes,
  type RuleEvent,
  type RuleFn,
  type RuleOptions,
  type RuleState,
  type StatesOf,
  type Sun,
  type Want,
  type World,
} from "./kernel/rule.js";
export { fact, type AnyFact, type FactDef, type FactOptions, type FactValueIn } from "./kernel/fact.js";
export { houseZone, localInstant, localMinutes, localTimeOn, nextLocalTime, parseHhMm } from "./kernel/clock.js";
export { checkParams, describeParams, param, validateParams, type Infer, type ParamField, type ParamSpec, type Schema } from "./kernel/params.js";
