// cards.ts — how an instance's card (HeuristicDef.view, src/kernel/card.ts) reads on
// the House page: its title, a chip for its mode, each value with its unit and how
// long it has held, and its buttons. Pure: components/PackageCard.tsx draws it.

import type { InstanceCard } from "../../src/house/view";
import type { CardButton, CardField } from "../../src/kernel/heuristic";
import { fmtDay, fmtNum, fmtTime } from "./format";
import { since } from "./houseFormat";

export interface CardFieldModel {
  label: string;
  text: string;
  unit?: string;
  /** "for 12m": how long it has held. */
  sub?: string;
  /** The moment it started, in full. */
  subTitle?: string;
  className: string;
}

export interface CardModel {
  key: string;
  title: string;
  mode: { text: string; className: string; title: string };
  fields: CardFieldModel[];
  buttons: Array<Required<Pick<CardButton, "label" | "command" | "args">> & { confirm?: string; disabled: boolean }>;
  error?: string;
}

const TONE: Record<NonNullable<CardField["tone"]>, string> = { ok: "ok-text", warn: "warn-text", bad: "bad-text" };

export function valueText(v: CardField["value"]): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return fmtNum(v);
  return v;
}

export function cardModel(c: InstanceCard, now: number): CardModel {
  const shadow = c.mode === "shadow";
  return {
    key: c.key,
    title: c.card?.title ?? c.key,
    mode: shadow
      ? { text: "shadow", className: "chip chip-off", title: "It decides and journals, but acts on nothing and sends nothing" }
      : { text: "active", className: "chip chip-ok", title: "It acts" },
    fields: (c.card?.fields ?? []).map((f) => ({
      label: f.label,
      text: valueText(f.value),
      ...(f.unit !== undefined ? { unit: f.unit } : {}),
      ...(f.since !== undefined && f.since > 0 ? { sub: `for ${since(now, f.since)}`, subTitle: `since ${fmtDay(f.since)} ${fmtTime(f.since)}` } : {}),
      className: f.tone !== undefined ? `stat-value ${TONE[f.tone]}` : "stat-value",
    })),
    buttons: (c.card?.buttons ?? []).map((b) => ({
      label: b.label,
      command: b.command,
      args: b.args ?? [],
      ...(b.confirm !== undefined ? { confirm: b.confirm } : {}),
      disabled: b.disabled === true,
    })),
    ...(c.error !== undefined ? { error: c.error } : {}),
  };
}
