import React, { useState } from "react";
import { api, setAdminToken, clearAdminToken } from "../api.js";

// Shown when the instance has admin auth enabled (ARBR_ADMIN_KEY) and the
// browser has no valid key stored. Sessionless: the key IS the credential.
export default function Login({ onAuthed }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    setAdminToken(key.trim());
    try {
      await api.status(); // probe with the new token
      onAuthed();
    } catch (e2) {
      clearAdminToken();
      setErr(e2.status === 401 ? "Invalid admin key." : e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gray-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <div className="flex items-baseline gap-0.5">
          <span className="text-xl font-bold tracking-tight text-arbr-charcoal">ARBR</span>
          <span className="text-xl font-bold text-arbr-green-600">.</span>
        </div>
        <p className="mt-1 text-sm text-gray-500">This instance requires the admin key.</p>

        <div className="mt-6">
          <div className="label mb-1">Admin key</div>
          <input
            type="password"
            className="input w-full"
            placeholder="ARBR_ADMIN_KEY…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
        </div>
        {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
        <button type="submit" className="btn-primary mt-4 w-full" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
        <p className="mt-4 text-xs text-gray-400">
          The key is set via the <code>ARBR_ADMIN_KEY</code> environment variable on the server.
        </p>
      </form>
    </div>
  );
}
