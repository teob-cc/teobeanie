// door-watch: door-nag reminders and the sustained-presence notice.

import { describe, expect, it, simulate } from "teobeanie/test";
import { minutes } from "teobeanie";
import { doorNag, type DoorNagParams } from "./door-nag.ts";
import { sustainedNotice } from "./sustained-notice.ts";

describe("door-nag", () => {
  const garage: DoorNagParams = {
    door: "binary_sensor.garage_door",
    everyMin: 3,
    text: "Garage door is still open, but no one in the garage!",
    quietWhileOn: "binary_sensor.garage_occupancy",
  };

  it("reminds every everyMin while open, quiet while occupied, stops on close", () => {
    const sim = simulate(doorNag, garage, { "binary_sensor.garage_door": "off", "binary_sensor.garage_occupancy": "on" });
    sim.set("binary_sensor.garage_door", "on").advance(minutes(9));
    expect(sim.calls()).toEqual([]); // someone is in the garage
    sim.set("binary_sensor.garage_occupancy", "off").advance(minutes(6));
    expect(sim.calls()).toEqual([`notify: ${garage.text}`, `notify: ${garage.text}`]);
    sim.set("binary_sensor.garage_door", "off").advance(minutes(30));
    expect(sim.calls()).toHaveLength(2);
    expect(sim.journal.find((j) => j.event.tag === "Closed")?.event).toMatchObject({ openMin: 15, nags: 2 });
    expect(sim.timers).toEqual({});
  });

  it("arms on start when the door is already open", () => {
    const sim = simulate(doorNag, { door: "binary_sensor.front", everyMin: 1, text: "Front door is still open!" }, { "binary_sensor.front": "on" });
    sim.start().advance(minutes(2));
    expect(sim.calls()).toEqual(["notify: Front door is still open!", "notify: Front door is still open!"]);
  });
});

describe("sustained-notice", () => {
  it("someone lingering 5 min → one notice; leaving earlier → none", () => {
    const p = { entity: "binary_sensor.front_outside", forMin: 5, text: "Someone is at the front door" };
    const sim = simulate(sustainedNotice, p, { "binary_sensor.front_outside": "off" });
    sim.set("binary_sensor.front_outside", "on").advance(minutes(4)).set("binary_sensor.front_outside", "off").advance(minutes(5));
    expect(sim.calls()).toEqual([]);
    sim.set("binary_sensor.front_outside", "on").advance(minutes(30));
    expect(sim.calls()).toEqual(["notify: Someone is at the front door"]);
  });
});

describe("startup reconcile", () => {
  it("door nag keeps the cadence of the original opening", () => {
    const sim = simulate(doorNag, { door: "binary_sensor.d", everyMin: 30, text: "open" }, { "binary_sensor.d": "on" });
    const opened = sim.now;
    sim.advance(minutes(40)).start();
    expect(sim.timers["nag"]?.at).toBe(opened + minutes(60));
  });
});

describe("door-nag's card", () => {
  it("open since when and the reminders sent; closed since when", () => {
    const sim = simulate(doorNag, { door: "binary_sensor.shed", everyMin: 3, text: "Shed open" }, { "binary_sensor.shed": { state: "off", attributes: { friendly_name: "Shed door" } } });
    expect(sim.card().card).toEqual({ title: "Shed door", fields: [{ label: "Door", value: "closed", since: sim.now }] });
    sim.set("binary_sensor.shed", "on", { friendly_name: "Shed door" });
    const opened = sim.now;
    sim.advance(minutes(7));
    expect(sim.card().card?.fields).toEqual([
      { label: "Door", value: "open", since: opened, tone: "warn" },
      { label: "Reminders sent", value: 2 },
    ]);
    sim.set("binary_sensor.shed", "off", { friendly_name: "Shed door" });
    expect(sim.card().card?.fields).toEqual([{ label: "Door", value: "closed", since: sim.now }]);
  });

  it("drops the device-class word HA appends to a door's name", () => {
    const title = (name: string) =>
      simulate(doorNag, { door: "binary_sensor.shed", everyMin: 3, text: "Shed open" }, { "binary_sensor.shed": { state: "off", attributes: { friendly_name: name } } }).card().card?.title;
    expect(title("Shed door Door")).toBe("Shed door");
    expect(title("Garage Door Door")).toBe("Garage Door");
    expect(title("Back door")).toBe("Back door");
    expect(title("Door")).toBe("Door");
  });
});
