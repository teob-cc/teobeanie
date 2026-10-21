// button and button-cover: a press sets entities.

import { describe, expect, it, simulate } from "teobeanie/test";
import { button, buttonCover, type ButtonParams } from "./button.ts";

describe("button", () => {
  const remote: ButtonParams = {
    mqtt: { topic: "zigbee2mqtt/Remote" },
    presses: [
      { action: "on", set: [{ entity: "switch.coffee_machine", to: "on" }] },
      { action: "off", set: [{ entity: "switch.coffee_machine", to: "off" }] },
    ],
    uses: ["switch.coffee_machine"],
  };
  const mqtt = (payload: unknown) => ({ trigger: { platform: "mqtt", topic: "zigbee2mqtt/Remote", payload_json: payload } });

  it("an MQTT action sets the target; battery reports on the same topic are not presses", () => {
    expect(button.triggers!(remote)).toEqual({ mqtt: { platform: "mqtt", topic: "zigbee2mqtt/Remote" } });
    const sim = simulate(button, remote, { "switch.coffee_machine": "off" });
    sim.trigger("mqtt", mqtt({ action: "on", battery: 100 })).trigger("mqtt", mqtt({ battery: 99, linkquality: 120 }));
    sim.trigger("mqtt", mqtt({ action: "off" })).trigger("mqtt", mqtt({ action: "brightness_move_up" }));
    expect(sim.calls()).toEqual(["switch.turn_on switch.coffee_machine", "switch.turn_off switch.coffee_machine"]);
    expect(sim.whys().at(-1)).toBe("zigbee2mqtt/Remote brightness_move_up: nothing to do for this press");
  });

  it("an event entity's event_type picks the action", () => {
    const p: ButtonParams = { events: ["event.wall"], presses: [{ action: "double_press", set: [{ entity: "light.hall", to: "off" }] }] };
    const sim = simulate(button, p, { "event.wall": "2026-01-01T00:00:00Z" });
    sim.set("event.wall", "2026-01-05T12:00:00Z", { event_type: "press" });
    sim.set("event.wall", "2026-01-05T12:00:05Z", { event_type: "double_press" });
    expect(sim.calls()).toEqual(["light.turn_off light.hall"]);
  });
});

describe("button-cover", () => {
  const p = { buttons: [{ entity: "event.btn_1", position: 0 }, { entity: "event.btn_2", position: 100 }], covers: ["cover.a", "cover.b"] };

  it("a press moves both covers", () => {
    const sim = simulate(buttonCover, p, { "event.btn_1": "2026-08-08T18:39:37.729+00:00" });
    sim.set("event.btn_1", "2026-10-12T10:00:00.000+00:00");
    expect(sim.calls()).toEqual(["cover.set_cover_position cover.a", "cover.set_cover_position cover.b"]);
    expect(sim.actions()[0]!.action).toMatchObject({ data: { position: 0 } });
  });
});
