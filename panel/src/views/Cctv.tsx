// Cctv.tsx — the CCTV tab: each camera's picture now, and the episodes Frigate kept (its
// review items: someone it tracked, or a manual event such as a movement sensor's), newest
// first, by day, each playable in place. Everything comes from Frigate through api/cctv
// (src/cctv/); read-only. Its tab shows once Frigate answers.

import { useEffect, useRef, useState } from "react";
import type { CctvEpisode } from "../../../src/cctv/view";
import { dayKey, fmtDay, rel } from "../format";
import { useNow } from "../useHouse";
import { useCctv, usePageShown } from "../useCctv";
import type { VerticalProps } from "../verticals";

/** How often a live picture is fetched again while it is in view. */
const LIVE_MS = 1_500;
/** Played before and after an episode: the recording around it. */
const PAD_S = 3;

export function Cctv({ connected, visible, onAvailable }: VerticalProps) {
  const [camera, setCamera] = useState<string | null>(null);
  const { view, error, loadedAt, loadingMore, reload, more } = useCctv(visible, connected, camera);
  const available = view?.available === true;
  useEffect(() => onAvailable(available), [available, onAvailable]);
  const now = useNow(5_000);
  const [playing, setPlaying] = useState<string | null>(null);

  if (view === null || !view.available) return null;
  const days: Array<{ key: string; at: number; episodes: CctvEpisode[] }> = [];
  for (const e of view.episodes) {
    const key = dayKey(e.start);
    const day = days.at(-1);
    if (day?.key === key) day.episodes.push(e);
    else days.push({ key, at: e.start, episodes: [e] });
  }

  return (
    <div className="cctv">
      <header className="view-head">
        <h2>CCTV</h2>
        <span className="muted small tnum">{loadedAt !== null ? `updated ${rel(now, loadedAt)} · Frigate ${view.version}` : ""}</span>
      </header>
      {error !== null && (
        <div className="banner" role="alert">
          could not refresh: {error}
          <button onClick={reload}>retry</button>
        </div>
      )}

      <section className="cctv-live" aria-label="cameras now">
        {view.cameras.map((c) => (
          <LiveCamera key={c.name} name={c.name} active={visible} />
        ))}
      </section>

      <div className="toolbar cctv-filter" role="tablist" aria-label="camera">
        <button role="tab" aria-selected={camera === null} className={camera === null ? "tab active" : "tab"} onClick={() => setCamera(null)}>
          All cameras
        </button>
        {view.cameras.map((c) => (
          <button key={c.name} role="tab" aria-selected={camera === c.name} className={camera === c.name ? "tab active" : "tab"} onClick={() => setCamera(c.name)}>
            {c.name}
          </button>
        ))}
      </div>

      {view.episodes.length === 0 && <p className="muted">No recorded episodes{camera !== null ? ` on ${camera}` : ""}.</p>}
      {days.map((d) => (
        <section key={d.key} aria-label={fmtDay(d.at)}>
          <div className="day-div">
            {fmtDay(d.at)} <span className="tnum">· {d.episodes.length}</span>
          </div>
          <ul className="cctv-episodes">
            {d.episodes.map((e) => (
              <Episode key={e.id} e={e} now={now} open={playing === e.id} onToggle={() => setPlaying(playing === e.id ? null : e.id)} />
            ))}
          </ul>
        </section>
      ))}
      {view.more && (
        <div className="center">
          <button onClick={more} disabled={loadingMore}>
            {loadingMore ? "loading…" : "Older episodes"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A camera's latest frame, fetched again every LIVE_MS while the tab is in view. The next
 * frame loads off-screen and replaces the shown one once it has arrived: no flicker, and
 * no pile-up of requests when the network is slow.
 */
function LiveCamera({ name, active }: { name: string; active: boolean }) {
  const pageShown = usePageShown();
  const [src, setSrc] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState(false);
  const busy = useRef(false);
  const now = useNow(5_000);

  useEffect(() => {
    if (!active || !pageShown) return;
    let stopped = false;
    const h = big ? 1080 : 480;
    const next = () => {
      if (busy.current || stopped) return;
      busy.current = true;
      const url = `api/cctv/${encodeURIComponent(name)}/latest.jpg?h=${h}&t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        busy.current = false;
        if (stopped) return;
        setSrc(url);
        setAt(Date.now());
        setFailed(false);
      };
      img.onerror = () => {
        busy.current = false;
        if (!stopped) setFailed(true);
      };
      img.src = url;
    };
    next();
    const t = setInterval(next, LIVE_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [name, active, pageShown, big]);

  return (
    <figure className={big ? "cctv-cam cctv-cam-big" : "cctv-cam"}>
      <button className="cctv-cam-frame" onClick={() => setBig(!big)} aria-label={big ? `${name}: smaller` : `${name}: larger`}>
        {src !== null ? <img src={src} alt={`${name} now`} /> : <span className="muted small">{failed ? "no picture" : "loading…"}</span>}
      </button>
      <figcaption>
        <span className="cctv-cam-name">{name}</span>
        <span className={failed ? "chip chip-bad" : "chip chip-ok"}>{failed ? "no picture" : "live"}</span>
        {failed && at !== null && <span className="muted small tnum">last {rel(now, at)}</span>}
      </figcaption>
    </figure>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 || m >= 10 ? `${m} min` : `${m} min ${s % 60} s`;
}

function Episode({ e, now, open, onToggle }: { e: CctvEpisode; now: number; open: boolean; onToggle: () => void }) {
  const cam = encodeURIComponent(e.camera);
  const ongoing = e.end === null;
  const end = e.end ?? now;
  const startS = e.start / 1000 - PAD_S;
  const endS = end / 1000 + (ongoing ? 0 : PAD_S);
  return (
    <li className={open ? "cctv-ep cctv-ep-open" : "cctv-ep"}>
      <button className="cctv-ep-row" onClick={onToggle} aria-expanded={open}>
        <img className="cctv-thumb" src={`api/cctv/${cam}/thumb/${encodeURIComponent(e.id)}`} alt="" loading="lazy" />
        <span className="cctv-ep-main">
          <span className="cctv-ep-time tnum">
            {clock(e.start)}
            <span className="muted"> · {ongoing ? "going on" : duration(end - e.start)}</span>
          </span>
          <span className="cctv-ep-labels">
            {e.labels.map((l) => (
              <span key={l} className={e.severity === "alert" ? "chip chip-warn" : "chip"}>
                {l}
              </span>
            ))}
            {e.zones.map((z) => (
              <span key={z} className="chip chip-off">
                {z}
              </span>
            ))}
          </span>
        </span>
        <span className="cctv-ep-cam muted small">{e.camera}</span>
        {ongoing && <span className="chip chip-bad">rec</span>}
      </button>
      {open && (
        <video
          className="cctv-video"
          controls
          autoPlay
          muted
          playsInline
          preload="auto"
          src={`api/cctv/${cam}/clip/${startS.toFixed(1)}/${endS.toFixed(1)}`}
        />
      )}
    </li>
  );
}
