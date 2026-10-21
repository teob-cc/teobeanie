import type { CatalogueEntry } from "../api";
import type { HeuristicInstance } from "../decisions";
import { expected, type ParamField } from "../../../src/kernel/params";

/** The patterns in the order docs/heuristics.md tells them. */
const PATTERNS = ["trigger", "hold", "momentary", "button", "command", "notice", "guard"];

/**
 * The library as a catalogue: each heuristic with its pattern, what it does, what it
 * promises, its parameters, and how many instances this house runs; the house's own
 * after the starter packages' ones, marked, and a starter package the house changed
 * marked too. "Add an instance" opens the editor; the source opens in the Studio,
 * read-only for a package, with "Copy to edit" to fork it.
 */
export function Catalogue({
  entries,
  instances,
  onAdd,
  onSource,
}: {
  entries: CatalogueEntry[];
  instances: HeuristicInstance[];
  onAdd: (entry: CatalogueEntry) => void;
  onSource?: (entry: CatalogueEntry) => void;
}) {
  const rank = (e: CatalogueEntry) => (e.pattern === undefined ? PATTERNS.length : PATTERNS.indexOf(e.pattern));
  const starter = entries.filter((e) => !e.own).sort((a, b) => rank(a) - rank(b));
  const own = entries.filter((e) => e.own);
  const groups = [
    ...[...new Set(starter.map((e) => e.pattern ?? "other"))].map((p) => ({ title: `${p} pattern`, list: starter.filter((e) => (e.pattern ?? "other") === p) })),
    ...(own.length > 0 ? [{ title: "Yours", list: own }] : []),
  ];
  return (
    <>
      {groups.map((g) => (
        <section key={g.title}>
          <div className="day-div">{g.title}</div>
          <div className="hgrid">
            {g.list.map((e) => (
              <CatalogueCard key={e.id} e={e} used={instances.filter((i) => i.heuristic === e.id).length} onAdd={onAdd} onSource={onSource} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function CatalogueCard({ e, used, onAdd, onSource }: { e: CatalogueEntry; used: number; onAdd: (e: CatalogueEntry) => void; onSource?: (e: CatalogueEntry) => void }) {
  return (
    <div className="hcard lib-card">
      <div className="hcard-top">
        <span className="hcard-name">{e.title}</span>
        <span>
          {e.own && <span className="chip chip-on">yours</span>}
          {!e.own && e.package?.modified && (
            <span className="chip chip-on" title="A starter package the house changed: an update never overwrites it">
              changed
            </span>
          )}{" "}
          {e.pattern && <span className="chip chip-off">{e.pattern}</span>}
        </span>
      </div>
      <div className="small muted">
        <code>{e.id}</code>
        {e.package && (
          <>
            {" "}
            · {e.package.origin === "starter" ? "starter " : ""}package <code>{e.package.name}</code> {e.package.version}
          </>
        )}
        {e.rule && " · rule"}
        {used > 0 ? ` · ${used} in this house` : " · not used here"}
      </div>
      <div className="small">{e.description}</div>
      {e.guarantees && (
        <div className="small lib-promise">
          <b>Promises:</b> {e.guarantees}
        </div>
      )}
      <details className="lib-params small">
        <summary>{e.params === null ? "Settings: as JSON (no description)" : `Settings: ${e.params.length}`}</summary>
        {e.params !== null && <ParamList fields={e.params} />}
      </details>
      <div className="lib-actions">
        <button className="tab active" onClick={() => onAdd(e)}>
          Add an instance
        </button>
        {onSource && (
          <button
            className="tab"
            onClick={() => onSource(e)}
            title={e.package === undefined ? "Open its file in the Studio" : "Read-only in the Studio; Copy to edit makes a version of your own"}
          >
            {e.package === undefined ? "Open in Studio" : "Source · copy to config"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Parameters with what each takes, its default and what it is for; nested ones indented. */
function ParamList({ fields }: { fields: ParamField[] }) {
  return (
    <dl className="kv lib-kv">
      {fields.map((f) => (
        <div key={f.name} className="lib-param">
          <dt>
            <code>{f.name}</code>
            {!f.required && <span className="muted"> optional</span>}
          </dt>
          <dd>
            {f.doc && <div>{f.doc}</div>}
            <div className="muted">
              {f.kind === "object" || f.kind === "texts" || f.kind === "oneOf" ? f.kind : expected(f)}
              {f.default !== undefined && ` · default ${JSON.stringify(f.default)}`}
            </div>
            {(f.kind === "object" || f.kind === "texts") && f.fields && <ParamList fields={f.fields} />}
            {f.kind === "oneOf" &&
              f.alternatives?.map((a) => (
                <div key={a.name}>
                  <i>{a.name}</i>
                  {a.fields && <ParamList fields={a.fields} />}
                </div>
              ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
