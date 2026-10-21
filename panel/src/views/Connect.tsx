import { useCallback, useEffect, useState } from "react";
import { api, type AgentToken, type ConnectInfo } from "../api";
import { claudeLine, jsonSnippet, mcpUrl } from "../connectLines";
import { fmtDay, fmtTime } from "../format";
import { originLabel } from "../origin";

const when = (at: number | null): string => (at === null ? "never" : `${fmtDay(at)} ${fmtTime(at)}`);

/** A block of text to copy, with a button where the browser lets the page copy. */
function Paste({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="connect-paste">
      <div className="connect-paste-head">
        <span className="muted small">{label}</span>
        {navigator.clipboard !== undefined && (
          <button className="tab" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/**
 * Connect an agent: mint a named token, paste one line into the agent, revoke the token
 * when the agent should stop. The token is shown once; only its hash is kept.
 */
export function Connect() {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ token: string; info: AgentToken } | null>(null);
  const [host, setHost] = useState(() => window.location.hostname);

  const load = useCallback(() => {
    api
      .connect()
      .then((i) => {
        setInfo(i);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const mint = () => {
    if (name.trim() === "") {
      setError("Give the token a name first, such as the agent and the machine it runs on.");
      return;
    }
    setBusy(true);
    setError(null);
    api
      .mintAgentToken(name.trim())
      .then((m) => {
        setMinted(m);
        setName("");
        load();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const revoke = (t: AgentToken) => {
    if (!window.confirm(`Revoke "${t.name}"? The agent that uses it is refused from its next request on.`)) return;
    api
      .revokeAgentToken(t.id)
      .then(() => {
        if (minted?.info.id === t.id) setMinted(null);
        load();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const port = info?.port ?? info?.defaultPort ?? 8199;
  const url = mcpUrl(host.trim() || window.location.hostname, port);

  return (
    <section>
      <div className="view-head">
        <h2>Connect an agent</h2>
      </div>
      <p className="muted">
        An AI agent such as Claude Code reaches Teobeanie's MCP tools on the add-on's agent port with a token of its own. The tools are read-only, and every call is
        journaled with the token's name. Mint one token per agent, and revoke it when the agent should stop.
      </p>
      {error && <p className="bad-text">{error}</p>}
      {info?.port === null && (
        <p className="banner">
          The agent port is closed: it has no host port in the add-on's Network section (Settings → Add-ons → Teobeanie → Configuration → Network). Set one, such as{" "}
          {info.defaultPort}, and restart the add-on. The bridge through ingress still works without it.
        </p>
      )}
      {info?.source === "default" && <p className="muted small">The add-on's network info could not be read: the lines below assume the default port {info.defaultPort}.</p>}

      <div className="toolbar">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && mint()}
          placeholder="name it, e.g. Claude Code on my laptop"
          aria-label="token name"
          maxLength={80}
        />
        <button className="tab active" onClick={mint} disabled={busy}>
          {busy ? "…" : "Mint a token"}
        </button>
      </div>

      {minted && (
        <div className="banner connect-minted">
          <p>
            <strong>{minted.info.name}</strong>: copy the token now. It is shown only this once; Teobeanie keeps only its hash.
          </p>
          <label className="connect-host">
            <span className="muted small">Home Assistant's address, as your agent's machine reaches it (LAN or tailnet)</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} aria-label="Home Assistant host" />
          </label>
          {window.location.protocol === "https:" && (
            <p className="muted small">
              This page came over HTTPS, maybe through a proxy or Home Assistant Cloud. The agent port is plain HTTP on your LAN or tailnet: put Home Assistant's LAN
              address or tailnet name above if the agent cannot connect.
            </p>
          )}
          <Paste label="Claude Code: run this in a terminal" text={claudeLine(url, minted.token)} />
          <Paste label="Other MCP clients: their JSON config" text={jsonSnippet(url, minted.token)} />
          <Paste label="The token alone" text={minted.token} />
          <button className="tab" onClick={() => setMinted(null)}>
            Done, hide it
          </button>
        </div>
      )}

      <div className="view-head">
        <h2>Tokens</h2>
        <span className="muted small">{info ? `${info.tokens.length}` : ""}</span>
      </div>
      {info && info.tokens.length === 0 && <p className="muted">No agent tokens yet.</p>}
      {info && info.tokens.length > 0 && (
        <table className="connect-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>By</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {info.tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="tnum">{when(t.createdAt)}</td>
                <td>{originLabel(t.by)}</td>
                <td className="tnum" title="since the add-on started">
                  {when(t.lastUsedAt)}
                </td>
                <td>
                  <button className="tab" onClick={() => revoke(t)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="view-head">
        <h2>Fallback: the bridge</h2>
      </div>
      <p className="muted small">
        Without the agent port, an agent can still connect through Home Assistant ingress with the stdio bridge, scripts/teobeanie-mcp-bridge.mjs, and a
        long-lived token of a Home Assistant admin. docs/getting-started.md has the steps.
      </p>
    </section>
  );
}
