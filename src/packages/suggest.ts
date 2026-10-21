// suggest.ts — which behaviour packages fit a house, and with which entities. Pure:
// the packages' roles (teobeanie.json), the house's entities (domain, device class,
// area) and the instances it already runs go in; suggestions come out, each with the
// instance's params pre-bound, what is missing and a one-line reason. The MCP tool
// `suggest` feeds it from Home Assistant's registries.
//
// How a heuristic is matched:
// - A role fits an entity by domain, and by device class when the role names some.
//   Disabled, hidden and config/diagnostic entities never fit.
// - Entities an instance of the same heuristic already uses are skipped, and for a
//   role it switches (operate), so are entities any instance owns.
// - Per area, each required role takes the area's candidates: all of them for a role
//   that takes several (at most MAX_MANY), else the first, with the others as
//   alternatives. An area where every required role is bound is a complete suggestion.
// - A heuristic no area completes is suggested for the whole house when the house has
//   a candidate for every required role (a leak guard: the sensors in the rooms, the
//   valve in the utility room). Otherwise its best area is a partial suggestion, with
//   the missing roles and their candidates elsewhere.
// - Optional roles are never bound: their candidates in the area are offered.
// - A role that names no device class matches by domain alone: when it binds an entity
//   of a domain that can be anything (a switch can be a lamp or a pump), it is listed
//   under `check`.
// Ranking: complete before partial, an area before the whole house, roles with device
// classes before domain-only ones, more entities bound first; then one suggestion per
// heuristic before a second one of any.

import type { HeuristicManifest, Manifest, Role } from "./manifest.js";

/** At most this many entities are bound to one role. */
export const MAX_MANY = 10;
/** At most this many candidates are listed for an alternative, an optional role or one missing. */
const MAX_LISTED = 5;

export interface SuggestEntity {
  id: string;
  /** Area name: the entity's own, else its device's. */
  area?: string;
  device_class?: string;
  disabled?: boolean;
  hidden?: boolean;
  /** A config or diagnostic entity (entity_category). */
  category?: boolean;
}

export interface SuggestPackage {
  name: string;
  /** In the config folder; false: a starter package not installed there. */
  installed: boolean;
  manifest: Pick<Manifest, "name" | "title" | "pattern" | "heuristics">;
}

export interface SuggestInstance {
  heuristic: string;
  /** Every entity it watches, reads or owns. */
  entities: string[];
  /** The entities it switches. */
  owns: string[];
}

export interface Suggestion {
  package: string;
  heuristic: string;
  title: string;
  pattern?: string;
  installed: boolean;
  /** The area, or null: across the house (or the entities without an area). */
  area: string | null;
  complete: boolean;
  /** An instance for heuristics.json, in shadow, its entity params bound. */
  instance: { heuristic: string; id: string; mode: "shadow"; params: Record<string, unknown> };
  /** Role path → the entities bound to it. */
  bindings: Record<string, string[]>;
  /** The bound entities it would switch: they need "operate" in the scope. */
  operates: string[];
  /** Required roles with no candidate in the area, and candidates elsewhere. */
  missing?: Array<{ role: string; wants: string; elsewhere: string[] }>;
  /** Other candidates for a role that takes one entity. */
  alternatives?: Record<string, string[]>;
  /** Optional roles' candidates in the area, not bound. */
  optional?: Record<string, string[]>;
  /** Roles matched by domain alone: check each entity by its name. */
  check?: string[];
  reason: string;
}

/** Domains whose entities can be anything: bound without a device class, they need a look at the name. */
const GENERIC = new Set(["switch", "input_boolean", "input_number", "input_select", "select", "sensor", "binary_sensor", "number", "button"]);

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const domainOf = (id: string): string => id.slice(0, id.indexOf("."));

/** Whether an entity can fill a role: domain, and device class when the role names some. */
export function fits(role: Pick<Role, "domain" | "device_class">, e: SuggestEntity): boolean {
  if (!list(role.domain).includes(domainOf(e.id))) return false;
  const classes = list(role.device_class);
  return classes.length === 0 || (e.device_class !== undefined && classes.includes(e.device_class));
}

/** What a role wants, for people: "binary_sensor (motion|occupancy)". */
export const wants = (role: Role): string => `${list(role.domain).join("|")}${role.device_class !== undefined ? ` (${list(role.device_class).join("|")})` : ""}`;

/** "Living room" → "living-room"; an id for heuristics.json. */
export const slug = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "main";

