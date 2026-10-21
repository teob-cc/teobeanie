// garage-door: commands that check, press the opener's button and confirm; the auto-close.

import { describe, expect, it, simulate } from "teobeanie/test";
import { hours, minutes, seconds, type Card } from "teobeanie";
import { garageDoor, type GarageDoorParams } from "./garage-door.ts";

describe("garage-door commands through the momentary relay", () => {
  const p: GarageDoorParams = { button: "switch.l1", contact: "binary_sensor.door", commands: { open: "garage_open", close: "garage_close" } };
  const tg = { channel: "telegram", user: "alex" };

  it("presses only when that gets the door there, and confirms from the contact", () => {
    const sim = simulate(garageDoor, p, { "binary_sensor.door": "off", "switch.l1": "off" });
    sim.command("garage_close", [], tg);
    expect(sim.calls()).toEqual(["notify: Garage is already closed."]);
    sim.command("garage_open", [], tg);
    expect(sim.calls().slice(1)).toEqual(["switch.turn_on switch.l1", "notify: Opening the garage..."]);
    sim.command("garage_open", [], tg);
    expect(sim.calls().at(-1)).toBe("notify: Still handling the previous garage command, try again shortly.");
    sim.advance(seconds(12)).set("binary_sensor.door", "on");
    expect(sim.calls().at(-1)).toBe("notify: Garage is open.");
    sim.advance(seconds(10)).command("garage_close", [], tg);
    expect(sim.calls().at(-1)).toBe("notify: Garage opened 10 s ago and may still be moving, try again shortly.");
    sim.advance(seconds(30)).command("garage_close", [], tg).advance(seconds(30));
    expect(sim.calls().slice(-3)).toEqual(["switch.turn_on switch.l1", "notify: Closing the garage...", "notify: Garage did not close within 30 s, please check it."]);
    expect(sim.whys()).toContain("close by alex: door open, pressing switch.l1");
  });

  it("an overridden text is used (slots filled in), the others stay as they were", () => {
    const sim = simulate(garageDoor, { ...p, texts: { opening: "Going up", sensorDown: "No reading ({state})" } }, { "binary_sensor.door": "off", "switch.l1": "off" });
    sim.command("garage_open", [], tg);
    expect(sim.calls()).toEqual(["switch.turn_on switch.l1", "notify: Going up"]);
    sim.advance(seconds(12)).set("binary_sensor.door", "on");
    expect(sim.calls().at(-1)).toBe("notify: Garage is open.");
    const down = simulate(garageDoor, { ...p, texts: { sensorDown: "No reading ({state})" } }, { "binary_sensor.door": "unavailable" });
    down.command("garage_open");
    expect(down.calls()).toEqual(["notify: No reading (unavailable)"]);
  });

  it("does not press with the door sensor unavailable", () => {
    const sim = simulate(garageDoor, p, { "binary_sensor.door": "unavailable" });
    sim.command("garage_open");
    expect(sim.calls()).toEqual(["notify: Garage door sensor is unavailable, not pressing the button."]);
  });

  describe("auto-close", () => {
    const ap: GarageDoorParams = { ...p, autoClose: { presence: "binary_sensor.shed_occupancy", keepOpenCommand: "garage_keep_open" } };
    const openEmpty = { "binary_sensor.door": "off", "binary_sensor.shed_occupancy": "off", "switch.l1": "off" };

    it("open with nobody there: announce after 3 min, remind 1 min before, close at 5, confirm", () => {
      const sim = simulate(garageDoor, ap, openEmpty).start();
      sim.set("binary_sensor.door", "on").advance(minutes(3));
      expect(sim.calls()).toEqual(["notify: Garage is open and no one is in it. I'll close it in 5 min. /garage_keep_open keeps it open."]);
      sim.advance(minutes(4));
      expect(sim.calls().at(-1)).toBe("notify: Closing the garage in 1 min. /garage_keep_open keeps it open.");
      sim.advance(minutes(1));
      expect(sim.calls().slice(2)).toEqual(["switch.turn_on switch.l1", "notify: Closing the garage now."]);
      sim.advance(seconds(15)).set("binary_sensor.door", "off");
      expect(sim.calls().at(-1)).toBe("notify: Garage is closed.");
      sim.advance(minutes(30));
      expect(sim.calls()).toHaveLength(5);
    });

    it("someone in the garage: no countdown; arriving after the announcement stops it and says so", () => {
      const sim = simulate(garageDoor, ap, { ...openEmpty, "binary_sensor.shed_occupancy": "on" }).start();
      sim.set("binary_sensor.door", "on").advance(minutes(20));
      expect(sim.calls()).toEqual([]);
      sim.set("binary_sensor.shed_occupancy", "off").advance(minutes(3)); // they leave: count from then
      expect(sim.calls()).toHaveLength(1);
      sim.advance(minutes(2)).set("binary_sensor.shed_occupancy", "on");
      expect(sim.calls().at(-1)).toBe("notify: Someone is in the garage, not closing it.");
      sim.advance(minutes(10));
      expect(sim.calls()).toHaveLength(2);
      // They leave again: the whole countdown again, from the announcement.
      sim.set("binary_sensor.shed_occupancy", "off").advance(minutes(3));
      expect(sim.calls().at(-1)).toContain("I'll close it in 5 min");
    });

    it("keep-open holds until the door closes; the next opening counts again", () => {
      const sim = simulate(garageDoor, ap, openEmpty).start();
      sim.set("binary_sensor.door", "on").advance(minutes(3));
      sim.command("garage_keep_open", [], tg);
      expect(sim.calls().at(-1)).toBe("notify: OK, I'll leave the garage open until it is closed.");
      sim.advance(hours(2));
      expect(sim.calls()).toHaveLength(2);
      sim.set("binary_sensor.door", "off").advance(minutes(1)).set("binary_sensor.door", "on").advance(minutes(3));
      expect(sim.calls().at(-1)).toContain("I'll close it in 5 min");
    });

    it("closed by hand during the countdown: nothing more; a presence sensor that reports nothing is not 'nobody'", () => {
      const sim = simulate(garageDoor, ap, openEmpty).start();
      sim.set("binary_sensor.door", "on").advance(minutes(4)).set("binary_sensor.door", "off").advance(minutes(10));
      expect(sim.calls()).toHaveLength(1);
      const blind = simulate(garageDoor, ap, { ...openEmpty, "binary_sensor.shed_occupancy": "unavailable" }).start();
      blind.set("binary_sensor.door", "on").advance(hours(1));
      expect(blind.calls()).toEqual([]);
    });

    it("open and empty since before a restart: the countdown starts from then", () => {
      const sim = simulate(garageDoor, ap, { ...openEmpty, "binary_sensor.door": "on" }, { t0: Date.UTC(2026, 0, 5, 12) });
      sim.advance(minutes(2)).start().advance(seconds(59));
      expect(sim.calls()).toEqual([]);
      sim.advance(seconds(1)); // 3 min after it opened, not after the restart
      expect(sim.calls()).toEqual(["notify: Garage is open and no one is in it. I'll close it in 5 min. /garage_keep_open keeps it open."]);
    });
  });
});

