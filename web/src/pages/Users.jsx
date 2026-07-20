import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Badge, Spinner, ConfirmDialog } from "../components/ui.jsx";

const ROLES = ["viewer", "operator", "administrator"];

function roleTone(role) {
  return role === "administrator" ? "charcoal" : role === "operator" ? "green" : "gray";
}

export default function Users() {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);

  const load = () => api.users().then(setUsers).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const changeRole = async (u, role) => {
    setErr(null);
    try { await api.setUserRole(u._id, role); await load(); }
    catch (e) { setErr(e.message); }
  };

  const disable = async (u) => {
    setConfirmDisable(null);
    setErr(null);
    try { await api.disableUser(u._id); await load(); }
    catch (e) { setErr(e.message); }
  };

  const enable = async (u) => {
    setErr(null);
    try { await api.enableUser(u._id); await load(); }
    catch (e) { setErr(e.message); }
  };

  const columns = [
    { key: "email", header: "Email", render: (u) => (
      <div>
        <span className="font-medium text-arbr-charcoal">{u.email}</span>
        {u.disabledAt && <Badge tone="red">disabled</Badge>}
      </div>
    ) },
    { key: "role", header: "Role", render: (u) => (
      <select
        className="input py-1 text-sm"
        value={u.role}
        onChange={(e) => changeRole(u, e.target.value)}
        disabled={!!u.disabledAt}
      >
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    ) },
    { key: "lastLoginAt", header: "Last login", render: (u) => u.lastLoginAt ? fmt.date(u.lastLoginAt) : "—" },
    { key: "createdAt", header: "Added", render: (u) => fmt.date(u.createdAt) },
    { key: "actions", header: "", render: (u) => (
      u.disabledAt
        ? <button className="btn-ghost text-sm" onClick={() => enable(u)}>Re-enable</button>
        : <button className="btn-ghost text-sm text-red-600" onClick={() => setConfirmDisable(u)}>Disable</button>
    ) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-arbr-charcoal">Users</h1>
        <p className="mt-1 text-sm text-gray-500">
          Everyone who has signed in through SSO or a trusted proxy. Disabling a user revokes only
          their access — no one else's session changes.
        </p>
      </div>

      <Card>
        {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
        {users === null ? <Spinner /> : (
          <Table columns={columns} rows={users} empty="No users yet — sign in via SSO, or run scripts/bootstrap-admin.js to mint the first administrator." />
        )}
      </Card>

      {confirmDisable && (
        <ConfirmDialog
          title="Disable this user?"
          message={`${confirmDisable.email} will lose access immediately. This does not affect any other user's session.`}
          confirmLabel="Disable"
          onConfirm={() => disable(confirmDisable)}
          onCancel={() => setConfirmDisable(null)}
        />
      )}
    </div>
  );
}
