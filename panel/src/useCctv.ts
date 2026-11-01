// useCctv.ts — the CCTV tab's data: GET api/cctv on mount, every 20 seconds while the tab
// is in view, and on reconnect; older episodes on demand. A route an older add-on does not
// serve answers 404: the view stays null, the tab hidden.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CctvEpisode, CctvView } from "../../src/cctv/view";

const REFRESH_MS = 20_000;

type Available = Extract<CctvView, { available: true }>;

export interface CctvData {
  /** The last view that loaded, with the older pages appended; kept when a refresh fails. */
  view: CctvView | null;
  error: string | null;
  loadedAt: number | null;
  /** Older episodes are loading. */
  loadingMore: boolean;
  reload: () => void;
  more: () => void;
}

/** The newest page merged over what is shown: new ones in front, updated ones replaced, older pages kept. */
function merge(prev: Available | null, next: Available): Available {
  if (prev === null) return next;
  const fresh = new Map(next.episodes.map((e) => [e.id, e]));
  const oldest = next.episodes.at(-1)?.start ?? Infinity;
  const kept = prev.episodes.filter((e) => !fresh.has(e.id) && e.start < oldest);
  return { ...next, episodes: [...next.episodes, ...kept], more: kept.length > 0 ? prev.more : next.more };
}

export function usePageShown(): boolean {
  const [shown, setShown] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return shown;
}

export function useCctv(visible: boolean, connected: boolean, camera: string | null): CctvData {
  const [view, setView] = useState<CctvView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const cam = useRef(camera);

  const reload = useCallback(() => {
    const asked = camera;
    api
      .cctv(asked !== null ? { camera: asked } : {})
      .then((v) => {
        if (cam.current !== asked) return;
        setView((prev) => (v.available && prev?.available ? merge(prev, v) : v));
        setError(null);
        setLoadedAt(Date.now());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [camera]);

  // Another camera: start over from its newest page.
  useEffect(() => {
    cam.current = camera;
    setView((v) => (v?.available ? { ...v, episodes: [], more: false } : v));
    reload();
  }, [camera, reload]);
  useEffect(() => {
    if (connected) reload();
  }, [connected, reload]);

  const pageShown = usePageShown();
  useEffect(() => {
    if (!visible || !pageShown) return;
    reload();
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, [visible, pageShown, reload]);

  const more = useCallback(() => {
    if (view === null || !view.available || !view.more || loadingMore) return;
    const last: CctvEpisode | undefined = view.episodes.at(-1);
    if (last === undefined) return;
    setLoadingMore(true);
    const asked = camera;
    api
      .cctv({ before: last.start, ...(asked !== null ? { camera: asked } : {}) })
      .then((v) => {
        if (cam.current !== asked || !v.available) return;
        setView((prev) => {
          if (prev === null || !prev.available) return prev;
          const have = new Set(prev.episodes.map((e) => e.id));
          return { ...prev, episodes: [...prev.episodes, ...v.episodes.filter((e) => !have.has(e.id))], more: v.more };
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false));
  }, [view, loadingMore, camera]);

  return { view, error, loadedAt, loadingMore, reload, more };
}