/**
 * Params with entities set at role paths: "a.b" nests, "a[].b" spreads the entities over
 * the innermost list's items (one each) inside one item of each outer list; a role
 * that takes several and has no list in its path is a list of ids.
 */
export function bindParams(bindings: Array<{ path: string; ids: string[]; many: boolean }>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const put = (obj: Record<string, unknown>, segs: string[], ids: string[], many: boolean): void => {
    const [seg, ...rest] = segs;
    if (seg === undefined) return;
    const isList = seg.endsWith("[]");
    const name = isList ? seg.slice(0, -2) : seg;
    if (!isList) {
      if (rest.length === 0) obj[name] = many ? ids : ids[0];
      else put((obj[name] ??= {}) as Record<string, unknown>, rest, ids, many);
      return;
    }
    const items = (obj[name] ??= []) as Array<Record<string, unknown>>;
    if (rest.some((s) => s.endsWith("[]"))) {
      if (items.length === 0) items.push({});
      put(items[0]!, rest, ids, many);
      return;
    }
    ids.forEach((id, i) => {
      if (items[i] === undefined) items[i] = {};
      if (rest.length === 0) return;
      put(items[i]!, rest, [id], false);
    });
  };
  for (const b of bindings) if (b.ids.length > 0) put(params, b.path.split("."), b.ids, b.many);
  return params;
}

interface RoleRef {
  path: string;
  role: Role;
  /** Its candidates in the house, after the skips. */
  candidates: SuggestEntity[];
}

interface Draft {
  pkg: SuggestPackage;
  heuristic: string;
  h: HeuristicManifest;
  area: string | null;
  bound: Map<string, string[]>;
  alternatives: Record<string, string[]>;
  missing: Array<{ role: string; wants: string; elsewhere: string[] }>;
  optional: Record<string, string[]>;
  required: RoleRef[];
  roles: RoleRef[];
}

function finish(d: Draft): Suggestion {
  const complete = d.missing.length === 0;
  const byPath = new Map(d.roles.map((r) => [r.path, r]));
  const bindings = Object.fromEntries([...d.bound].filter(([, ids]) => ids.length > 0));
  const operates = [...new Set([...d.bound].flatMap(([path, ids]) => (byPath.get(path)?.role.operate === true ? ids : [])))];
  const check = d.required
    .filter((r) => r.role.device_class === undefined && (d.bound.get(r.path) ?? []).some((id) => GENERIC.has(domainOf(id))))
    .map((r) => r.path);
  const title = d.h.title ?? d.heuristic;
  const where = d.area ?? "Across the house";
  const parts = d.required
    .filter((r) => (d.bound.get(r.path)?.length ?? 0) > 0)
    .map((r) => `${r.path} (${d.bound.get(r.path)!.length})`);
  const reason =
    `${where}: ${parts.length > 0 ? parts.join(", ") : "nothing bound"} for ${title}` +
    (complete ? "" : `; missing ${d.missing.map((m) => m.role).join(", ")}`) +
    (check.length > 0 ? `; ${check.join(", ")} matched by domain only` : "") +
    (operates.length > 0 ? `; it would switch ${operates.length} ${operates.length === 1 ? "entity" : "entities"}` : "; it only reads");
  const params = bindParams([...d.bound].map(([path, ids]) => ({ path, ids, many: byPath.get(path)?.role.many === true })));
  return {
    package: d.pkg.name,
    heuristic: d.heuristic,
    title,
    ...((d.h.pattern ?? d.pkg.manifest.pattern) !== undefined ? { pattern: d.h.pattern ?? d.pkg.manifest.pattern } : {}),
    installed: d.pkg.installed,
    area: d.area,
    complete,
    instance: { heuristic: d.heuristic, id: d.area === null ? d.heuristic : slug(d.area), mode: "shadow", params },
    bindings,
    operates,
    ...(d.missing.length > 0 ? { missing: d.missing } : {}),
    ...(Object.keys(d.alternatives).length > 0 ? { alternatives: d.alternatives } : {}),
    ...(Object.keys(d.optional).length > 0 ? { optional: d.optional } : {}),
    ...(check.length > 0 ? { check } : {}),
    reason,
  };
}

/** How good a suggestion is, higher first: complete, in an area, device classes, entities bound. */
const score = (s: Suggestion, required: number, specific: number): number[] => [
  s.complete ? 1 : 0,
  s.area !== null ? 1 : 0,
  required === 0 ? 0 : specific / required,
  Object.keys(s.bindings).length,
  Object.values(s.bindings).reduce((n, ids) => n + ids.length, 0),
];

