import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAllowlist } from "../src/allowlist.js";
import { loadHouseConfig } from "../src/tiles.js";

const noLog = (): void => {};
const root = join(import.meta.dirname, "..");

let dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "teobeanie-allowlist-"));
  dirs.push(dir);
  return dir;
}
function writeAllowlist(dir: string, content: string): void {
  writeFileSync(join(dir, "allowlist.json"), content);
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("loadAllowlist", () => {
  it("parses a valid file into RouteSpecs", () => {
    const dir = dataDir();
    writeAllowlist(
      dir,
      JSON.stringify({
        policyVersion: 3,
        entities: [
          { id: "binary_sensor.front_door_contact", debounce: "on-change" },
          { id: "sensor.outside_temp", debounce: "deadband", params: { deadband: 0.2 } },
          { id: "sensor.power", debounce: "throttle-ema", params: { emaHalflifeMs: 5000, emitIntervalMs: 5000 } },
          { id: "sensor.cloud_thing", debounce: "slow-context" },
        ],
      }),
    );
    const result = loadAllowlist(dir, noLog);
    expect(result.policyVersion).toBe(3);
    expect(result.routes).toHaveLength(4);
    expect(result.routes[0]).toEqual({ entityId: "binary_sensor.front_door_contact", debounce: "on-change" });
    expect(result.routes[1]).toEqual({
      entityId: "sensor.outside_temp",
      debounce: "deadband",
      params: { deadband: 0.2 },
    });
    expect(result.routes[2]?.params).toEqual({ emaHalflifeMs: 5000, emitIntervalMs: 5000 });
    expect(result.routes[3]).toEqual({ entityId: "sensor.cloud_thing", debounce: "slow-context" });
  });

  it("defaults policyVersion to 1 when absent", () => {
    const dir = dataDir();
    writeAllowlist(dir, JSON.stringify({ entities: [{ id: "light.a", debounce: "on-change" }] }));
    expect(loadAllowlist(dir, noLog).policyVersion).toBe(1);
  });

  it("throws on unparseable JSON", () => {
    const dir = dataDir();
    writeAllowlist(dir, "{ nope");
    expect(() => loadAllowlist(dir, noLog)).toThrow(/unparseable JSON/);
  });

  it("throws on missing entities array", () => {
    const dir = dataDir();
    writeAllowlist(dir, JSON.stringify({ policyVersion: 1 }));
    expect(() => loadAllowlist(dir, noLog)).toThrow(/"entities" array/);
  });

  it("throws on duplicate id, naming the offender", () => {
    const dir = dataDir();
    writeAllowlist(
      dir,
      JSON.stringify({
        entities: [
          { id: "light.dupe", debounce: "on-change" },
          { id: "light.dupe", debounce: "on-change" },
        ],
      }),
    );
    expect(() => loadAllowlist(dir, noLog)).toThrow(/duplicate entity id "light\.dupe"/);
  });

  it("throws on unknown debounce class, naming the offender", () => {
    const dir = dataDir();
    writeAllowlist(dir, JSON.stringify({ entities: [{ id: "sensor.x", debounce: "sometimes" }] }));
    expect(() => loadAllowlist(dir, noLog)).toThrow(/"sensor\.x" has unknown debounce class "sometimes"/);
  });

  it("throws on a deadband route without params.deadband, naming the offender", () => {
    const dir = dataDir();
    writeAllowlist(dir, JSON.stringify({ entities: [{ id: "sensor.temp", debounce: "deadband" }] }));
    expect(() => loadAllowlist(dir, noLog)).toThrow(/deadband entity "sensor\.temp" requires params\.deadband/);
  });

  it("falls back to examples/starter/allowlist.json when DATA_DIR has no allowlist.json, and warns", () => {
    const dir = dataDir(); // empty — no allowlist.json
    const logged: Array<[string, string]> = [];
    const result = loadAllowlist(dir, (l, m) => logged.push([l, m]));
    expect(result.routes.length).toBeGreaterThanOrEqual(5);
    expect(logged.some(([l, m]) => l === "warning" && m.includes("examples/starter/allowlist.json"))).toBe(true);
    // Generic placeholder ids; all four debounce classes represented.
    const classes = new Set(result.routes.map((r) => r.debounce));
    expect(classes).toEqual(new Set(["on-change", "deadband", "throttle-ema", "slow-context"]));
  });

  it("example allowlist routes every starter tile entity — live tile SSE updates depend on it", () => {
    const dir = dataDir(); // empty — fallback to examples/starter/allowlist.json
    const routed = new Set(loadAllowlist(dir, noLog).routes.map((r) => r.entityId));
    for (const tile of loadHouseConfig(join(root, "examples", "starter"), noLog).tiles) {
      expect(routed, `tile entity ${tile.entityId} must be in examples/starter/allowlist.json`).toContain(
        tile.entityId,
      );
    }
  });
});
