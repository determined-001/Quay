"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, CheckoutError, describeError, type ApiKeyInfo, type ApiKeyCreated } from "../../lib/api";

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtRelative(ms: number | null): string {
  if (ms === null) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return fmtDate(ms);
}

// ── Reveal-once key banner ───────────────────────────────────────────────────

function RevealBanner({
  created,
  onDismiss,
}: {
  created: ApiKeyCreated;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="reveal-banner"
      role="alert"
      aria-live="assertive"
      style={{
        background: "var(--clr-surface-raised, #1a2030)",
        border: "1px solid var(--clr-accent, #6c8ebf)",
        borderRadius: 8,
        padding: "16px 20px",
        marginBottom: 16,
      }}
    >
      <p style={{ marginBottom: 8, fontWeight: 600 }}>
        ⚠ Copy your key now — it will not be shown again
      </p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <code
          className="mono"
          style={{
            wordBreak: "break-all",
            fontSize: "0.85em",
            flex: "1 1 auto",
          }}
        >
          {created.key}
        </code>
        <button className="btn btn--ghost" onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? "Copied!" : "Copy"}
        </button>
        <button className="btn btn--ghost" onClick={onDismiss} style={{ flexShrink: 0 }}>
          Done
        </button>
      </div>
      <p className="muted" style={{ marginTop: 8, fontSize: "0.8em" }}>
        Scopes: {created.scopes.join(", ")}
      </p>
    </div>
  );
}

// ── Key table ────────────────────────────────────────────────────────────────

