// expect.ts — the matchers a package's specs use, with vitest's meaning, for the places
// that run specs outside vitest: the Studio's test worker in the browser and the
// test_run MCP tool in the add-on. vitest itself runs the same specs in the
// repository (test/teobeanie-test.ts). A spec that passes here passes there.
//
// Equality is vitest's toEqual: recursive, undefined properties ignored, arrays,
// Dates, RegExps, Maps and Sets by content, and the asymmetric matchers
// (expect.any, expect.anything, expect.arrayContaining, expect.objectContaining,
// expect.stringContaining, expect.stringMatching) anywhere in the expected value.

/** An expected value that matches by a rule instead of by equality. */
export interface Asymmetric {
  readonly asymmetric: true;
  matches(actual: unknown): boolean;
  toString(): string;
}

const isAsymmetric = (v: unknown): v is Asymmetric => typeof v === "object" && v !== null && (v as { asymmetric?: unknown }).asymmetric === true;

export function show(v: unknown): string {
  if (isAsymmetric(v)) return v.toString();
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "symbol") return v.description ?? "symbol";
  if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
  if (typeof v === "bigint") return `${v}n`;
  if (v === undefined) return "undefined";
  if (v instanceof RegExp) return String(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Map) return `Map ${show([...v.entries()])}`;
  if (v instanceof Set) return `Set ${show([...v])}`;
  try {
    const text = JSON.stringify(v, (_k, x: unknown) => (isAsymmetric(x) ? x.toString() : x === undefined ? "undefined" : x));
    return text === undefined ? String(v) : text.length > 400 ? `${text.slice(0, 399)}…` : text;
  } catch {
    return String(v);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** vitest's toEqual (strict: toStrictEqual, which also compares undefined properties and classes). */
export function equals(a: unknown, b: unknown, strict = false): boolean {
  if (isAsymmetric(b)) return b.matches(a);
  if (isAsymmetric(a)) return a.matches(b);
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    return [...a].every(([k, v]) => b.has(k) && equals(v, b.get(k), strict));
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    return [...a].every((x) => [...b].some((y) => equals(x, y, strict)));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => strict || o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length) return false;
  return kb.every((k) => (strict ? Object.prototype.hasOwnProperty.call(a, k) : true) && equals(a[k], b[k], strict));
}

/** vitest's toMatchObject: every property the expected object names matches, recursively; arrays item by item. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  if (isObject(expected) && !(expected instanceof Date) && !(expected instanceof RegExp) && !(expected instanceof Map) && !(expected instanceof Set)) {
    return isObject(actual) && Object.keys(expected).every((k) => k in actual && matchesObject(actual[k], expected[k]));
  }
  return equals(actual, expected);
}

const asymmetric = (name: string, matches: (actual: unknown) => boolean): Asymmetric => ({ asymmetric: true, matches, toString: () => name });

const typeOf = (ctor: unknown): ((v: unknown) => boolean) => {
  if (ctor === String) return (v) => typeof v === "string" || v instanceof String;
  if (ctor === Number) return (v) => typeof v === "number" || v instanceof Number;
  if (ctor === Boolean) return (v) => typeof v === "boolean" || v instanceof Boolean;
  if (ctor === Function) return (v) => typeof v === "function";
  if (ctor === Object) return (v) => typeof v === "object" && v !== null;
  if (ctor === Array) return Array.isArray;
  return (v) => typeof ctor === "function" && v instanceof (ctor as new (...args: never[]) => unknown);
};

/** expect.any, expect.anything and the containing matchers. */
export const asymmetricMatchers = {
  any: (ctor: unknown) => asymmetric(`Any<${(ctor as { name?: string })?.name ?? "?"}>`, typeOf(ctor)),
  anything: () => asymmetric("Anything", (v) => v !== null && v !== undefined),
  arrayContaining: (items: unknown[]) =>
    asymmetric(`ArrayContaining ${show(items)}`, (v) => Array.isArray(v) && items.every((i) => v.some((x) => equals(x, i)))),
  objectContaining: (fields: Record<string, unknown>) =>
    asymmetric(`ObjectContaining ${show(fields)}`, (v) => isObject(v) && Object.keys(fields).every((k) => k in v && equals(v[k], fields[k]))),
  stringContaining: (s: string) => asymmetric(`StringContaining ${show(s)}`, (v) => typeof v === "string" && v.includes(s)),
  stringMatching: (re: string | RegExp) => asymmetric(`StringMatching ${String(re)}`, (v) => typeof v === "string" && (typeof re === "string" ? new RegExp(re) : re).test(v)),
};

export interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toMatchObject(expected: object): void;
  toHaveLength(n: number): void;
  toContain(item: unknown): void;
  toContainEqual(item: unknown): void;
  toMatch(pattern: RegExp | string): void;
  toHaveProperty(path: string | string[], value?: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNaN(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeCloseTo(n: number, digits?: number): void;
  toBeInstanceOf(ctor: unknown): void;
  toBeTypeOf(type: string): void;
  toSatisfy(predicate: (v: unknown) => boolean): void;
  toThrow(pattern?: RegExp | string): void;
  toThrowError(pattern?: RegExp | string): void;
  readonly not: Matchers;
}

function property(actual: unknown, path: string | string[]): { found: boolean; value?: unknown } {
  const parts = Array.isArray(path) ? path : path.split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== "");
  let at: unknown = actual;
  for (const p of parts) {
    if (!isObject(at) && typeof at !== "string") return { found: false };
    if (!(p in Object(at))) return { found: false };
    at = (at as Record<string, unknown>)[p];
  }
  return { found: true, value: at };
}

function matchers(actual: unknown, negate: boolean, message?: string): Matchers {
  const check = (pass: boolean, what: string): void => {
    if (pass === negate) throw new Error(`${message !== undefined ? `${message}: ` : ""}expected ${show(actual)} ${negate ? "not " : ""}${what}`);
  };
  const num = (what: string, n: number, ok: (a: number) => boolean): void => {
    if (typeof actual !== "number" && typeof actual !== "bigint") throw new Error(`expected a number to be ${what} ${n}, got ${show(actual)}`);
    check(ok(Number(actual)), `to be ${what} ${n}`);
  };
  const toThrow = (re?: RegExp | string): void => {
    let threw: unknown;
    let did = false;
    try {
      (actual as () => unknown)();
    } catch (e) {
      did = true;
      threw = e;
    }
    const msg = threw instanceof Error ? threw.message : String(threw);
    const ok = did && (re === undefined || (typeof re === "string" ? msg.includes(re) : re.test(msg)));
    if (ok === negate) throw new Error(negate ? `expected no throw, got "${msg}"` : `expected a throw${re !== undefined ? ` matching ${String(re)}` : ""}, ${did ? `got "${msg}"` : "got none"}`);
  };
  return {
    toBe: (v) => check(Object.is(actual, v), `to be ${show(v)}`),
    toEqual: (v) => check(equals(actual, v), `to equal ${show(v)}`),
    toStrictEqual: (v) => check(equals(actual, v, true), `to strictly equal ${show(v)}`),
    toMatchObject: (v) => check(matchesObject(actual, v), `to match object ${show(v)}`),
    toHaveLength: (n) => check((actual as { length?: number } | null)?.length === n, `to have length ${n}`),
    toContain: (v) =>
      check(
        typeof actual === "string" ? actual.includes(String(v)) : Array.isArray(actual) ? actual.includes(v) : actual instanceof Set ? actual.has(v) : false,
        `to contain ${show(v)}`,
      ),
    toContainEqual: (v) => check(Array.isArray(actual) && actual.some((x) => equals(x, v)), `to contain equal ${show(v)}`),
    toMatch: (re) => check(typeof actual === "string" && (typeof re === "string" ? actual.includes(re) : re.test(actual)), `to match ${String(re)}`),
    toHaveProperty: (path, ...value) => {
      const p = property(actual, path);
      check(p.found && (value.length === 0 || equals(p.value, value[0])), `to have property ${show(path)}${value.length > 0 ? ` = ${show(value[0])}` : ""}`);
    },
    toBeTruthy: () => check(Boolean(actual), "to be truthy"),
    toBeFalsy: () => check(!actual, "to be falsy"),
    toBeNull: () => check(actual === null, "to be null"),
    toBeUndefined: () => check(actual === undefined, "to be undefined"),
    toBeDefined: () => check(actual !== undefined, "to be defined"),
    toBeNaN: () => check(Number.isNaN(actual), "to be NaN"),
    toBeGreaterThan: (n) => num("greater than", n, (a) => a > n),
    toBeGreaterThanOrEqual: (n) => num("greater than or equal to", n, (a) => a >= n),
    toBeLessThan: (n) => num("less than", n, (a) => a < n),
    toBeLessThanOrEqual: (n) => num("less than or equal to", n, (a) => a <= n),
    toBeCloseTo: (n, digits = 2) => num("close to", n, (a) => Math.abs(a - n) < 10 ** -digits / 2),
    toBeInstanceOf: (ctor) => check(typeOf(ctor)(actual), `to be an instance of ${(ctor as { name?: string })?.name ?? "?"}`),
    toBeTypeOf: (type) => check(typeof actual === type, `to be of type ${type}`),
    toSatisfy: (predicate) => check(predicate(actual), "to satisfy the predicate"),
    toThrow,
    toThrowError: toThrow,
    get not() {
      return matchers(actual, !negate, message);
    },
  };
}

/** expect(actual, message?), with expect.any and the other asymmetric matchers. */
export const expect: ((actual: unknown, message?: string) => Matchers) & typeof asymmetricMatchers = Object.assign(
  (actual: unknown, message?: string) => matchers(actual, false, message),
  asymmetricMatchers,
);
