// POST api/command: a named command from the panel, through ingress only, as the
// session's HA user; what it reached, or why not.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CommandSource } from "../src/kernel/heuristic.js";
import { commandUser, mountCommand } from "../src/command.js";

const INGRESS = "172.30.32.2";

const setup = (answering: Record<string, string[]> = { pet: ["whereabouts/pet"] }) => {
  const got: Array<{ name: string; args: string[]; from: CommandSource }> = [];
  const app = new Hono();
  mountCommand(app, {
    mode: "addon",
    command: (name, args, from) => {
      got.push({ name, args, from });
      return answering[name] ?? [];
    },
  });
  const post = (body: unknown, opts: { ip?: string; headers?: Record<string, string> } = {}) =>
    app.request(
      "/api/command",
      { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...opts.headers } },
      { incoming: { socket: { remoteAddress: opts.ip ?? INGRESS } } },
    );
  return { got, post };
};

describe("api/command", () => {
  it("runs the command as the session's HA user and says which instances it reached", async () => {
    const t = setup();
    const res = await t.post({ name: "pet", args: ["home"] }, { headers: { "x-remote-user-display-name": "Alex" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: ["whereabouts/pet"] });
    expect(t.got).toEqual([{ name: "pet", args: ["home"], from: { channel: "panel", user: "Alex" } }]);
    // No arguments is a command too; no user header: the channel alone.
    expect((await t.post({ name: "Pet" })).status).toBe(200);
    expect(t.got[1]).toEqual({ name: "pet", args: [], from: { channel: "panel" } });
  });

  it("ingress only", async () => {
    const t = setup();
    expect((await t.post({ name: "pet", args: ["home"] }, { ip: "172.30.33.4" })).status).toBe(403);
    expect(t.got).toEqual([]);
  });

  it("400 on a bad body, 404 when nobody answers", async () => {
    const t = setup();
    for (const body of ["not json", {}, { name: "/pet" }, { name: "pet", args: "home" }, { name: "pet", args: [1] }, { name: "pet", args: [""] }]) {
      expect((await t.post(body)).status).toBe(400);
    }
    expect(t.got).toEqual([]);
    const res = await t.post({ name: "shed_open" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NotFound", reason: "no running instance answers /shed_open" });
  });

  it("names the user by name, by id prefix, or not at all", () => {
    const h = (headers: Record<string, string>) => (n: string) => headers[n];
    expect(commandUser(h({ "x-remote-user-name": "alex" }))).toBe("alex");
    expect(commandUser(h({ "x-remote-user-id": "0123456789abcdef" }))).toBe("user 01234567");
    expect(commandUser(h({}))).toBeUndefined();
  });
});
