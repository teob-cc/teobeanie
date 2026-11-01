// index.ts — the CCTV routes: GET api/cctv (the view), and the pictures and clips the
// panel shows, passed through from Frigate (service.ts). Read-only.

import type { Hono } from "hono";
import type { CctvService } from "./service.js";

export function mountCctv(app: Hono, cctv: CctvService): void {
  app.get("/api/cctv", async (c) => {
    const before = Number(c.req.query("before"));
    const camera = c.req.query("camera");
    return c.json(await cctv.view({ ...(Number.isFinite(before) && before > 0 ? { before } : {}), ...(camera ? { camera } : {}) }));
  });
  app.get("/api/cctv/:camera/latest.jpg", (c) => cctv.latest(c.req.param("camera"), Number(c.req.query("h") ?? 360) || 360));
  app.get("/api/cctv/:camera/thumb/:id", (c) => cctv.thumbnail(c.req.param("camera"), c.req.param("id")));
  app.get("/api/cctv/:camera/clip/:start/:end", (c) =>
    cctv.clip(c.req.param("camera"), Number(c.req.param("start")), Number(c.req.param("end")), c.req.header("range")),
  );
}