export interface SuggestInput {
  packages: SuggestPackage[];
  entities: SuggestEntity[];
  instances: SuggestInstance[];
  /** Only this area (its name, any case). */
  area?: string;
  /** At most this many suggestions (default 10). */
  limit?: number;
}

export function suggest(input: SuggestInput): Suggestion[] {
  const usable = input.entities.filter((e) => e.disabled !== true && e.hidden !== true && e.category !== true).sort((a, b) => a.id.localeCompare(b.id));
  const owned = new Set(input.instances.flatMap((i) => i.owns));
  const onlyArea = input.area?.trim().toLowerCase();
  const out: Array<{ s: Suggestion; key: number[] }> = [];

  // A package installed in the config folder wins over the starter package of that name.
  const packages = new Map<string, SuggestPackage>();
  for (const p of input.packages) if (!packages.has(p.name) || p.installed) packages.set(p.name, p);

  for (const pkg of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const [heuristic, h] of Object.entries(pkg.manifest.heuristics)) {
      const used = new Set(input.instances.filter((i) => i.heuristic === heuristic).flatMap((i) => i.entities));
      const roles: RoleRef[] = Object.entries(h.roles ?? {}).map(([path, role]) => ({
        path,
        role,
        candidates: usable.filter((e) => fits(role, e) && !used.has(e.id) && !(role.operate === true && owned.has(e.id))),
      }));
      const required = roles.filter((r) => r.role.optional !== true);
      if (required.length === 0) continue;
      const specific = required.filter((r) => r.role.device_class !== undefined).length;

      const draft = (area: string | null, inArea: (e: SuggestEntity) => boolean, anywhere: boolean): Draft => {
        const d: Draft = { pkg, heuristic, h, area, bound: new Map(), alternatives: {}, missing: [], optional: {}, required, roles };
        const taken = new Set<string>();
        for (const r of required) {
          const here = r.candidates.filter((e) => inArea(e) && !taken.has(e.id));
          if (here.length === 0) {
            d.missing.push({ role: r.path, wants: wants(r.role), elsewhere: r.candidates.filter((e) => !taken.has(e.id)).slice(0, MAX_LISTED).map((e) => e.id) });
            continue;
          }
          const ids = r.role.many === true ? here.slice(0, MAX_MANY).map((e) => e.id) : [here[0]!.id];
          if (r.role.many !== true && here.length > 1) d.alternatives[r.path] = here.slice(1, 1 + MAX_LISTED).map((e) => e.id);
          for (const id of ids) taken.add(id);
          d.bound.set(r.path, ids);
        }
        if (!anywhere) {
          for (const r of roles.filter((x) => x.role.optional === true)) {
            const here = r.candidates.filter((e) => inArea(e) && !taken.has(e.id));
            if (here.length > 0) d.optional[r.path] = here.slice(0, MAX_LISTED).map((e) => e.id);
          }
        }
        return d;
      };

      const areas = [...new Set(required.flatMap((r) => r.candidates.map((e) => e.area ?? null)))]
        .filter((a) => onlyArea === undefined || (a !== null && a.toLowerCase() === onlyArea))
        .sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
      const drafts = areas.map((a) => draft(a, (e) => (e.area ?? null) === a, false));
      const complete = drafts.filter((d) => d.missing.length === 0);
      let chosen: Draft[] = complete;
      if (complete.length === 0) {
        const house = onlyArea === undefined ? draft(null, () => true, true) : undefined;
        if (house !== undefined && house.missing.length === 0) chosen = [house];
        else {
          // The area that binds the most required roles, as a partial suggestion.
          const best = [...drafts].sort((x, y) => y.bound.size - x.bound.size)[0];
          chosen = best !== undefined && best.bound.size > 0 ? [best] : [];
        }
      }
      for (const d of chosen) {
        const s = finish(d);
        out.push({ s, key: score(s, required.length, specific) });
      }
    }
  }

  const cmp = (x: number[], y: number[]): number => {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  };
  out.sort((x, y) => cmp(x.key, y.key));
  // One per heuristic first, in rank order, then the rest.
  const seen = new Map<string, number>();
  const ranked = out.map((o, i) => {
    const k = `${o.s.package}/${o.s.heuristic}`;
    const nth = seen.get(k) ?? 0;
    seen.set(k, nth + 1);
    return { o, nth, i };
  });
  ranked.sort((a, b) => a.nth - b.nth || a.i - b.i);
  return ranked.slice(0, Math.max(1, input.limit ?? 10)).map((r) => r.o.s);
}
