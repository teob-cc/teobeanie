// houseFormat.ts — how an entity's state reads in the House view: "Open", "21.4 °C",
// "Heat · 20.5 → 21 °C", "Home". Pure.

import type { HouseEntity } from "../../src/house/view";
import { brightnessPct, isActive, isAvailable, num } from "../../src/house/summary";
import { fmtNum, rel } from "./format";

const BINARY: Record<string, [string, string]> = {
  door: ["Open", "Closed"],
  garage_door: ["Open", "Closed"],
  window: ["Open", "Closed"],
  opening: ["Open", "Closed"],
  moisture: ["Wet", "Dry"],
  smoke: ["Smoke", "Clear"],
  gas: ["Gas", "Clear"],
  carbon_monoxide: ["CO", "Clear"],
  motion: ["Motion", "Clear"],
  occupancy: ["Occupied", "Clear"],
  presence: ["Present", "Away"],
  problem: ["Problem", "OK"],
  safety: ["Unsafe", "Safe"],
  tamper: ["Tampered", "OK"],
  running: ["Running", "Idle"],
  heat: ["On", "Off"],
  battery: ["Low", "Normal"],
  lock: ["Unlocked", "Locked"],
  plug: ["Plugged in", "Unplugged"],
  connectivity: ["Connected", "Disconnected"],
};

const WEATHER: Record<string, string> = {
  "clear-night": "Clear night",
  cloudy: "Cloudy",
  exceptional: "Exceptional",
  fog: "Fog",
  hail: "Hail",
  lightning: "Lightning",
  "lightning-rainy": "Thunderstorm",
  partlycloudy: "Partly cloudy",
  pouring: "Pouring",
  rainy: "Rain",
  snowy: "Snow",
  "snowy-rainy": "Sleet",
  sunny: "Sunny",
  windy: "Windy",
  "windy-variant": "Windy, cloudy",
};

export const weatherLabel = (condition: string): string => WEATHER[condition] ?? sentence(condition);

const sentence = (s: string): string => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const unitOf = (e: HouseEntity): string => {
  const u = e.attributes["unit_of_measurement"];
  return typeof u === "string" ? u : "";
};

const attrNum = (e: HouseEntity, k: string): number | null => {
  const v = e.attributes[k];
  return typeof v === "number" ? v : null;
};

/** Value text for an entity row. */
export function stateText(e: HouseEntity, now: number): string {
  if (!isAvailable(e)) return e.state === "" ? "—" : e.state;
  const dc = typeof e.attributes["device_class"] === "string" ? e.attributes["device_class"] : "";
  switch (e.domain) {
    case "binary_sensor": {
      const labels = BINARY[dc] ?? ["On", "Off"];
      return e.state === "on" ? labels[0] : labels[1];
    }
    case "person":
    case "device_tracker":
      return e.state === "home" ? "Home" : e.state === "not_home" ? "Away" : sentence(e.state);
    case "light": {
      const b = brightnessPct(e);
      return e.state === "on" ? (b === null ? "On" : `On · ${b}%`) : "Off";
    }
    case "climate": {
      const cur = attrNum(e, "current_temperature");
      const target = attrNum(e, "temperature");
      const u = typeof e.attributes["temperature_unit"] === "string" ? e.attributes["temperature_unit"] : "°C";
      const parts = [sentence(e.state)];
      if (cur !== null) parts.push(target !== null && e.state !== "off" ? `${fmtNum(cur)} → ${fmtNum(target)} ${u}` : `${fmtNum(cur)} ${u}`);
      return parts.join(" · ");
    }
    case "cover": {
      const p = attrNum(e, "current_position");
      return p === null ? sentence(e.state) : `${sentence(e.state)} · ${p}%`;
    }
    case "fan": {
      const p = attrNum(e, "percentage");
      return e.state === "on" && p !== null ? `On · ${p}%` : sentence(e.state);
    }
    case "sun":
      return e.state === "above_horizon" ? "Above horizon" : "Below horizon";
    case "weather": {
      const t = attrNum(e, "temperature");
      const u = typeof e.attributes["temperature_unit"] === "string" ? e.attributes["temperature_unit"] : "°C";
      return t === null ? weatherLabel(e.state) : `${weatherLabel(e.state)} · ${fmtNum(t)} ${u}`;
    }
    case "event":
    case "button":
    case "input_button": {
      const at = Date.parse(e.state);
      return Number.isFinite(at) ? `pressed ${rel(now, at)}` : e.state;
    }
  }
  if (dc === "timestamp") {
    const at = Date.parse(e.state);
    if (Number.isFinite(at)) return at > now ? new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : rel(now, at);
  }
  const n = num(e);
  if (n !== null) return `${fmtNum(n)}${unitOf(e) ? ` ${unitOf(e)}` : ""}`;
  if (e.state === "on" || e.state === "off") return e.state === "on" ? "On" : "Off";
  return sentence(e.state);
}

/** chip class for a row's value: alert roles that are on are bad, other active states accent. */
export function stateTone(e: HouseEntity): "bad" | "on" | "off" | "plain" | "muted" {
  if (!isAvailable(e)) return "muted";
  if (e.role === "leak" || e.role === "smoke" || e.role === "gas_alarm" || e.role === "co_alarm" || e.role === "problem") return e.state === "on" ? "bad" : "off";
  if (num(e) !== null && e.domain === "sensor") return "plain";
  if (["binary_sensor", "light", "switch", "input_boolean", "fan", "person", "device_tracker", "lock", "cover", "valve", "climate", "media_player"].includes(e.domain)) {
    return isActive(e) ? "on" : "off";
  }
  return "plain";
}

/** Strip the group's name off the front of an entity name: "Heat pump Flow temperature" → "Flow temperature". */
export function shortName(name: string, group: string): string {
  if (group !== "" && name.toLowerCase().startsWith(`${group.toLowerCase()} `) && name.length > group.length + 1) {
    const rest = name.slice(group.length + 1);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return name;
}

/** "1.2 kW" / "830 W" */
export function fmtWatts(w: number): string {
  const a = Math.abs(w);
  if (a >= 1000) return `${fmtNum(w / 1000)} kW`;
  return `${Math.round(w)} W`;
}

/** "12m" style duration since `at`, for "open for 12m". */
export function since(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
