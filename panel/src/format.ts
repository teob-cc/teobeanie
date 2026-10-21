// format.ts — tiny pure formatting helpers shared by both views.

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dayKey(at: number): string {
  return new Date(at).toDateString();
}

export function fmtDay(at: number): string {
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const yd = new Date(today);
  yd.setDate(today.getDate() - 1);
  if (d.toDateString() === yd.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Relative "updated Xs ago" text. */
export function rel(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compact numeric display: 1,284 / 231 / 21.4 / 3.14 / 0.5 */
export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
