// Studio file API: sources in the config folder's heuristics/, written only via ingress.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { houseScope } from "../src/allowlist.js";
import { mayWrite, mountStudio } from "../src/studio/files.js";
import { installStarter, loadLibrary } from "../src/packages/library.js";

function setup(mode: "addon" | "standalone" = "addon") {
  const configDir = mkdtempSync(join(tmpdir(), "teobeanie-studio-"));
  mkdirSync(join(configDir, "heuristics"));
  writeFileSync(join(configDir, "heuristics", "hallway-light.ts"), "export default 1;\n");
  writeFileSync(join(configDir, "heuristics", "ha.d.ts"), "export {};\n");
  const app = new Hono();
  const st = (entity_id: string) => ({ entity_id, state: "off", attributes: {}, last_changed: "", last_updated: "" });
  const states = [st("light.hallway"), st("binary_sensor.hallway_motion"), st("camera.garden")];
  const scope = houseScope(["binary_sensor.hallway_motion"], ["light.hallway"]);
  mountStudio(app, { configDir, mode, liveStates: () => states, scope });
  const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
  return { app, configDir, from };
}

describe("studio files", () => {
  it("lists and reads sources, not generated types", async () => {
    const { app } = setup();
    const list = (await (await app.request("/api/studio/files")).json()) as { files: Array<{ name: string }> };
    expect(list.files.map((f) => f.name)).toEqual(["hallway-light.ts"]);
    expect(await (await app.request("/api/studio/files/hallway-light.ts")).text()).toBe("export default 1;\n");
    expect((await app.request("/api/studio/files/ha.d.ts")).status).toBe(404);
    expect((await app.request("/api/studio/files/..%2Fsecrets.ts")).status).toBe(404);
  });

  it("writes only through the ingress gateway, and only kebab-case sources", async () => {
    const { app, configDir, from } = setup();
    const put = (name: string, ip: string) => app.request(`/api/studio/files/${name}`, { method: "PUT", body: "x" }, from(ip));
    expect((await put("porch.ts", "172.30.33.5")).status).toBe(403); // another add-on
    expect((await put("Porch.ts", "172.30.32.2")).status).toBe(400);
    expect((await put("porch.test.ts", "172.30.32.2")).status).toBe(200);
    expect(readFileSync(join(configDir, "heuristics", "porch.test.ts"), "utf8")).toBe("x");
    expect(mayWrite("standalone", "::ffff:127.0.0.1")).toBe(true);
    expect(mayWrite("standalone", "192.168.1.10")).toBe(false);
  });

  it("lists the packages and reads their files, read-only and nothing outside them", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "teobeanie-studio-"));
    installStarter(configDir);
    const { packages } = await loadLibrary(configDir, () => {});
    const app = new Hono();
    mountStudio(app, { configDir, mode: "addon", liveStates: () => [], scope: houseScope([], []), packages: () => packages });
    const list = (await (await app.request("/api/studio/packages")).json()) as { packages: Array<Record<string, unknown>> };
    expect(list.packages.find((p) => p["name"] === "door-watch")).toMatchObject({
      origin: "starter",
      modified: false,
      heuristics: ["door-nag", "sustained-notice"],
      sources: { "door-nag": "door-nag.ts", "sustained-notice": "sustained-notice.ts" },
    });
    expect(await (await app.request("/api/studio/packages/door-watch/door-nag.ts")).text()).toMatch(/id: "door-nag"/);
    expect((await app.request("/api/studio/packages/door-watch/..%2F..%2Fheuristics.json")).status).toBe(404);
    expect((await app.request("/api/studio/packages/nope/door-nag.ts")).status).toBe(404);
    expect((await app.request("/api/studio/packages/door-watch/door-nag.ts", { method: "PUT", body: "x" })).status).toBe(404);
  });

  it("serves the house's types: only its scope, and which entities it may operate", async () => {
    const { app } = setup();
    const t = (await (await app.request("/api/studio/types")).json()) as { house: string; scope: unknown };
    expect(t.house).toContain(`"light.hallway": "on" | "off";`);
    expect(t.house).toContain(`"binary_sensor.hallway_motion": "on" | "off";`);
    expect(t.house).not.toContain("camera.garden");
    expect(t.house).toMatch(/interface TeobOperable \{\n {4}"light.hallway": true;\n {2}\}/);
    expect(t.scope).toEqual({ observed: 2, operated: 1 });
  });
});
