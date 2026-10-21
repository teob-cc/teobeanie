import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CatalogueEntry, type EditOutcome, type InstanceConfig, type InstanceMode, type JournalRow, type PickerEntity, type ReloadOutcome } from "../api";
import { foldDecisions, pendingTimers, shortId, type HeuristicInstance } from "../decisions";
import { fmtTime, rel } from "../format";
import type { SseFrame } from "../useSse";
import { Decisions } from "./Decisions";
import { useDeviceEntities } from "../useDevices";
import { Catalogue } from "../components/Catalogue";
import { InstanceEditor, MODE_EFFECT } from "../components/InstanceEditor";

const DAY_MS = 24 * 3600e3;

interface InstanceStats {
  decisions24h: number;
  calls24h: number;
  matched24h: number;
  refused24h: number;
  notifies24h: number;
  last?: { at: number; why: string };
  timers: Array<{ timer: string; at: number }>;
}

/** The instance editor's subject: a new instance of a heuristic, or one heuristics.json has. */
type Editing = { entry: CatalogueEntry; initial?: InstanceConfig };

/**
 * Registry of heuristic instances: mode, last decision, 24 h activity, pending timers;
 * click for history, the mode and the editor. The library tab is the catalogue the
 * instances are added from.
 */
export function Heuristics({
  subscribe,
  instances,
  error,
  lastReload,
  onReloaded,
  onOpenSource,
}: {
  subscribe: (fn: (f: SseFrame) => void) => () => void;
  instances: HeuristicInstance[];
  error: string | null;
  /** The latest config reload since the add-on started. */
  lastReload: ReloadOutcome | null;
  onReloaded: () => void;
  /** Show a heuristic's source in the Studio. */
  onOpenSource?: (heuristic: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"instances" | "library">("instances");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saved, setSaved] = useState<{ what: string; outcome: EditOutcome } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // The catalogue and the pickers' entities: again after every reload (a file of our own, a new scope).
  const [library, setLibrary] = useState<{ heuristics: CatalogueEntry[]; entities: PickerEntity[] } | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  useEffect(() => {
    api
      .library()
      .then((l) => {
        setLibrary(l);
        setLibraryError(null);
      })
      .catch((e) => setLibraryError(e instanceof Error ? e.message : String(e)));
  }, [lastReload?.at]);
  const edit = (i: HeuristicInstance) => {
    const entry = library?.heuristics.find((h) => h.id === i.heuristic);
    if (!entry) return setEditError(`${i.heuristic} is not in the library the add-on runs`);
    setEditError(null);
    api
      .instance(i.key)
      .then((initial) => setEditing({ entry, initial }))
      .catch((e) => setEditError(e instanceof Error ? e.message : String(e)));
  };
  const done = (outcome: EditOutcome, what: string) => {
    setEditing(null);
    setSaved({ what, outcome });
    if (what.startsWith("Removed")) setSelected(null);
    onReloaded();
  };
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const reloadConfig = () => {
    setReloading(true);
    setReloadError(null);
    api
      .reloadConfig()
      .then(onReloaded)
      .catch((e) => setReloadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setReloading(false));
  };
  const [rows, setRows] = useState<JournalRow[]>([]);
  const [now, setNow] = useState(Date.now());

  const heuristicIds = useMemo(() => [...new Set(instances.map((i) => i.heuristic))], [instances]);

  const load = useCallback(async () => {
    const since = Date.now() - DAY_MS;
    const pages = await Promise.all([
      ...heuristicIds.map((h) => api.journal({ category: h, limit: 1000 }).then((r) => r.rows)),
      api.journal({ category: "ha-audit", since, limit: 1000 }).then((r) => r.rows),
    ]);
    setRows(pages.flat());
  }, [heuristicIds]);

  useEffect(() => {
    if (heuristicIds.length > 0) void load().catch(() => {});
  }, [load, heuristicIds]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribe((f) => {
      if (f.type === "journal" && heuristicIds.includes(f.category)) {
        clearTimeout(t);
        t = setTimeout(() => void load().catch(() => {}), 1000);
      }
    });
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      unsub();
      clearTimeout(t);
      clearInterval(tick);
    };
  }, [subscribe, load, heuristicIds]);

  const devices = useDeviceEntities(rows);

  const stats = useMemo(() => {
    const { decisions } = foldDecisions(rows, new Set(heuristicIds), devices);
    const out = new Map<string, InstanceStats>();
    for (const i of instances) {
      const own = rows.filter((r) => r.category === i.heuristic && r.entityId === i.id);
      out.set(i.key, { decisions24h: 0, calls24h: 0, matched24h: 0, refused24h: 0, notifies24h: 0, timers: pendingTimers(own) });
    }
    const cutoff = Date.now() - DAY_MS;
    for (const d of decisions) {
      const s = out.get(d.key);
      if (!s) continue;
      if (s.last === undefined) s.last = { at: d.at, why: d.why ?? d.failed ?? d.input.kind };
      if (d.at < cutoff) continue;
      s.decisions24h++;
      for (const a of d.actions) {
        if (a.disposition === "refused") s.refused24h++;
        else if (a.action.kind === "notify") s.notifies24h++;
        else {
          s.calls24h++;
          if (a.seen) s.matched24h++;
        }
      }
    }
    return out;
  }, [rows, instances, heuristicIds, devices]);

  if (editing) {
    return (
      <InstanceEditor
        key={editing.initial ? `${editing.initial.heuristic}/${editing.initial.id}` : `new:${editing.entry.id}`}
        entry={editing.entry}
        {...(editing.initial ? { initial: editing.initial } : {})}
        taken={instances.filter((i) => i.heuristic === editing.entry.id).map((i) => i.id)}
        entities={library?.entities ?? []}
        onDone={done}
        onCancel={() => setEditing(null)}
      />
    );
  }

  // What the last save did, as journaled.
  const savedBanner = saved && (
    <div className="banner">
      {saved.what}: {"journaled" in saved.outcome && saved.outcome.journaled ? saved.outcome.journaled.summary : "nothing changed"}
      {"summary" in saved.outcome && saved.outcome.summary && <span className="muted small"> · reload {saved.outcome.summary}</span>}
      <button className="tab" onClick={() => setSaved(null)}>
        OK
      </button>
    </div>
  );

  const current = instances.find((i) => i.key === selected);
  if (current) {
    return (
      <div>
        <header className="view-head">
          <button className="tab" onClick={() => setSelected(null)}>
            ← All heuristics
          </button>
          <h2>{current.id}</h2>
          <span className="muted small">{current.title}</span>
          <ModeChip i={current} />
          <ModeControl i={current} onChanged={onReloaded} />
          <button className="tab" onClick={() => edit(current)} disabled={library === null} title="Change its settings, or remove it">
            Edit…
          </button>
        </header>
        {savedBanner}
        {editError && <div className="banner">Cannot edit: {editError}</div>}
        <InstanceFacts i={current} timers={stats.get(current.key)?.timers ?? []} now={now} />
        <Decisions subscribe={subscribe} instances={instances} only={current} />
      </div>
    );
  }

  const groups = heuristicIds.map((h) => ({ h, list: instances.filter((i) => i.heuristic === h) }));
  return (
    <div>
      <header className="view-head">
        <h2>Heuristics</h2>
        <span className="muted small">
          {instances.length} instances · {instances.filter((i) => i.mode === "active").length} active ·{" "}
          {instances.filter((i) => i.mode === "shadow").length} shadow
          {lastReload?.ok && ` · config reloaded ${rel(now, lastReload.at)}: ${lastReload.summary ?? ""}`}
        </span>
        <span className="seg" role="tablist" aria-label="instances or library">
          <button role="tab" aria-selected={view === "instances"} className={view === "instances" ? "tab active" : "tab"} onClick={() => setView("instances")}>
            Instances
          </button>
          <button role="tab" aria-selected={view === "library"} className={view === "library" ? "tab active" : "tab"} onClick={() => setView("library")}>
            Library
          </button>
        </span>
        <button className="tab" onClick={reloadConfig} disabled={reloading} title="Read heuristics.json, allowlist.json and tiles.json again">
          {reloading ? "Reloading…" : "Reload config"}
        </button>
      </header>
      {savedBanner}
      {error && <div className="banner">{error}</div>}
      {reloadError && <div className="banner">Reload failed: {reloadError}</div>}
      {lastReload && !lastReload.ok && (
        <div className="banner">
          Config change rejected at {fmtTime(lastReload.at)}, the previous configuration keeps running: <code>{lastReload.error}</code>
        </div>
      )}
      {view === "library" && (
        <>
          <p className="muted small">
            The heuristics this house can run: the packages in the config folder's packages/ (the starter set came with the add-on), and your own from its heuristics/. Add an instance to use one with your
            entities; it starts in shadow.
          </p>
          {libraryError && <div className="banner">Library unavailable: {libraryError}</div>}
          {library && (
            <Catalogue
              entries={library.heuristics}
              instances={instances}
              onAdd={(entry) => setEditing({ entry })}
              {...(onOpenSource ? { onSource: (e: CatalogueEntry) => onOpenSource(e.id) } : {})}
            />
          )}
        </>
      )}
      {view === "instances" && instances.length === 0 && !error && (
        <p className="muted">
          No heuristics configured yet. Pick one in the{" "}
          <button className="ied-link" onClick={() => setView("library")}>
            library
          </button>{" "}
          and add an instance, or add instances to heuristics.json in the add-on's config folder; they start as soon as the file is saved.
        </p>
      )}
      {view === "instances" &&
        groups.map(({ h, list }) => (
        <section key={h}>
          <div className="day-div">{list[0]?.title ?? h}</div>
          <div className="hgrid">
            {list.map((i) => {
              const s = stats.get(i.key);
              return (
                <button key={i.key} className="hcard" onClick={() => setSelected(i.key)}>
                  <div className="hcard-top">
                    <span className="hcard-name">{i.id}</span>
                    <ModeChip i={i} />
                  </div>
                  <div className="hcard-last small">
                    {s?.last ? (
                      <>
                        <span className="muted tnum">{rel(now, s.last.at)}</span> {s.last.why}
                      </>
                    ) : (
                      <span className="muted">no decisions yet</span>
                    )}
                  </div>
                  <div className="hcard-stats small muted tnum">
                    {s?.decisions24h ?? 0} decisions/24 h
                    {s && s.calls24h > 0 && ` · ${s.matched24h}/${s.calls24h} calls also made outside Teobeanie`}
                    {s && s.notifies24h > 0 && ` · ${s.notifies24h} messages`}
                    {s && s.refused24h > 0 && <span className="bad-text"> · {s.refused24h} refused</span>}
                  </div>
                  {s && s.timers.length > 0 && (
                    <div className="hcard-timers small">
                      {s.timers.map((t) => (
                        <span key={t.timer} className="chip chip-off">
                          ⏱ {t.timer} {t.at > now ? `in ${fmtIn(t.at - now)}` : "due"}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="hcard-ents small muted">
                    {i.pattern && <span className="chip chip-off">{i.pattern}</span>}{" "}
                    {i.actuates.length > 0
                      ? `controls ${i.actuates.map(shortId).join(", ")}`
                      : (i.uses ?? []).length > 0
                        ? `uses ${i.uses!.map(shortId).join(", ")}`
                        : `watches ${i.watch.map(shortId).join(", ")}`}
                    {(i.commands ?? []).length > 0 && ` · answers ${i.commands!.map((c) => `/${c}`).join(", ")}`}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function ModeChip({ i }: { i: HeuristicInstance }) {
  const forced = i.configuredMode === "active" && i.mode === "shadow";
  const cls = i.mode === "active" ? "chip chip-ok" : i.mode === "shadow" ? "chip chip-on" : "chip chip-off";
  return (
    <span className={cls} title={forced ? "configured active, but the global shadow_mode option is on" : `mode: ${i.mode}`}>
      {i.mode}
      {forced ? " (global)" : ""}
    </span>
  );
}

/**
 * The instance's mode as a command: pick one, confirm, and heuristics.json gets the new
 * mode (nothing else in the file changes), the config reloads, and the change is
 * journaled with who made it. A rejected reload leaves the file as it was.
 */
function ModeControl({ i, onChanged }: { i: HeuristicInstance; onChanged: () => void }) {
  const [want, setWant] = useState<InstanceMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (mode: InstanceMode) => {
    setBusy(true);
    setError(null);
    api
      .setMode(i.key, mode)
      .then((o) => {
        if (!o.ok) throw new Error(`the config was rejected, nothing changed: ${o.error ?? "?"}`);
        setWant(null);
        onChanged();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="pause mode-control">
      <span className="seg" role="radiogroup" aria-label="mode">
        {(["off", "shadow", "active"] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={i.configuredMode === m}
            className={i.configuredMode === m ? "tab active" : "tab"}
            onClick={() => {
              setError(null);
              setWant(m === i.configuredMode ? null : m);
            }}
            disabled={busy}
          >
            {m}
          </button>
        ))}
      </span>
      {want !== null && (
        <div className="pause-pop" role="dialog" aria-label={`set ${i.key} to ${want}`}>
          <p>
            Switch {i.id} from {i.configuredMode} to {want}? {MODE_EFFECT[want]}
          </p>
          <p className="muted small">heuristics.json is changed and reloaded; the change is journaled with your name.</p>
          {error && <p className="pause-error">{error}</p>}
          <div className="pause-actions">
            <button className="tab" onClick={() => setWant(null)} disabled={busy}>
              Cancel
            </button>
            <button className="tab active" onClick={() => submit(want)} disabled={busy}>
              {busy ? "…" : `Set ${want}`}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function InstanceFacts({ i, timers, now }: { i: HeuristicInstance; timers: Array<{ timer: string; at: number }>; now: number }) {
  return (
    <details className="card">
      <summary className="card-summary">
        <span className="small">
          watches {i.watch.length} · reads {i.reads.length} · controls {i.actuates.length}
          {timers.length > 0 && ` · ${timers.length} pending timer${timers.length > 1 ? "s" : ""}`}
        </span>
      </summary>
      <div className="card-body">
        <dl className="kv">
          <dt>Watches</dt>
          <dd className="small">{i.watch.map((e) => <div key={e}><code>{e}</code></div>)}</dd>
          {i.reads.length > 0 && (
            <>
              <dt>Reads</dt>
              <dd className="small">{i.reads.map((e) => <div key={e}><code>{e}</code></div>)}</dd>
            </>
          )}
          {i.pattern && (
            <>
              <dt>Pattern</dt>
              <dd className="small">{i.pattern}</dd>
            </>
          )}
          <dt>Controls</dt>
          <dd className="small">{i.actuates.length ? i.actuates.map((e) => <div key={e}><code>{e}</code></div>) : <span className="muted">nothing it owns</span>}</dd>
          {(i.uses ?? []).length > 0 && (
            <>
              <dt>Uses</dt>
              <dd className="small">{i.uses!.map((e) => <div key={e}><code>{e}</code> <span className="muted">(shared by its owner)</span></div>)}</dd>
            </>
          )}
          {(i.commands ?? []).length > 0 && (
            <>
              <dt>Commands</dt>
              <dd className="small">{i.commands!.map((c) => `/${c}`).join(", ")}</dd>
            </>
          )}
          {i.triggers.length > 0 && (
            <>
              <dt>Triggers</dt>
              <dd className="small">{i.triggers.join(", ")}</dd>
            </>
          )}
          {timers.length > 0 && (
            <>
              <dt>Timers</dt>
              <dd className="small">
                {timers.map((t) => (
                  <div key={t.timer}>
                    {t.timer} at {fmtTime(t.at)} ({t.at > now ? `in ${fmtIn(t.at - now)}` : "due"})
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
        <pre className="card-raw">{JSON.stringify(i.params, null, 2)}</pre>
      </div>
    </details>
  );
}

function fmtIn(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
