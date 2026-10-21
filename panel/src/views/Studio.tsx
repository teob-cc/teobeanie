import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { HeuristicInstance } from "../decisions";
import { addLibraryModels, libUriOf, monaco, setTypes, uriOf } from "../studio/monaco";
import { copyForConfig, loadLibraryFiles, type LibraryFile } from "../studio/library";
import type { RunResult } from "../studio/protocol";

/**
 * The Studio: the config folder's rules and heuristics in an editor that type-checks
 * them against this house, with their tests running in a worker as you type. Files
 * stay the source of truth: saving writes heuristics/<name> in the config folder.
 * The packages (packages/ in the config folder) are shown read-only next to them, with
 * the instances this house runs of each heuristic.
 */

interface FileState {
  name: string;
  saved: string;
  text: string;
}

const RUN_LIMIT_MS = 3000;

const ruleTemplate = (id: string) => `import { keep, minutes, rule } from "teobeanie";

// What should the entity be, given the house? Return entity.to(value), or keep.
export default rule("${id}", ({ ha, held }) =>
  ha.light.example.to(keep),
);
`;

const testTemplate = (base: string) => `import { minutes } from "teobeanie";
import { expect, simulate, test } from "teobeanie/test";
import heuristic from "./${base}";

test("does what it should", () => {
  const sim = simulate(heuristic, {}, {
    // "binary_sensor.example": "off",
  }).start();
  // sim.set("binary_sensor.example", "on").advance(minutes(5));
  expect(sim.calls()).toEqual([]);
});
`;

/** "starter package", "starter package, changed here", "local package". */
const originLabel = (f: LibraryFile) => `${f.pkg.origin} package${f.pkg.modified ? ", changed here" : ""}`;

const isTest = (name: string) => /\.test\.(ts|js|mjs)$/.test(name);
const baseOf = (name: string) => name.replace(/(\.test)?\.(ts|js|mjs)$/, "");

/** The instances heuristics.json runs of these heuristic ids. */
function InHouse({ ids, instances }: { ids: string[]; instances: HeuristicInstance[] }) {
  const used = instances.filter((i) => ids.includes(i.heuristic));
  if (used.length === 0) return <p className="muted small">Not used in this house.</p>;
  return (
    <>
      {used.map((i) => (
        <details key={i.key} className="studio-instance">
          <summary>
            <code>{i.id}</code> <span className={i.mode === "active" ? "chip chip-ok" : i.mode === "shadow" ? "chip chip-on" : "chip chip-off"}>{i.mode}</span>
          </summary>
          <pre className="studio-params">{JSON.stringify(i.params, null, 2)}</pre>
        </details>
      ))}
    </>
  );
}

