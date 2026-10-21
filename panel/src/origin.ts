// origin.ts — who made an observed HA call, as the call_service audit records it in
// `by` (src/attribution.ts): "teob" (Teobeanie's own calls; the value predates the
// name and stays as journaled), person:<name>, system:<name>, user:<id prefix>, or
// device. Rows journaled before attribution have no `by`; they read as "nodered". A
// state change's cause (api/timeline) may also be "automation" or "unknown"; a working-set
// edit's (src/working-set.ts) "file" (the file watch), "cli" or "local" (standalone).

export const LEGACY_ORIGIN = "nodered";

export type OriginKind = "teob" | "person" | "system" | "user" | "device" | "automation" | "unknown" | "file" | "cli" | "local" | "legacy";

/** The `by` of a call_service audit payload. */
export function originOf(payload: unknown): string {
  const by = (payload as { by?: unknown } | null)?.by;
  return typeof by === "string" ? by : LEGACY_ORIGIN;
}

export function originKind(by: string): OriginKind {
  if (by === "teob" || by === "device" || by === "automation" || by === "unknown" || by === "file" || by === "cli" || by === "local") return by;
  const prefix = by.slice(0, by.indexOf(":"));
  return prefix === "person" || prefix === "system" || prefix === "user" ? prefix : "legacy";
}

/** "Teobeanie", "alex", "Supervisor", "user 01234567", "device", "Node-RED" (old rows). */
export function originLabel(by: string): string {
  const kind = originKind(by);
  if (kind === "teob") return "Teobeanie";
  if (kind === "legacy") return "Node-RED";
  if (kind === "user") return `user ${by.slice(5)}`;
  if (kind === "person" || kind === "system") return by.slice(by.indexOf(":") + 1);
  return by;
}

const TITLES: Record<OriginKind, string> = {
  teob: "Teobeanie made this call",
  person: "a person (Home Assistant user)",
  system: "a system user: other add-ons call Home Assistant as the Supervisor",
  user: "a Home Assistant user whose name Teobeanie could not read",
  device: "no user: the device, an integration or an automation",
  automation: "an automation: a parent context and no call Teobeanie saw",
  unknown: "Home Assistant gave no context",
  file: "a file in the config folder was saved (the file watch)",
  cli: "the command line",
  local: "the add-on's own page, outside Home Assistant (standalone)",
  legacy: "journaled before calls were attributed, when Node-RED made most of them",
};

/** A chip naming who made a call. */
export function originChip(by: string): { className: string; label: string; title: string } {
  const kind = originKind(by);
  return { className: `chip chip-origin chip-origin-${kind}`, label: originLabel(by), title: TITLES[kind] };
}
