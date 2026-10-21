// button — the button pattern: a press does something. Presses come from event.*
// entities (each press is a new state; event_type says which button action) or from
// an MQTT topic with a JSON payload (zigbee2mqtt remotes publish {"action": "on"}),
// delivered through Home Assistant's MQTT trigger, so a remote without any HA entity
// works too. Each press sets entities to values, the way a rule's .to() does.
//
// button-cover (wall buttons moving the blinds to fixed positions) is this pattern.

import { actionsFor, defineHeuristic, param, type Action, type DecideCtx, type Desired, type Infer } from "teobeanie";

const BUTTON_PARAMS = param.object({
  events: param.entities("event").optional().doc("event.* entities whose presses count."),
  mqtt: param
    .object({ topic: param.string(), field: param.string().default("action") })
    .optional()
    .doc("An MQTT topic whose JSON payload names the action in `field`."),
  presses: param
    .list(
      param.object({
        action: param.string().optional().doc("The event_type or MQTT action; absent: any."),
        from: param.string().optional().doc("The event entity (or the MQTT topic); absent: any."),
        set: param.list(param.object({ entity: param.entity(), to: param.value<Desired>() })),
      }),
    )
    .doc("What a press does."),
  uses: param.entities().optional().doc("Targets another instance owns and shares (an appliance with its own auto-off), operated, not owned."),
});

export type ButtonParams = Infer<typeof BUTTON_PARAMS>;

type Event = { tag: "Pressed"; from: string; action: string | null };

const targets = (p: ButtonParams) => [...new Set(p.presses.flatMap((x) => x.set.map((s) => s.entity)))];

function press(ctx: DecideCtx<ButtonParams>, from: string, action: string | null) {
  const matching = ctx.params.presses.filter((x) => (x.from === undefined || x.from === from) && (x.action === undefined || x.action === action));
  const label = `${from}${action !== null ? ` ${action}` : ""}`;
  if (matching.length === 0) return { why: `${label}: nothing to do for this press` };
  const actions: Action[] = matching.flatMap((x) => x.set.flatMap((s) => actionsFor(s.entity, undefined, s.to as never)));
  const what = matching.flatMap((x) => x.set.map((s) => `${s.entity} → ${typeof s.to === "string" ? s.to : JSON.stringify(s.to)}`));
  return { why: `${label} pressed: ${what.join(", ")}`, events: [{ tag: "Pressed" as const, from, action }], actions };
}

export const button = defineHeuristic<ButtonParams, Record<string, never>, Event>({
  id: "button",
  pattern: "button",
  title: "Button",
  description: "A press on a remote or wall button (event entity or MQTT action) sets entities to values.",
  guarantees:
    "Each press sets the entities it names, the way a person pressing the button would expect; nothing happens between presses.",
  params: BUTTON_PARAMS,
  watch: (p) => p.events ?? [],
  actuates: (p) => targets(p).filter((e) => !(p.uses ?? []).includes(e)),
  uses: (p) => p.uses ?? [],
  triggers: (p): Record<string, Record<string, unknown>> => (p.mqtt ? { mqtt: { platform: "mqtt", topic: p.mqtt.topic } } : {}),
  initial: () => ({}),

  decide(_state, input, ctx) {
    if (input.kind === "signal") {
      // An event entity's state is the last press time: only a live change is a press.
      // Boot baselines and reconnect resyncs are not.
      if (input.origin !== "ha" || input.value === null || input.state === "unavailable" || input.state === "unknown") return undefined;
      const type = ctx.get(input.entity)?.attributes["event_type"];
      return press(ctx, input.entity, typeof type === "string" ? type : null);
    }
    if (input.kind === "trigger" && input.trigger === "mqtt" && ctx.params.mqtt) {
      const t = (input.data["trigger"] ?? {}) as { payload_json?: Record<string, unknown>; payload?: string };
      let body = t.payload_json;
      if (body === undefined && typeof t.payload === "string") {
        try {
          body = JSON.parse(t.payload) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }
      const action = body?.[ctx.params.mqtt.field ?? "action"];
      // zigbee2mqtt also publishes battery and link quality on the same topic: no action, no press.
      if (typeof action !== "string" || action === "") return undefined;
      return press(ctx, ctx.params.mqtt.topic, action);
    }
    return undefined;
  },

  evolve: (state) => state,
});

// ---- preset ----

const BUTTON_COVER_PARAMS = param.object({
  buttons: param
    .list(param.object({ entity: param.entity("event"), position: param.number({ unit: "%", min: 0, max: 100 }) }))
    .doc("Each button's event entity and the position its press moves the covers to."),
  covers: param.entities("cover").doc("The covers the buttons move."),
});

export type ButtonCoverParams = Infer<typeof BUTTON_COVER_PARAMS>;

const fromButtonCover = (p: ButtonCoverParams): ButtonParams => ({
  events: p.buttons.map((b) => b.entity),
  presses: p.buttons.map((b) => ({ from: b.entity, set: p.covers.map((c) => ({ entity: c, to: { position: b.position } })) })),
});

export const buttonCover = defineHeuristic<ButtonCoverParams, Record<string, never>, Event>({
  ...(button as unknown as ReturnType<typeof defineHeuristic<ButtonCoverParams, Record<string, never>, Event>>),
  id: "button-cover",
  title: "Button → cover position",
  description: "A button press moves covers to a fixed position.",
  guarantees:
    "Each press moves the covers to that button's position; nothing happens between presses.",
  params: BUTTON_COVER_PARAMS,
  watch: (p) => button.watch(fromButtonCover(p)),
  actuates: (p) => p.covers,
  uses: () => [],
  triggers: () => ({}),
  decide: (state, input, ctx) => button.decide(state, input, { ...ctx, params: fromButtonCover(ctx.params) }),
});

export default [button, buttonCover];
