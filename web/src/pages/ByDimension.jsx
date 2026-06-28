import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Spinner } from "../components/ui.jsx";

const DIMENSIONS = [
  { key: "application", label: "Application" },
  { key: "team", label: "Team" },
  { key: "user", label: "User" },
  { key: "workflow", label: "Workflow" },
  { key: "model", label: "Model" },
  { key: "provider", label: "Provider" },
  { key: "taskType", label: "Task type" },
];

export default function ByDimension({ embedded = false }) {
  const [dim, setDim] = useState("application");
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setRows(null);
    api.by(dim).then(setRows).catch((e) => setErr(e.message));
  }, [dim]);

  const columns = [
    { key: "key", header: DIMENSIONS.find((d) => d.key === dim)?.label || dim,
      render: (r) => r.key || (dim === "user" ? "(unattributed)" : "—") },
    { key: "requests", header: "Requests", render: (r) => fmt.num(r.requests) },
    { key: "cost", header: "Cost", render: (r) => fmt.usd(r.cost) },
    { key: "avgLatency", header: "Avg latency", render: (r) => fmt.ms(r.avgLatency) },
  ];
  if (dim === "provider") {
    columns.push({ key: "tokens", header: "Tokens", render: (r) => fmt.num(r.tokens) });
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-arbr-charcoal">By dimension</h1>
          <p className="text-sm text-gray-500">Usage and cost, sliced the ways each audience needs to see them.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {DIMENSIONS.map((d) => (
          <button
            key={d.key}
            onClick={() => setDim(d.key)}
            className={`btn ${dim === d.key ? "btn-secondary" : "btn-outline"}`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <Card>
        {rows === null ? <Spinner /> : <Table columns={columns} rows={rows} />}
      </Card>
    </div>
  );
}
