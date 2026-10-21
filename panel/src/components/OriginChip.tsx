import { originChip } from "../origin";

/** Who made an audited call: Teobeanie, a person, a system user, the device (Node-RED on old rows). */
export function OriginChip({ by }: { by: string }) {
  const c = originChip(by);
  return (
    <span className={c.className} title={c.title}>
      {c.label}
    </span>
  );
}
