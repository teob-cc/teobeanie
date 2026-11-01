// The CCTV tab's source: Frigate found by itself, its review items as episodes, and the
// pictures and clips passed through only for cameras its config has.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createCctvService } from "../src/cctv/service.js";
import { mountCctv } from "../src/cctv/index.js";

const FRIGATE = "http://ccab4aaf-frigate:5000";

/** A Frigate that answers at one base; every request is logged. */
function fakeFrigate(at = FRIGATE) {
  const seen: Array<{ url: string; range?: string }> = [];
  const review = [
    { id: "993530875.3-yrd001", camera: "yard", start_time: 1793530875.3, end_time: null, severity: "alert", has_been_reviewed: false, data: { objects: ["movement: outside"], sub_labels: [], zones: [] } },
    { id: "1793523955.5-dor001", camera: "door", start_time: 1793523955.5, end_time: 1793523995.2, severity: "alert", has_been_reviewed: true, data: { objects: ["person"], sub_labels: [], zones: ["path"] } },
    { id: "1793520000.1-abc123", camera: "door", start_time: 1793520000.1, end_time: 1793520010.1, severity: "detection", data: { objects: ["cat"] } },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const range = new Headers(init?.headers).get("range") ?? undefined;
    seen.push({ url, ...(range !== undefined ? { range } : {}) });
    if (!url.startsWith(at)) throw new TypeError("fetch failed: ENOTFOUND");
    const path = url.slice(at.length);
    if (path === "/api/version") return new Response("0.18.2-cfa08c5");
    if (path === "/api/config") return Response.json({ cameras: { door: {}, yard: {}, attic: { enabled: false } } });
    if (path.startsWith("/api/review?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const cam = q.get("cameras");
      const rows = review.filter((r) => cam === null || r.camera === cam).slice(0, Number(q.get("limit")));
      return Response.json(rows);
    }
    if (path.endsWith("latest.jpg?h=360")) return new Response("JPEG", { headers: { "content-type": "image/jpeg" } });
    if (path.startsWith("/clips/review/")) return new Response("WEBP", { headers: { "content-type": "image/webp" } });
    if (path.endsWith("/clip.mp4"))
      return new Response("MP4", { status: range ? 206 : 200, headers: { "content-type": "video/mp4", "accept-ranges": "bytes", ...(range ? { "content-range": "bytes 0-2/3" } : {}) } });
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("cctv", () => {
  it("finds the Frigate add-on by itself and lists its cameras and episodes, newest first", async () => {
    const { fetch } = fakeFrigate();
    const v = await createCctvService({ fetch }).view();
    expect(v.available).toBe(true);
    if (!v.available) return;
    expect(v.version).toBe("0.18.2-cfa08c5");
    expect(v.cameras.map((c) => c.name)).toEqual(["door", "yard"]);
    expect(v.episodes[0]).toEqual({ id: "993530875.3-yrd001", camera: "yard", start: 1793530875300, end: null, severity: "alert", labels: ["movement: outside"], zones: [], reviewed: false });
    expect(v.episodes[2]).toMatchObject({ severity: "detection", labels: ["cat"], reviewed: false });
    expect(v.more).toBe(false);
  });

  it("pages with before, and one camera's episodes", async () => {
    const { fetch, seen } = fakeFrigate();
    const s = createCctvService({ fetch });
    const v = await s.view({ camera: "door", limit: 1, before: 1793530000000 });
    expect(v.available && v.episodes.map((e) => e.id)).toEqual(["1793523955.5-dor001"]);
    expect(v.available && v.more).toBe(true);
    expect(seen.at(-1)?.url).toBe(`${FRIGATE}/api/review?limit=2&cameras=door&before=1793530000`);
  });

  it("frigate_url is the only place tried when set", async () => {
    const { fetch, seen } = fakeFrigate("http://nvr.lan:5000");
    const v = await createCctvService({ fetch, url: "http://nvr.lan:5000/" }).view();
    expect(v.available).toBe(true);
    expect(seen.every((r) => r.url.startsWith("http://nvr.lan:5000"))).toBe(true);
  });

  it("without Frigate the tab stays hidden, and it is not looked for again on every request", async () => {
    const { fetch, seen } = fakeFrigate("http://elsewhere:5000");
    let t = 0;
    const s = createCctvService({ fetch, now: () => t });
    const v = await s.view();
    expect(v).toMatchObject({ available: false });
    const probes = seen.length;
    t += 60_000;
    await s.view();
    expect(seen.length).toBe(probes);
    t += 5 * 60_000;
    await s.view();
    expect(seen.length).toBeGreaterThan(probes);
  });

  it("routes: the latest frame, a thumbnail and a clip with its range, for cameras Frigate has only", async () => {
    const { fetch, seen } = fakeFrigate();
    const app = new Hono();
    mountCctv(app, createCctvService({ fetch }));
    const jpg = await app.request("/api/cctv/door/latest.jpg?h=360");
    expect(jpg.status).toBe(200);
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
    expect(jpg.headers.get("cache-control")).toBe("no-store");
    const thumb = await app.request("/api/cctv/yard/thumb/993530875.3-yrd001");
    expect(await thumb.text()).toBe("WEBP");
    expect(seen.at(-1)?.url).toBe(`${FRIGATE}/clips/review/thumb-yard-993530875.3-yrd001.webp`);
    const clip = await app.request("/api/cctv/door/clip/1793523950.5/1793524000.2", { headers: { range: "bytes=0-" } });
    expect(clip.status).toBe(206);
    expect(clip.headers.get("content-range")).toBe("bytes 0-2/3");
    expect(seen.at(-1)).toEqual({ url: `${FRIGATE}/api/door/start/1793523950.5/end/1793524000.2/clip.mp4`, range: "bytes=0-" });

    expect((await app.request("/api/cctv/attic/latest.jpg")).status).toBe(404);
    expect((await app.request("/api/cctv/door/thumb/..%2F..%2Fconfig")).status).toBe(400);
    expect((await app.request("/api/cctv/door/clip/100/50")).status).toBe(400);
    const v = (await (await app.request("/api/cctv")).json()) as { available: boolean };
    expect(v.available).toBe(true);
  });
});