export default function Studio({
  dark,
  instances,
  show,
}: {
  dark: boolean;
  instances: HeuristicInstance[];
  /** A heuristic to show, from the catalogue: its package file (read-only, with Copy to edit), or the house's file that defines it. */
  show?: { heuristic: string; n: number } | null;
}) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [active, setActive] = useState<string | null>(null);
  /** A package file on display instead of a config file (read-only), by "<package>/<file>". */
  const [lib, setLib] = useState<string | null>(null);
  /** The packages' files; null until loaded. */
  const [libFiles, setLibFiles] = useState<LibraryFile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typesInfo, setTypesInfo] = useState<{ entities: number; operable: number; toolkit: boolean } | null>(null);
  const [typeErrors, setTypeErrors] = useState<Record<string, number>>({});
  const [result, setResult] = useState<RunResult | { error: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // Files and types, once.
  useEffect(() => {
    void (async () => {
      try {
        const [list, types] = await Promise.all([api.studioFiles(), api.studioTypes()]);
        setTypes(types.toolkit ?? {}, types.house);
        setTypesInfo({
          entities: types.scope?.observed ?? (types.house.match(/^ {4}"[^"]+": [^t]/gm) ?? []).length,
          operable: types.scope?.operated ?? 0,
          toolkit: types.toolkit !== null,
        });
        const loaded = await Promise.all(list.files.map(async (f) => ({ name: f.name, text: await api.studioFile(f.name) })));
        // Rules before tests: a model's diagnostics are computed when it is created, so a
        // test created before the rule it imports would report it missing until edited.
        for (const f of [...loaded].sort((x, y) => Number(isTest(x.name)) - Number(isTest(y.name)))) {
          monaco.editor.createModel(f.text, "typescript", uriOf(f.name));
        }
        setFiles(loaded.map((f) => ({ name: f.name, saved: f.text, text: f.text })));
        setActive(loaded.find((f) => !isTest(f.name))?.name ?? loaded[0]?.name ?? null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    // The packages, read-only beside the house's files; without them the editor still works.
    void loadLibraryFiles()
      .then((lib) => {
        addLibraryModels(lib);
        setLibFiles(lib);
      })
      .catch(() => setLibFiles([]));
  }, []);

  // The editor itself.
  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.create(host.current, {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    });
    editor.current = ed;
    const sub = ed.onDidChangeModelContent(() => {
      const model = ed.getModel();
      if (!model) return;
      const name = model.uri.path.replace(/^\/heuristics\//, "");
      const text = model.getValue();
      setFiles((fs) => fs.map((f) => (f.name === name ? { ...f, text } : f)));
    });
    const markers = monaco.editor.onDidChangeMarkers(() => {
      const counts: Record<string, number> = {};
      for (const m of monaco.editor.getModelMarkers({})) {
        if (m.severity !== monaco.MarkerSeverity.Error || !m.resource.path.startsWith("/heuristics/")) continue;
        const name = m.resource.path.slice("/heuristics/".length);
        counts[name] = (counts[name] ?? 0) + 1;
      }
      setTypeErrors(counts);
    });
    return () => {
      sub.dispose();
      markers.dispose();
      ed.dispose();
    };
  }, []);

  useEffect(() => monaco.editor.setTheme(dark ? "vs-dark" : "vs"), [dark]);

  useEffect(() => {
    if (!editor.current) return;
    const uri = lib !== null ? libUriOf(lib) : active !== null ? uriOf(active) : null;
    const model = uri && monaco.editor.getModel(uri);
    editor.current.updateOptions({ readOnly: lib !== null });
    if (model && editor.current.getModel() !== model) editor.current.setModel(model);
  }, [active, lib]);

  const open = (name: string) => {
    setLib(null);
    setActive(name);
  };

  // The catalogue's "source" button: once per ask, as soon as the house's files are loaded.
  const shown = useRef(0);
  useEffect(() => {
    if (!show || show.n === shown.current) return;
    if (libFiles === null) return;
    const inPackage = libFiles.find((f) => f.ids.includes(show.heuristic));
    if (inPackage) {
      shown.current = show.n;
      setLib(inPackage.key);
      return;
    }
    if (files.length === 0) return;
    shown.current = show.n;
    // A house's file names its heuristic's id as a string: rule("porch-light", ...) or id: "porch-light".
    const own = files.find((f) => !isTest(f.name) && f.text.includes(`"${show.heuristic}"`));
    if (own) open(own.name);
    else setNotice({ kind: "bad", text: `No file here defines ${show.heuristic}.` });
  }, [show, files, libFiles]);

  // Run every file's load check and every test, in a fresh worker, shortly after typing stops.
  const sources = useMemo(() => Object.fromEntries(files.map((f) => [f.name, f.text])), [files]);
  useEffect(() => {
    if (files.length === 0) return;
    let worker: Worker | undefined;
    let limit: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(() => {
      worker = new Worker(new URL("../studio/test-worker.ts", import.meta.url), { type: "module" });
      limit = setTimeout(() => {
        worker?.terminate();
        setResult({ error: `stopped after ${RUN_LIMIT_MS / 1000} s: a rule or test does not finish (a loop?)` });
      }, RUN_LIMIT_MS);
      worker.onmessage = (ev: MessageEvent<RunResult>) => {
        clearTimeout(limit);
        setResult(ev.data);
        worker?.terminate();
      };
      worker.onerror = (ev) => {
        clearTimeout(limit);
        setResult({ error: ev.message || "the test worker failed" });
      };
      worker.postMessage({ files: sources });
    }, 400);
    return () => {
      clearTimeout(debounce);
      clearTimeout(limit);
      worker?.terminate();
    };
  }, [sources, files.length]);

  const save = useCallback(async () => {
    const f = filesRef.current.find((x) => x.name === active);
    if (!f) return;
    try {
      await api.saveStudioFile(f.name, f.text);
      setFiles((fs) => fs.map((x) => (x.name === f.name ? { ...x, saved: f.text } : x)));
      setNotice({ kind: "ok", text: `Saved ${f.name}. It runs from the next config reload: Reload config on the Heuristics tab.` });
    } catch (e) {
      setNotice({ kind: "bad", text: `Not saved: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [active]);

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    const action = ed.addAction({
      id: "teobeanie.save",
      label: "Save to the config folder",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => void save(),
    });
    return () => action.dispose();
  }, [save]);

  const create = (name: string, text: string) => {
    if (filesRef.current.some((f) => f.name === name)) {
      open(name);
      return;
    }
    monaco.editor.createModel(text, "typescript", uriOf(name));
    setFiles((fs) => [...fs, { name, saved: "", text }].sort((a, b) => a.name.localeCompare(b.name)));
    open(name);
    setNotice({ kind: "ok", text: `${name} is new and not saved yet.` });
  };

  const newRule = () => {
    const id = newName.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setNotice({ kind: "bad", text: "A rule name is kebab-case: letters, digits and dashes, like porch-light." });
      return;
    }
    create(`${id}.ts`, ruleTemplate(id));
    setNewName("");
  };

  const libFile = libFiles?.find((f) => f.key === lib);
  const activeFile = libFile ? undefined : files.find((f) => f.name === active);
  const run = result !== null && !("error" in result) ? result : null;
  const testsFor = (name: string) => run?.tests.filter((t) => baseOf(t.file) === baseOf(name)) ?? [];
  const totalErrors = Object.values(typeErrors).reduce((a, b) => a + b, 0);
  const passed = run?.tests.filter((t) => t.ok).length ?? 0;
  const dirty = files.filter((f) => f.text !== f.saved).length;

  return (
    <div className="studio">
      <header className="view-head">
        <h2>Editor</h2>
        <span className="muted small tnum">
          {typesInfo
            ? `House scope: ${typesInfo.entities.toLocaleString()} entities, ${typesInfo.operable} operable · ${totalErrors} type error${totalErrors === 1 ? "" : "s"}`
            : "loading types…"}
          {run && ` · tests ${passed}/${run.tests.length}`}
          {dirty > 0 && ` · ${dirty} unsaved`}
        </span>
      </header>
      {loadError && <div className="banner">Studio unavailable: {loadError}</div>}
      {typesInfo && !typesInfo.toolkit && (
        <div className="banner">The add-on was built without its type declarations: the editor cannot check "teobeanie" imports.</div>
      )}
      {notice && <div className={notice.kind === "ok" ? "studio-notice" : "studio-notice bad-text"}>{notice.text}</div>}

      <div className="studio-grid">
        <aside className="studio-files">
          <h3 className="studio-files-head">This house</h3>
          {files.length === 0 && <p className="muted small">No rule files yet.</p>}
          {files.map((f) => (
            <button
              key={f.name}
              className={f.name === active && lib === null ? "studio-file active" : "studio-file"}
              onClick={() => open(f.name)}
              title={f.name}
            >
              <span className={isTest(f.name) ? "studio-file-name muted" : "studio-file-name"}>{f.name}</span>
              {f.text !== f.saved && <span className="studio-dot" title="unsaved" />}
              {(typeErrors[f.name] ?? 0) > 0 && <span className="bad-text small">{typeErrors[f.name]}</span>}
            </button>
          ))}
          <form
            className="studio-new"
            onSubmit={(e) => {
              e.preventDefault();
              newRule();
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new-rule-name" aria-label="new rule name" />
            <button type="submit">New rule</button>
          </form>
          <h3 className="studio-files-head">Packages</h3>
          {libFiles?.length === 0 && <p className="muted small">No packages in the config folder.</p>}
          {(libFiles ?? []).map((f) => {
            const used = instances.filter((i) => f.ids.includes(i.heuristic)).length;
            return (
              <button
                key={f.key}
                className={f.key === lib ? "studio-file active" : "studio-file"}
                onClick={() => setLib(f.key)}
                title={`packages/${f.key}: ${originLabel(f)}, read-only here`}
              >
                <span className={isTest(f.name) ? "studio-file-name muted" : "studio-file-name"}>{f.key}</span>
                {f.pkg.modified && !isTest(f.name) && <span className="muted small">changed</span>}
                {used > 0 && <span className="muted small tnum">{used} in use</span>}
              </button>
            );
          })}
        </aside>

        <section className="studio-editor">
          <div className="toolbar">
            <span className="small tnum">{libFile ? `packages/${libFile.key} · ${originLabel(libFile)}, read-only` : (activeFile?.name ?? "no file")}</span>
            {libFile ? (
              !isTest(libFile.name) &&
              <button
                onClick={() => {
                  const base = libFile.name.replace(/\.ts$/, "");
                  create(`${base}-custom.ts`, copyForConfig(libFile, "custom").text);
                }}
                title="Copy into the config folder as a new file, with its own ids, to change it"
              >
                Copy to edit
              </button>
            ) : (
              <button onClick={() => void save()} disabled={!activeFile || activeFile.text === activeFile.saved}>
                Save
              </button>
            )}
            {activeFile && !isTest(activeFile.name) && (
              <button onClick={() => create(`${baseOf(activeFile.name)}.test.ts`, testTemplate(baseOf(activeFile.name)))}>
                {files.some((f) => f.name === `${baseOf(activeFile.name)}.test.ts`) ? "Open test" : "Add test"}
              </button>
            )}
          </div>
          <div ref={host} className="studio-monaco" />
        </section>

        <aside className="studio-results">
          {libFile && (
            <div className="studio-lib">
              <h3>{libFile.pkg.title}</h3>
              <p className="small">
                <code>{libFile.pkg.name}</code> {libFile.pkg.version} · {originLabel(libFile)}
                {libFile.pkg.description && <> · {libFile.pkg.description}</>}
              </p>
              {libFile.ids.map((id) => (
                <div key={id}>
                  <h3>
                    <code>{id}</code> in this house
                  </h3>
                  <InHouse ids={[id]} instances={instances} />
                </div>
              ))}
            </div>
          )}
          {!libFile && result && "error" in result && <div className="banner">{result.error}</div>}
          {run && activeFile && (
            <>
              <h3>{isTest(activeFile.name) ? "Tests" : "This file"}</h3>
              {run.loads
                .filter((l) => baseOf(l.file) === baseOf(activeFile.name))
                .map((l) =>
                  l.ok ? (
                    l.heuristics.map((h) => (
                      <dl key={h.id} className="kv studio-load">
                        <dt>{h.kind}</dt>
                        <dd>
                          <code>{h.id}</code>
                        </dd>
                        <dt>owns</dt>
                        <dd className="small">{h.owns ? h.owns.join(", ") || "nothing" : h.note}</dd>
                        <dt>watches</dt>
                        <dd className="small">{h.watches ? h.watches.join(", ") || "nothing" : "—"}</dd>
                        <dt>in use</dt>
                        <dd>
                          <InHouse ids={[h.id]} instances={instances} />
                        </dd>
                      </dl>
                    ))
                  ) : (
                    <div key={l.file} className="studio-test bad">
                      <span className="bad-text">✗</span> does not load: {l.error}
                    </div>
                  ),
                )}
              {testsFor(activeFile.name).map((t, i) => (
                <div key={i} className={t.ok ? "studio-test" : "studio-test bad"}>
                  <span className={t.ok ? "nr-match" : "bad-text"}>{t.ok ? "✓" : "✗"}</span> {t.name}
                  {t.error && <div className="small studio-error">{t.error}</div>}
                </div>
              ))}
              {testsFor(activeFile.name).length === 0 && !isTest(activeFile.name) && (
                <p className="muted small">No tests for this file yet. “Add test” scripts a timeline against the simulator.</p>
              )}
              <h3>All files</h3>
              <p className="small muted tnum">
                {run.loads.filter((l) => l.ok).length}/{run.loads.length} load · {passed}/{run.tests.length} tests pass · {Math.round(run.ms)} ms
              </p>
              {run.loads
                .filter((l) => !l.ok)
                .map((l) => (
                  <div key={l.file} className="small bad-text">
                    {l.file}: {"error" in l ? l.error : ""}
                  </div>
                ))}
              {run.tests
                .filter((t) => !t.ok && baseOf(t.file) !== baseOf(activeFile.name))
                .map((t, i) => (
                  <div key={i} className="small bad-text">
                    {t.file} · {t.name}
                  </div>
                ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
