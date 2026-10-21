import { useId, useMemo, useState } from "react";
import { api, type CatalogueEntry, type EditOutcome, type InstanceConfig, type InstanceMode, type PickerEntity } from "../api";
import type { ParamField, ParamSpec } from "../../../src/kernel/params";
import {
  alternativeOf,
  blank,
  countSet,
  draftOf,
  draftProblems,
  newDraft,
  numberFrom,
  paramsFromJson,
  pickable,
  placeholderOf,
  problemsAt,
  problemsUnder,
  setField,
  splitFields,
  toInstance,
  unitOf,
  valueFrom,
  valueText,
  type Draft,
} from "../instanceForm";

export const MODE_EFFECT: Record<InstanceMode, string> = {
  off: "It stops: no decisions, nothing sent.",
  shadow: "It decides and journals, but switches and sends nothing.",
  active: "It switches its entities and sends its notices.",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What every field needs besides its own value: the problems to show and the entities to pick from. */
interface Ctx {
  problems: string[];
  entities: PickerEntity[];
}

/**
 * One instance of heuristics.json as a form: its id (new ones), mode, params from the
 * heuristic's schema (as JSON for a heuristic without one), and its notice settings.
 * The draft is checked as the server checks it while it is typed; saving asks first,
 * then heuristics.json is changed in place and reloaded, all or nothing, and the change
 * is journaled with who made it. A rejected reload leaves the file as it was and the
 * editor open with the reason.
 */
export function InstanceEditor({
  entry,
  initial,
  taken,
  entities,
  onDone,
  onCancel,
}: {
  entry: CatalogueEntry;
  /** The instance as heuristics.json has it; absent: a new one. */
  initial?: InstanceConfig;
  /** The ids this heuristic's instances already have. */
  taken: string[];
  entities: PickerEntity[];
  /** Saved or removed: the reload's outcome. */
  onDone: (outcome: EditOutcome, what: string) => void;
  onCancel: () => void;
}) {
  const isNew = initial === undefined;
  const key = initial ? `${initial.heuristic}/${initial.id}` : undefined;
  const [draft, setDraft] = useState<Draft>(() => (initial ? draftOf(initial) : newDraft(entry)));
  // A heuristic without a schema: its params as JSON text, checked by the reload.
  const [json, setJson] = useState(() => JSON.stringify(initial?.params ?? {}, null, 2));
  const [confirm, setConfirm] = useState<"save" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  const parsed = entry.params === null ? paramsFromJson(json) : null;
  const current: Draft = parsed !== null && "params" in parsed ? { ...draft, params: parsed.params } : draft;
  const problems = [...draftProblems(entry, current, isNew ? taken : null), ...(parsed !== null && "problem" in parsed ? [parsed.problem] : [])];
  const shown = problems.length > 0 ? problems : serverProblems;
  const ctx: Ctx = { problems: shown, entities };
  const set = (patch: Partial<Draft>) => {
    setRejected(null);
    setServerProblems([]);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const submit = (what: "save" | "remove") => {
    setBusy(true);
    setRejected(null);
    const inst = toInstance(current);
    const call =
      what === "remove" ? api.removeInstance(key!)
      : isNew ? api.addInstance(inst)
      : api.saveInstance(key!, { mode: inst.mode, params: inst.params, ...(inst.alerts ? { alerts: true } : {}), ...(inst.notifyPerHour !== undefined ? { notifyPerHour: inst.notifyPerHour } : {}), ...(inst.commandHelp ? { commandHelp: inst.commandHelp } : {}) });
    call
      .then((o) => {
        setConfirm(null);
        if (o.ok) return onDone(o, what === "remove" ? `Removed ${key}` : isNew ? `Added ${inst.heuristic}/${inst.id}` : `Saved ${key}`);
        if ("problems" in o) setServerProblems(o.problems);
        setRejected(o.error ?? "?");
      })
      .catch((e) => setRejected(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <header className="view-head">
        <button className="tab" onClick={onCancel}>
          ← Back
        </button>
        <h2>{isNew ? `New ${entry.title.toLowerCase()}` : key}</h2>
        <span className="muted small">
          {entry.title}
          {entry.own && " · yours"}
        </span>
      </header>

      <div className="card ied">
        {isNew && (
          <div className="ied-field">
            <label className="ied-label" htmlFor="ied-id">
              <b>Id</b>
            </label>
            <div className="muted small">Our name for this use: lower case letters, digits and dashes. It appears in the panel, the log and Telegram, and cannot be changed later.</div>
            <div className="ied-input">
              <input id="ied-id" value={draft.id} onChange={(e) => set({ id: e.target.value.trim() })} placeholder="back-door" autoFocus />
            </div>
            <Problems list={problemsAt(shown, "id")} />
          </div>
        )}

        <div className="ied-field">
          <span className="ied-label">
            <b>Mode</b>
          </span>
          <div className="ied-input">
            <span className="seg" role="radiogroup" aria-label="mode">
              {(["off", "shadow", "active"] as const).map((m) => (
                <button key={m} role="radio" aria-checked={draft.mode === m} className={draft.mode === m ? "tab active" : "tab"} onClick={() => set({ mode: m })}>
                  {m}
                </button>
              ))}
            </span>
            <span className="muted small">{MODE_EFFECT[draft.mode]}</span>
          </div>
          <Problems list={problemsAt(shown, "mode")} />
        </div>

        <h3>Settings</h3>
        {entry.params === null ? (
          <div className="ied-field">
            <div className="muted small">
              {entry.title} has no description of its settings: they are edited as JSON, and the reload says whether they work.
            </div>
            <textarea className="ied-json" value={json} onChange={(e) => {
                setRejected(null);
                setJson(e.target.value);
              }} spellCheck={false} aria-label="params as JSON" />
            <Problems list={problemsAt(shown, "params")} />
          </div>
        ) : entry.params.length === 0 ? (
          <p className="muted small">It has no settings.</p>
        ) : (
          <Fields fields={entry.params} value={draft.params} path="params" onChange={(params) => set({ params })} ctx={ctx} />
        )}

        <details className="ied-optional" open={draft.alerts || draft.notifyPerHour !== undefined || Object.keys(draft.commandHelp).length > 0}>
          <summary>Notices and the bot's menu</summary>
          <div className="ied-field">
            <label className="ied-input">
              <input type="checkbox" checked={draft.alerts} onChange={(e) => set({ alerts: e.target.checked })} />
              <span>
                <b>alerts</b> <span className="muted small">also send its notices to the alerts chat</span>
              </span>
            </label>
            <Problems list={problemsAt(shown, "alerts")} />
          </div>
          <div className="ied-field">
            <span className="ied-label">
              <code>notifyPerHour</code>
            </span>
            <div className="muted small">The most notices it may send in an hour. Too low silences a real warning.</div>
            <div className="ied-input">
              <input
                value={draft.notifyPerHour === undefined ? "" : String(draft.notifyPerHour)}
                onChange={(e) => set({ notifyPerHour: numberFrom(e.target.value) })}
                placeholder={String(entry.notifyPerHour)}
                inputMode="numeric"
              />
              <span className="ied-unit">per hour</span>
            </div>
            <Problems list={shown.filter((p) => p.startsWith("notifyPerHour"))} />
          </div>
          <CommandHelp value={draft.commandHelp} onChange={(commandHelp) => set({ commandHelp })} />
          <Problems list={problemsAt(shown, "commandHelp")} />
        </details>

        <details className="ied-optional">
          <summary>As heuristics.json will have it</summary>
          <pre className="card-raw">{JSON.stringify(toInstance(current), null, 2)}</pre>
        </details>
      </div>

      {shown.length > 0 && (
        <div className="banner">
          {shown.length === 1 ? "One thing to fix" : `${shown.length} things to fix`} before it can be saved:
          <ul className="ied-problems small">
            {shown.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {rejected !== null && serverProblems.length === 0 && (
        <div className="banner">
          The config was rejected, nothing changed: <code>{rejected}</code>
        </div>
      )}

      <div className="ied-actions">
        <span className="pause">
          {!isNew && (
            <button className="tab" onClick={() => setConfirm("remove")} disabled={busy}>
              Remove…
            </button>
          )}{" "}
          <button className="tab" onClick={onCancel} disabled={busy}>
            Cancel
          </button>{" "}
          <button className="tab active" onClick={() => setConfirm("save")} disabled={busy || problems.length > 0}>
            {isNew ? "Add instance" : "Save"}
          </button>
          {confirm !== null && (
            <div className="pause-pop" role="dialog" aria-label={confirm === "remove" ? `remove ${key}` : "save"}>
              <p>
                {confirm === "remove"
                  ? `Remove ${key}? It stops, and its line goes from heuristics.json; its history stays in the journal.`
                  : isNew
                    ? `Add ${draft.heuristic}/${draft.id} in ${draft.mode}? ${MODE_EFFECT[draft.mode]}`
                    : `Save ${key}? It restarts with the new settings. ${MODE_EFFECT[draft.mode]}`}
              </p>
              <p className="muted small">heuristics.json is changed and reloaded; the change is journaled with your name.</p>
              <div className="pause-actions">
                <button className="tab" onClick={() => setConfirm(null)} disabled={busy}>
                  Cancel
                </button>
                <button className="tab active" onClick={() => submit(confirm)} disabled={busy}>
                  {busy ? "…" : confirm === "remove" ? "Remove" : isNew ? "Add" : "Save"}
                </button>
              </div>
            </div>
          )}
        </span>
      </div>
    </div>
  );
}

function Problems({ list }: { list: string[] }) {
  return (
    <>
      {list.map((p) => (
        <div key={p} className="bad-text small">
          {p}
        </div>
      ))}
    </>
  );
}

/** An object's fields: the required ones, then the optional ones collapsed (open when one is set). */
function Fields({ fields, value, path, onChange, ctx }: { fields: ParamField[]; value: unknown; path: string; onChange: (v: Record<string, unknown>) => void; ctx: Ctx }) {
  const { required, optional } = splitFields(fields);
  const [open] = useState(() => countSet(optional, value) > 0);
  const set = (f: ParamField, v: unknown) => {
    // A messages object with nothing replaced is no messages object.
    const empty = f.kind === "texts" && isObject(v) && Object.keys(v).length === 0;
    onChange(setField(value, f.name, empty ? undefined : v));
  };
  const obj = isObject(value) ? value : {};
  const field = (f: ParamField) => <Field key={f.name} f={f} value={obj[f.name]} path={`${path}.${f.name}`} onChange={(v) => set(f, v)} ctx={ctx} />;
  const hidden = optional.reduce((n, f) => n + problemsAt(ctx.problems, `${path}.${f.name}`).length + problemsUnder(ctx.problems, `${path}.${f.name}`), 0);
  return (
    <div className="ied-fields">
      {required.map(field)}
      {optional.length > 0 &&
        (required.length === 0 ? (
          optional.map(field)
        ) : (
          <details className="ied-optional" open={open || hidden > 0}>
            <summary>
              Optional: {countSet(optional, value)} of {optional.length} set
              {hidden > 0 && <span className="bad-text"> · {hidden} to fix</span>}
            </summary>
            {optional.map(field)}
          </details>
        ))}
      <Problems list={ctx.problems.filter((p) => isUnknownHere(p, path, fields))} />
    </div>
  );
}

/** A problem about a key of this object that none of its fields is ("params.colour: unknown, ..."). */
function isUnknownHere(p: string, path: string, fields: ParamField[]): boolean {
  if (!p.startsWith(`${path}.`)) return false;
  const rest = p.slice(path.length + 1);
  const name = rest.slice(0, rest.indexOf(":"));
  return !/[.[]/.test(name) && !fields.some((f) => f.name === name);
}

/** One parameter: its name, what it is for, its input, its problems. */
function Field({ f, value, path, onChange, ctx }: { f: ParamField; value: unknown; path: string; onChange: (v: unknown) => void; ctx: Ctx }) {
  const nested = f.kind === "object" || f.kind === "oneOf";
  return (
    <div className="ied-field">
      <span className="ied-label">
        <code>{f.name}</code>
        {!f.required && <span className="muted small">optional</span>}
        {nested && !f.required && value !== undefined && (
          <button className="ied-link" onClick={() => onChange(undefined)}>
            leave out
          </button>
        )}
      </span>
      {f.doc && <div className="muted small">{f.doc}</div>}
      {nested && !f.required && value === undefined ? (
        <div className="ied-input">
          <button className="ied-link" onClick={() => onChange(blank(f))}>
            + set {f.name}
          </button>
        </div>
      ) : (
        <Input spec={f} value={value} path={path} onChange={onChange} ctx={ctx} />
      )}
      <Problems list={problemsAt(ctx.problems, path)} />
    </div>
  );
}

/** The input for a value of this spec. */
function Input({ spec, value, path, onChange, ctx }: { spec: ParamSpec; value: unknown; path: string; onChange: (v: unknown) => void; ctx: Ctx }) {
  const placeholder = placeholderOf(spec);
  switch (spec.kind) {
    case "entity":
      return <EntityInput domains={spec.domains} value={value} onChange={onChange} entities={ctx.entities} />;
    case "entities":
      return <ListInput item={{ ...spec, kind: "entity" }} value={value} path={path} onChange={onChange} ctx={ctx} />;
    case "strings":
      return <ListInput item={{ kind: "string", required: true }} value={value} path={path} onChange={onChange} ctx={ctx} placeholder={placeholder} />;
    case "list":
      return <ListInput item={spec.item ?? { kind: "value", required: true }} value={value} path={path} onChange={onChange} ctx={ctx} />;
    case "number":
    case "duration": {
      const bounds = [spec.positive ? "> 0" : spec.min !== undefined ? `≥ ${spec.min}` : "", spec.max !== undefined ? `≤ ${spec.max}` : ""].filter(Boolean).join(", ");
      return (
        <div className="ied-input">
          <input value={value === undefined ? "" : String(value)} onChange={(e) => onChange(numberFrom(e.target.value))} placeholder={placeholder} inputMode="decimal" />
          {unitOf(spec) && <span className="ied-unit">{unitOf(spec)}</span>}
          {bounds && <span className="muted small">{bounds}</span>}
        </div>
      );
    }
    case "bool":
      return spec.required ? (
        <div className="ied-input">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        </div>
      ) : (
        <div className="ied-input">
          <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
            <option value="">default{spec.default !== undefined ? ` (${spec.default ? "yes" : "no"})` : ""}</option>
            <option value="true">yes</option>
            <option value="false">no</option>
          </select>
        </div>
      );
    case "time":
      return (
        <div className="ied-input">
          <input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value.trim() === "" ? undefined : e.target.value.trim())} placeholder={placeholder ?? (spec.seconds ? "HH:MM:SS" : "HH:MM")} />
          <span className="muted small">house time, 24 h</span>
        </div>
      );
    case "text":
      return (
        <div className="ied-input ied-text">
          <textarea rows={2} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} placeholder={placeholder} />
          {spec.slots && spec.slots.length > 0 && <span className="muted small">filled in: {spec.slots.map((s) => `{${s}}`).join(" ")}</span>}
        </div>
      );
    case "string":
      return (
        <div className="ied-input">
          <input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} placeholder={placeholder} />
        </div>
      );
    case "value":
      return (
        <div className="ied-input">
          <input value={valueText(value)} onChange={(e) => onChange(valueFrom(e.target.value))} placeholder={placeholder ?? 'on, or {"temperature": 21}'} />
          <span className="muted small">a state, or attributes as JSON</span>
        </div>
      );
    case "texts":
    case "object":
      return (
        <div className="ied-nest">
          <Fields fields={spec.fields ?? []} value={value} path={path} onChange={onChange} ctx={ctx} />
        </div>
      );
    case "oneOf": {
      const alternatives = spec.alternatives ?? [];
      const i = alternativeOf(spec, value);
      return (
        <div className="ied-nest">
          <div className="ied-input">
            <select value={i} onChange={(e) => onChange(Number(e.target.value) < 0 ? {} : blank(alternatives[Number(e.target.value)]!))} aria-label="which kind">
              <option value={-1}>choose…</option>
              {alternatives.map((a, n) => (
                <option key={a.name} value={n}>
                  {a.name}
                  {a.doc ? `: ${a.doc}` : ""}
                </option>
              ))}
            </select>
          </div>
          {i >= 0 && <Fields key={i} fields={alternatives[i]!.fields ?? []} value={value} path={path} onChange={onChange} ctx={ctx} />}
        </div>
      );
    }
  }
}

/** A list: one input per item, a button to add one. */
function ListInput({ item, value, path, onChange, ctx, placeholder }: { item: ParamSpec; value: unknown; path: string; onChange: (v: unknown) => void; ctx: Ctx; placeholder?: string }) {
  const list = Array.isArray(value) ? value : [];
  // A cleared item stays a row to fill in (null in JSON would be no better).
  const setAt = (i: number, v: unknown) => onChange(list.map((x, n) => (n === i ? (v ?? "") : x)));
  return (
    <div className="ied-list">
      {list.length === 0 && placeholder && <div className="muted small">default: {placeholder}</div>}
      {list.map((x, i) => (
        <div key={i} className="ied-list-row">
          <div>
            <Input spec={item} value={x} path={`${path}[${i}]`} onChange={(v) => setAt(i, v)} ctx={ctx} />
            <Problems list={problemsAt(ctx.problems, `${path}[${i}]`)} />
          </div>
          <button className="ied-link" onClick={() => onChange(list.filter((_, n) => n !== i))} aria-label="remove" title="remove">
            ✕
          </button>
        </div>
      ))}
      <button className="ied-link" onClick={() => onChange([...list, blank(item) ?? ""])}>
        + add
      </button>
    </div>
  );
}

/** An entity id, picked from the house scope (of the field's domains) or typed. */
function EntityInput({ domains, value, onChange, entities }: { domains?: string[]; value: unknown; onChange: (v: unknown) => void; entities: PickerEntity[] }) {
  const id = useId();
  const options = useMemo(() => pickable(entities, domains), [entities, domains]);
  const text = typeof value === "string" ? value : "";
  const known = entities.find((e) => e.id === text);
  return (
    <div className="ied-input">
      <input
        list={id}
        value={text}
        onChange={(e) => onChange(e.target.value.trim() === "" ? undefined : e.target.value.trim())}
        placeholder={domains ? `${domains[0]}.…` : "domain.name"}
        spellCheck={false}
      />
      <datalist id={id}>
        {options.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name ?? e.id}
          </option>
        ))}
      </datalist>
      {known ? (
        <span className="muted small">
          {known.name ?? ""}
          {known.operate ? " · may switch" : " · watch only"}
        </span>
      ) : (
        text !== "" && <span className="warn-text small">not in the house scope (allowlist.json)</span>
      )}
      {domains && <span className="muted small">{domains.join(" or ")}</span>}
    </div>
  );
}

/** commandHelp: a description per command, for the bot's menu. */
function CommandHelp({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const rename = (from: string, to: string) => onChange(Object.fromEntries(rows.map(([k, v]) => (k === from ? [to, v] : [k, v]))));
  return (
    <div className="ied-field">
      <span className="ied-label">
        <code>commandHelp</code>
      </span>
      <div className="muted small">Its commands' lines in the bot's menu, instead of the heuristic's own.</div>
      {rows.map(([k, v], i) => (
        <div key={i} className="ied-list-row">
          <div className="ied-input">
            <input value={k} onChange={(e) => rename(k, e.target.value)} placeholder="command" aria-label="command" />
            <input value={v} onChange={(e) => onChange({ ...value, [k]: e.target.value })} placeholder="What it does" aria-label="description" />
          </div>
          <button
            className="ied-link"
            onClick={() => onChange(Object.fromEntries(rows.filter(([x]) => x !== k)))}
            aria-label="remove"
            title="remove"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="ied-link" onClick={() => onChange({ ...value, "": "" })} disabled={"" in value}>
        + add
      </button>
    </div>
  );
}
