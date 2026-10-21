import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

describe("shadow_mode", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is an emergency switch, off by default in the add-on", () => {
    process.env.SUPERVISOR_TOKEN = "t";
    const c = loadConfig();
    expect(c.mode).toBe("addon");
    expect(c.options.shadow_mode).toBe(false);
  });

  it("is forced on in standalone runs", () => {
    delete process.env.SUPERVISOR_TOKEN;
    process.env.HA_WS_URL = "ws://x/api/websocket";
    process.env.HA_TOKEN = "t";
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "tb-cfg-"));
    const c = loadConfig();
    expect(c.mode).toBe("standalone");
    expect(c.options.shadow_mode).toBe(true);
  });
});
