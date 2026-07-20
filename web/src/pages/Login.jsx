import React, { useState } from "react";
import { api, setAdminToken, clearAdminToken } from "../api.js";
import { Logo } from "../components/Logo.jsx";

// Shown when the instance requires auth and the browser has no valid
// credential. `mode` (from GET /api/auth/mode) decides which path renders:
//   - "adminkey" (default): the shared ARBR_ADMIN_KEY, sessionless.
//   - "oidc": redirect to the identity provider; a real session cookie follows.
//   - "trusted-header": access is meant to come through IAP/a reverse proxy —
//     reaching this page directly means that layer isn't in front of arbr.
export default function Login({ mode = "adminkey", onAuthed }) {
  if (mode === "oidc") return <OidcLogin />;
  if (mode === "trusted-header") return <TrustedHeaderNotice />;
  return <AdminKeyLogin onAuthed={onAuthed} />;
}

function OidcLogin() {
  return (
    <div className="flex min-h-full items-center justify-center bg-arbr-paper px-4">
      <div className="card w-full max-w-sm p-8 text-center">
        <Logo className="mx-auto h-6 w-auto text-arbr-charcoal" />
        <p className="mt-3 text-sm text-gray-500">Sign in with your organization's identity provider to continue.</p>
        <a href="/api/auth/login" className="btn-primary mt-6 inline-block w-full">Sign in with SSO</a>
      </div>
    </div>
  );
}

function TrustedHeaderNotice() {
  return (
    <div className="flex min-h-full items-center justify-center bg-arbr-paper px-4">
      <div className="card w-full max-w-sm p-8 text-center">
        <Logo className="mx-auto h-6 w-auto text-arbr-charcoal" />
        <p className="mt-3 text-sm text-gray-500">
          This instance authenticates through a trusted reverse proxy or GCP IAP. If you're seeing
          this page, your request didn't arrive through that layer — check with your administrator.
        </p>
      </div>
    </div>
  );
}

function AdminKeyLogin({ onAuthed }) {
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
    <div className="flex min-h-full items-center justify-center bg-arbr-paper px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <Logo className="h-6 w-auto text-arbr-charcoal" />
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