function KeyTable({
  keys,
  onRevoke,
  revoking,
}: {
  keys: ApiKeyInfo[];
  onRevoke: (id: string) => void;
  revoking: Set<string>;
}) {
  return (
    <table className="table" aria-label="API keys">
      <thead>
        <tr>
          <th>Name</th>
          <th>Prefix</th>
          <th>Scopes</th>
          <th>Last used</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id} style={{ opacity: k.revokedAt ? 0.45 : 1 }}>
            <td>{k.name}</td>
            <td>
              <span className="mono muted">{k.prefix}…</span>
            </td>
            <td>
              <span className="mono" style={{ fontSize: "0.78em" }}>
                {k.scopes.join(", ")}
              </span>
            </td>
            <td className="muted" style={{ whiteSpace: "nowrap" }}>
              {fmtRelative(k.lastUsedAt)}
            </td>
            <td className="muted" style={{ whiteSpace: "nowrap" }}>
              {fmtDate(k.createdAt)}
            </td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {k.revokedAt ? (
                <span className="muted" style={{ fontSize: "0.8em" }}>
                  revoked {fmtDate(k.revokedAt)}
                </span>
              ) : (
                <button
                  className="linkbtn"
                  onClick={() => onRevoke(k.id)}
                  disabled={revoking.has(k.id)}
                  style={{ color: "var(--clr-danger, #e05c5c)" }}
                  aria-label={`Revoke key ${k.name}`}
                >
                  {revoking.has(k.id) ? "Revoking…" : "Revoke"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [defaultScopes, setDefaultScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Create-key form
  const [name, setName] = useState("");
  const [keyEnv, setKeyEnv] = useState<"live" | "test">("live");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const scopesInitialised = useRef(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reveal-once state
  const [newKey, setNewKey] = useState<ApiKeyCreated | null>(null);

  // Revoke state
  const [revoking, setRevoking] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const { keys: fresh, availableScopes: av, defaultScopes: def } = await api.listApiKeys();
      setKeys(fresh);
      setAvailableScopes(av);
      setDefaultScopes(def);
      // Initialise checkbox selection to default scopes on first load.
      if (!scopesInitialised.current) {
        setSelectedScopes(new Set(def));
        scopesInitialised.current = true;
      }
      setFetchError(null);
    } catch (e) {
      setFetchError(
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to load API keys. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleScope(scope: string) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function create() {
    setActionError(null);
    if (!name.trim()) {
      setActionError("Enter a name for the key.");
      return;
    }
    if (selectedScopes.size === 0) {
      setActionError("Select at least one scope.");
      return;
    }
    setCreating(true);
    try {
      const created = await api.createApiKey({
        name: name.trim(),
        env: keyEnv,
        scopes: [...selectedScopes].join(","),
      });
      setNewKey(created);
      setName("");
      setSelectedScopes(new Set(defaultScopes));
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to create the API key. Please try again.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Any server using it will stop working immediately.")) return;
    setRevoking((prev) => new Set([...prev, id]));
    try {
      await api.revokeApiKey(id);
      await refresh();
    } catch (e) {
      setActionError(
        e instanceof CheckoutError ? describeError(e) : "Failed to revoke the key. Please try again.",
      );
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const activeKeys = keys.filter((k) => k.revokedAt === null);
  const revokedKeys = keys.filter((k) => k.revokedAt !== null);

  return (
    <>
      {/* Reveal-once banner */}
      {newKey && (
        <RevealBanner created={newKey} onDismiss={() => setNewKey(null)} />
      )}

      {/* Create key form */}
      <section className="panel">
        <h2>New API key</h2>
        <div className="field">
          <label htmlFor="key-name">Key name</label>
          <input
            id="key-name"
            placeholder="My server · production"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="key-env">Environment</label>
            <select
              id="key-env"
              value={keyEnv}
              onChange={(e) => setKeyEnv(e.target.value as "live" | "test")}
            >
              <option value="live">live (ak_live_…)</option>
              <option value="test">test (ak_test_…)</option>
            </select>
          </div>
        </div>

        {/* Scope checkboxes */}
        {availableScopes.length > 0 && (
          <fieldset
            style={{
              border: "1px solid var(--clr-border, #2a3448)",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 12,
            }}
          >
            <legend style={{ fontSize: "0.85em", padding: "0 4px" }}>Scopes</legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 20px" }}>
              {availableScopes.map((scope) => (
                <label
                  key={scope}
                  style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.has(scope)}
                    onChange={() => toggleScope(scope)}
                    aria-label={scope}
                  />
                  <span className="mono" style={{ fontSize: "0.85em" }}>
                    {scope}
                    {scope === "offramp:initiate" && (
                      <span
                        className="muted"
                        style={{ fontSize: "0.8em", marginLeft: 4 }}
                        title="Allows triggering cash-outs — off by default because it moves money"
                      >
                        (moves money)
                      </span>
                    )}
                    {scope === "api-keys:manage" && (
                      <span
                        className="muted"
                        style={{ fontSize: "0.8em", marginLeft: 4 }}
                        title="Allows creating, listing and revoking other API keys — off by default"
                      >
                        (can mint more keys)
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <button className="btn btn--primary btn--block" onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create key"}
        </button>
        {actionError && <div className="err">{actionError}</div>}
      </section>

      {/* Key list */}
      <section className="panel">
        <h2>Active keys</h2>
        {loading && (
          <div className="muted" style={{ padding: "12px 0" }}>
            Loading…
          </div>
        )}
        {!loading && fetchError && (
          <div className="error-banner">
            <p className="error-banner__text">{fetchError}</p>
            <button className="btn btn--ghost" onClick={refresh}>
              Retry
            </button>
          </div>
        )}
        {!loading && !fetchError && activeKeys.length === 0 && (
          <div className="empty">No active keys. Create one above to get programmatic access.</div>
        )}
        {!loading && !fetchError && activeKeys.length > 0 && (
          <KeyTable keys={activeKeys} onRevoke={revoke} revoking={revoking} />
        )}

        {/* Revoked keys — collapsed by default */}
        {revokedKeys.length > 0 && (
          <details style={{ marginTop: 16 }}>
            <summary
              className="muted"
              style={{ cursor: "pointer", fontSize: "0.85em", userSelect: "none" }}
            >
              {revokedKeys.length} revoked {revokedKeys.length === 1 ? "key" : "keys"}
            </summary>
            <div style={{ marginTop: 8 }}>
              <KeyTable keys={revokedKeys} onRevoke={revoke} revoking={revoking} />
            </div>
          </details>
        )}
      </section>
    </>
  );
}
