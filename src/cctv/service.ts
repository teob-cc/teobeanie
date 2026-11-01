// service.ts — the CCTV tab's source: Frigate's HTTP API, read-only. The add-on finds
// Frigate itself (frigate_url, else the Frigate add-on's hostname on the Supervisor's
// network, else a standalone container named frigate) on Frigate's internal port, which
// takes no login; the panel never talks to Frigate directly: its pictures and clips come
// through the routes in index.ts, limited to the cameras Frigate's config has.

import type { CctvCamera, CctvEpisode, CctvView } from "./view.js";

/**
 * Where Frigate may answer, in order: the Frigate add-on's hostnames (its repository's
 * slug prefix is the same in every house; full access and beta variants), then a
 * container named frigate (Home Assistant Container / docker compose).
 */
export const FRIGATE_CANDIDATES = [
  "http://ccab4aaf-frigate:5000",
  "http://ccab4aaf-frigate-fa:5000",
  "http://ccab4aaf-frigate-beta:5000",
  "http://ccab4aaf-frigate-fa-beta:5000",
  "http://frigate:5000",
];

const PROBE_MS = 2_500;
const RETRY_MS = 5 * 60_000;
const CONFIG_MS = 60_000;
const PAGE = 60;

/** Frigate's review item, the fields read. */
interface FrigateReview {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: string;
  has_been_reviewed?: boolean;
  data?: { objects?: string[]; sub_labels?: string[]; zones?: string[] };
}

export interface CctvService {
  /** The cameras and a page of episodes, newest first; before: ms epoch, for the next page; camera: one camera's. */
  view(q?: { before?: number; camera?: string; limit?: number }): Promise<CctvView>;
  /** A camera's latest frame (JPEG), h pixels high. */
  latest(camera: string, h: number): Promise<Response>;
  /** An episode's thumbnail (WebP). */
  thumbnail(camera: string, id: string): Promise<Response>;
  /** The recording from start to end (seconds epoch) as MP4; range passed through for seeking. */
  clip(camera: string, startS: number, endS: number, range?: string): Promise<Response>;
}

export interface CctvDeps {
  /** frigate_url: tried alone when set. */
  url?: string;
  candidates?: string[];
  fetch?: typeof fetch;
  now?: () => number;
}

/** A review id as Frigate makes them: "<epoch seconds>-<random>". */
export const REVIEW_ID = /^\d+(\.\d+)?-[a-z0-9]+$/;

export function createCctvService(deps: CctvDeps = {}): CctvService {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const candidates = deps.url !== undefined && deps.url.trim() !== "" ? [deps.url.trim().replace(/\/+$/, "")] : (deps.candidates ?? FRIGATE_CANDIDATES);
  let base: { url: string; version: string } | null = null;
  let lastProbe = -Infinity;
  let lastReason = "Frigate not found";
  let cameras: { at: number; list: CctvCamera[] } | null = null;

  const get = (url: string, init?: RequestInit, ms = 10_000): Promise<Response> => f(url, { ...init, signal: AbortSignal.timeout(ms) });

  async function find(): Promise<{ url: string; version: string } | null> {
    if (base !== null) return base;
    if (now() - lastProbe < RETRY_MS) return null;
    lastProbe = now();
    const found = await Promise.all(
      candidates.map(async (url) => {
        try {
          const r = await get(`${url}/api/version`, undefined, PROBE_MS);
          return r.ok ? { url, version: (await r.text()).trim() } : null;
        } catch {
          return null;
        }
      }),
    );
    base = found.find((x) => x !== null) ?? null;
    lastReason = base === null ? `Frigate not found (tried ${candidates.join(", ")})` : "";
    return base;
  }

  async function cameraList(url: string): Promise<CctvCamera[]> {
    if (cameras !== null && now() - cameras.at < CONFIG_MS) return cameras.list;
    const r = await get(`${url}/api/config`);
    if (!r.ok) throw new Error(`Frigate config: HTTP ${r.status}`);
    const cfg = (await r.json()) as { cameras?: Record<string, { enabled?: boolean }> };
    const list = Object.entries(cfg.cameras ?? {})
      .filter(([, c]) => c.enabled !== false)
      .map(([name]) => ({ name }));
    cameras = { at: now(), list };
    return list;
  }

  /** Frigate's answer, or why there is none (a 404 for a camera it does not have). */
  async function pass(camera: string, path: string, init?: RequestInit): Promise<Response> {
    const b = await find();
    if (b === null) return new Response(lastReason, { status: 503 });
    const list = await cameraList(b.url).catch(() => [] as CctvCamera[]);
    if (!list.some((c) => c.name === camera)) return new Response(`no camera ${camera}`, { status: 404 });
    let r: Response;
    try {
      r = await get(`${b.url}${path}`, init, 60_000);
    } catch (err) {
      base = null; // found again on the next request (it may have moved or restarted)
      lastProbe = -Infinity;
      return new Response(`Frigate: ${String(err)}`, { status: 502 });
    }
    const headers = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const v = r.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    headers.set("cache-control", path.includes("latest.jpg") ? "no-store" : "private, max-age=300");
    return new Response(r.body, { status: r.status, headers });
  }

  return {
    async view(q = {}) {
      const b = await find();
      if (b === null) return { available: false, reason: lastReason };
      try {
        const list = await cameraList(b.url);
        const limit = Math.min(Math.max(1, q.limit ?? PAGE), 200);
        const params = new URLSearchParams({ limit: String(limit + 1) });
        if (q.camera !== undefined && list.some((c) => c.name === q.camera)) params.set("cameras", q.camera);
        if (q.before !== undefined) params.set("before", String(q.before / 1000));
        const r = await get(`${b.url}/api/review?${params}`);
        if (!r.ok) throw new Error(`Frigate review: HTTP ${r.status}`);
        const items = (await r.json()) as FrigateReview[];
        const episodes = items.slice(0, limit).map(toEpisode);
        return { available: true, version: b.version, cameras: list, episodes, more: items.length > limit };
      } catch (err) {
        base = null;
        lastProbe = -Infinity;
        return { available: false, reason: `Frigate: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    latest: (camera, h) => pass(camera, `/api/${encodeURIComponent(camera)}/latest.jpg?h=${Math.round(Math.min(Math.max(h, 90), 1440))}`),
    thumbnail: (camera, id) =>
      REVIEW_ID.test(id)
        ? pass(camera, `/clips/review/thumb-${encodeURIComponent(camera)}-${id}.webp`)
        : Promise.resolve(new Response("bad id", { status: 400 })),
    clip: (camera, startS, endS, range) =>
      Number.isFinite(startS) && Number.isFinite(endS) && endS > startS && endS - startS <= 3600
        ? pass(camera, `/api/${encodeURIComponent(camera)}/start/${startS.toFixed(1)}/end/${endS.toFixed(1)}/clip.mp4`, range !== undefined ? { headers: { range } } : undefined)
        : Promise.resolve(new Response("bad span", { status: 400 })),
  };
}

function toEpisode(r: FrigateReview): CctvEpisode {
  const subs = r.data?.sub_labels ?? [];
  return {
    id: r.id,
    camera: r.camera,
    start: Math.round(r.start_time * 1000),
    end: r.end_time === null ? null : Math.round(r.end_time * 1000),
    severity: r.severity === "alert" ? "alert" : "detection",
    labels: [...new Set([...(r.data?.objects ?? []), ...subs])],
    zones: r.data?.zones ?? [],
    reviewed: r.has_been_reviewed === true,
  };
}