describe("garage-door's card", () => {
  const gp = { button: "switch.opener", contact: "binary_sensor.garage", commands: { open: "garage_open", close: "garage_close" }, autoClose: { presence: "binary_sensor.garage_occupancy", keepOpenCommand: "garage_keep_open" } };
  const buttons = (c: { card?: Card }) => c.card?.buttons?.map((b) => `${b.label}${b.disabled ? " (off)" : ""}`);

  it("open or closed since when; open and close as the commands do, confirmed", () => {
    const sim = simulate(garageDoor, gp, { "binary_sensor.garage": "off", "binary_sensor.garage_occupancy": "on", "switch.opener": "off" }).start();
    const t0 = sim.now;
    expect(sim.card().card).toEqual({
      title: "Garage door",
      fields: [{ label: "Door", value: "closed", since: t0 }],
      buttons: [
        { label: "Open", command: "garage_open", confirm: "Open the garage door?" },
        { label: "Close", command: "garage_close", confirm: "Close the garage door?", disabled: true },
        { label: "Keep open", command: "garage_keep_open", disabled: true },
      ],
    });
    // Pressed: under way, no second press until the door gets there.
    sim.advance(minutes(1)).command("garage_open", [], { channel: "panel", user: "alex" });
    expect(sim.card().card?.fields).toEqual([
      { label: "Door", value: "closed", since: t0 },
      { label: "Under way", value: "opening" },
    ]);
    expect(buttons(sim.card())).toEqual(["Open (off)", "Close (off)", "Keep open (off)"]);
    sim.advance(seconds(10)).set("binary_sensor.garage", "on");
    expect(sim.card().card?.fields).toEqual([{ label: "Door", value: "open", since: sim.now, tone: "warn" }]);
    expect(buttons(sim.card())).toEqual(["Open (off)", "Close", "Keep open"]);
    sim.command("garage_keep_open");
    expect(sim.card().card?.fields[1]).toEqual({ label: "Auto-close", value: "kept open until it closes" });
    expect(buttons(sim.card())).toEqual(["Open (off)", "Close", "Keep open (off)"]);
  });

  it("a contact not reporting is said, and nothing to press", () => {
    const sim = simulate(garageDoor, gp, { "binary_sensor.garage": "unavailable", "binary_sensor.garage_occupancy": "on" });
    expect(sim.card().card?.fields).toEqual([{ label: "Door", value: "unavailable", since: sim.now, tone: "bad" }]);
    expect(buttons(sim.card())).toEqual(["Open (off)", "Close (off)", "Keep open (off)"]);
  });
});
