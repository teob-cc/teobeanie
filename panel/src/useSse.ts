import { useEffect, useRef, useState } from "react";

export type SseFrame = { type: string } & Record<string, any>;

/**
 * One EventSource("api/stream") — relative URL, ingress-safe. Listens for the
 * named frame types the server multiplexes (hello / journal / signal / house / reload)
 * and hands each parsed frame to `onFrame`. Relies on the native EventSource
 * auto-reconnect (the server sends `retry: 3000`).
 */
export function useSse(onFrame: (f: SseFrame) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    const es = new EventSource("api/stream");
    const dispatch = (ev: MessageEvent) => {
      try {
        cb.current(JSON.parse(ev.data as string) as SseFrame);
      } catch {
        // malformed frame — ignore
      }
    };
    for (const type of ["hello", "journal", "signal", "house", "reload"]) es.addEventListener(type, dispatch);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return { connected };
}
