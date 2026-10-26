// useInfra.ts — the Infra tab's data: GET api/infra on mount, every 15 seconds while the
// tab is in view (the tab shown and the page not in the background), and on reconnect.
// A route an older add-on does not serve answers 404: the view stays null, the tab hidden.

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { InfraView } from "../../src/infra/view";

const REFRESH_MS = 15_000;

export interface InfraData {
  /** The last view that loaded; kept when a refresh fails. */
  view: InfraView | null;
  /** The last refresh's failure, if it failed. */
  error: string | null;
  loadedAt: number | null;
  reload: () => void;
}

export function useInfra(visible: boolean, connected: boolean): InfraData {
  const [view, setView] = useState<InfraView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const reload = useCallback(() => {
    api
      .infra()
      .then((v) => {
        setView(v);
        setError(null);
        setLoadedAt(Date.now());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(reload, [reload]);
  useEffect(() => {
    if (connected) reload();
  }, [connected, reload]);

  const [pageShown, setPageShown] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setPageShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => {
    if (!visible || !pageShown) return;
    reload();
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, [visible, pageShown, reload]);

  return { view, error, loadedAt, reload };
}
