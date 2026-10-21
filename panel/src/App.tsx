import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { api, CONTROL_CATEGORY, type PauseState, type ReloadOutcome } from "./api";
import { PauseControl } from "./components/PauseControl";
import type { HeuristicInstance } from "./decisions";
import { useSse, type SseFrame } from "./useSse";
import { Today } from "./views/Today";
import { House } from "./views/House";
import { Decisions } from "./views/Decisions";
import { Heuristics } from "./views/Heuristics";
import { Connect } from "./views/Connect";

// The editor is megabytes: loaded the first time the Studio's Editor tab opens.
const Studio = lazy(() => import("./views/Studio"));

type Tab = "house" | "studio" | "connect";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "house", label: "House" },
  { id: "studio", label: "Studio" },
  { id: "connect", label: "Connect" },
];

/** The Studio's own tabs: how Teobeanie decides, what it runs, what it called, and its code. */
type StudioTab = "decisions" | "heuristics" | "calls" | "editor";

const STUDIO_TABS: Array<{ id: StudioTab; label: string }> = [
  { id: "decisions", label: "Decisions" },
  { id: "heuristics", label: "Heuristics" },
  { id: "calls", label: "Calls" },
  { id: "editor", label: "Editor" },
];
type Theme = "auto" | "light" | "dark";

const THEME_KEY = "teobeanie-theme";

function initialTheme(): Theme {
  try {
    // "teob-theme": the key before the rename to Teobeanie.
    const t = localStorage.getItem(THEME_KEY) ?? localStorage.getItem("teob-theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>("house");
  const [studioTab, setStudioTab] = useState<StudioTab>("decisions");
  const [instances, setInstances] = useState<HeuristicInstance[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [lastReload, setLastReload] = useState<ReloadOutcome | null>(null);

  // Instances change with a config reload ("reload" frame) or a restart of the add-on.
  const loadInstances = useCallback(() => {
    api
      .heuristics()
      .then((r) => {
        setInstances(r.instances);
        setLastReload(r.reload ?? null);
        setInstancesError(null);
      })
      .catch((e) => setInstancesError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(loadInstances, [loadInstances]);
  // The global pause: on load, on (re)connect and on every pause or resume journaled.
  const [pause, setPause] = useState<PauseState | null>(null);
  const loadPause = useCallback(() => {
    api
      .pause()
      .then(setPause)
      .catch(() => {});
  }, []);
  useEffect(loadPause, [loadPause]);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme === "dark" || (theme === "auto" && systemDark);
  const openStudio = useCallback((t: StudioTab) => {
    setTab("studio");
    setStudioTab(t);
  }, []);
  const editorShown = tab === "studio" && studioTab === "editor";
  const [editorOpened, setEditorOpened] = useState(false);
  // A heuristic whose source the catalogue asked the editor to show; n tells two asks apart.
  const [studioShow, setStudioShow] = useState<{ heuristic: string; n: number } | null>(null);
  const openSource = useCallback((heuristic: string) => {
    setStudioShow((s) => ({ heuristic, n: (s?.n ?? 0) + 1 }));
    openStudio("editor");
  }, [openStudio]);
  useEffect(() => {
    if (editorShown) setEditorOpened(true);
  }, [editorShown]);
  // An instance the Decisions feed was asked to filter to (a card on the House page); n tells two asks apart.
  const [decisionsSelect, setDecisionsSelect] = useState<{ key: string; n: number } | null>(null);
  const openDecisions = useCallback((key: string) => {
    setDecisionsSelect((s) => ({ key, n: (s?.n ?? 0) + 1 }));
    openStudio("decisions");
  }, [openStudio]);

  // One SSE connection for the whole app; frames fan out to view subscribers.
  const listeners = useRef(new Set<(f: SseFrame) => void>());
  const onFrame = useCallback((f: SseFrame) => {
    if (f.type === "reload") loadInstances();
    if (f.type === "hello" || (f.type === "journal" && f.category === CONTROL_CATEGORY)) loadPause();
    for (const l of listeners.current) {
      try {
        l(f);
      } catch {
        // a broken subscriber must not break the fan-out
      }
    }
  }, [loadInstances, loadPause]);
  const { connected } = useSse(onFrame);
  const subscribe = useCallback((fn: (f: SseFrame) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const cycleTheme = () => {
    const next: Theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
    setTheme(next);
    try {
      if (next === "auto") {
        document.documentElement.removeAttribute("data-theme");
        localStorage.removeItem(THEME_KEY);
      } else {
        document.documentElement.dataset.theme = next;
        localStorage.setItem(THEME_KEY, next);
      }
      localStorage.removeItem("teob-theme");
    } catch {
      // localStorage unavailable — theme still applies for this session
    }
  };

  return (
    <div className={editorShown ? "app app-wide" : "app"}>
      <header className="topbar">
        <span
          className={connected ? "dot dot-ok" : "dot dot-bad"}
          title={connected ? "live stream connected" : "live stream disconnected"}
        />
        <h1>Teobeanie</h1>
        <nav className="tabs" role="tablist" aria-label="views">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <PauseControl state={pause} onChanged={setPause} />
        <button
          className="theme-btn"
          onClick={cycleTheme}
          title={`theme: ${theme} (click to change)`}
          aria-label={`theme: ${theme}`}
        >
          {theme === "auto" ? "◐" : theme === "light" ? "☀" : "☾"}
        </button>
      </header>
      <main>
        {/* Views stay mounted so live feeds keep accumulating while hidden. */}
        <div style={tab === "house" ? undefined : { display: "none" }}>
          <House subscribe={subscribe} connected={connected} onDecisions={openDecisions} />
        </div>
        <div style={tab === "studio" ? undefined : { display: "none" }}>
          <nav className="subtabs" role="tablist" aria-label="studio">
            {STUDIO_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={studioTab === t.id}
                className={studioTab === t.id ? "tab active" : "tab"}
                onClick={() => setStudioTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div style={studioTab === "decisions" ? undefined : { display: "none" }}>
            <Decisions subscribe={subscribe} instances={instances} select={decisionsSelect} />
          </div>
          <div style={studioTab === "heuristics" ? undefined : { display: "none" }}>
            <Heuristics subscribe={subscribe} instances={instances} error={instancesError} lastReload={lastReload} onReloaded={loadInstances} onOpenSource={openSource} />
          </div>
          <div style={studioTab === "calls" ? undefined : { display: "none" }}>
            <Today subscribe={subscribe} />
          </div>
          {editorOpened && (
            <div style={studioTab === "editor" ? undefined : { display: "none" }}>
              <Suspense fallback={<p className="muted">Loading the editor…</p>}>
                <Studio dark={dark} instances={instances} show={studioShow} />
              </Suspense>
            </div>
          )}
        </div>
        <div style={tab === "connect" ? undefined : { display: "none" }}>
          <Connect />
        </div>
      </main>
    </div>
  );
}
