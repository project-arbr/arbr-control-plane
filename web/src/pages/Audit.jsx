import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Badge, Table } from "../components/ui.jsx";

const ENTITY_TONE = {
  rule:     "indigo",
  cap:      "red",
  key:      "teal",
  settings: "charcoal",
  governance: "amber",
};

const ACTION_LABELS = {
  "rule.create":      "Rule created",
  "rule.update":      "Rule updated",
  "rule.delete":      "Rule deleted",
  "cap.create":       "Budget created",
  "cap.update":       "Budget updated",
  "cap.delete":       "Budget deleted",
  "key.create":       "Key created",
  "key.revoke":       "Key revoked",
  "governance.update":"Governance updated",
};

export default function Audit() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [err, setErr]   = useState(null);

  const load = (p = page) => {
    setData(null);
    api.auditLog({ page: p, limit: 50 })
      .then(setData)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => { load(page); }, [page]);

  const columns = [
    {
      key: "timestamp",
      header: "Time",
      render: (r) => <span className="whitespace-nowrap text-gray-500 text-xs">{fmt.date(r.timestamp)}</span>,
    },
    {
      key: "action",
      header: "Action",
      render: (r) => (
        <span className="flex items-center gap-2">
          <Badge tone={ENTITY_TONE[r.entity] || "gray"}>{r.entity}</Badge>
          <span className="text-sm text-arbr-charcoal">{ACTION_LABELS[r.action] || r.action}</span>
        </span>
      ),
    },
    {
      key: "entityId",
      header: "ID",
      render: (r) => <span className="font-mono text-xs text-gray-400">{r.entityId?.slice(-8) || "—"}</span>,
    },
    {
      key: "changes",
      header: "Details",
      render: (r) => r.changes ? (
        <span className="font-mono text-xs text-gray-500 break-all">
          {JSON.stringify(r.changes).slice(0, 120)}
        </span>
      ) : <span className="text-gray-300">—</span>,
    },
    {
      key: "actor",
      header: "By",
      render: (r) => <Badge tone="gray">{r.actor || "admin"}</Badge>,
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-arbr-charcoal">Audit log</h1>
        <p className="text-sm text-gray-500">
          Immutable record of every admin action — rule changes, budget edits, key creation/revocation,
          governance settings.
        </p>
      </div>

      <Card>
        {data === null ? (
          <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
        ) : (
          <>
            <Table columns={columns} rows={data.items} empty="No audit entries yet." />
            <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
              <span>{fmt.num(data.total)} entries</span>
              <div className="flex items-center gap-2">
                <button className="btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <span>Page {page}</span>
                <button className="btn-outline" disabled={page * data.limit >= data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </>
        )}
      </Card>

      {err && <div className="text-red-600 text-sm">{err}</div>}
    </div>
  );
}
