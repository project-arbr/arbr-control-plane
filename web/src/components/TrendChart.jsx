import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card } from "./ui.jsx";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

const TREND_PERIODS = [
  { label: "7 days",  days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

function trendRange(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function TrendChart({ appName }) {
  const [period, setPeriod] = useState(1); // default 30 days
  const [rows, setRows] = useState(null);

  useEffect(() => {
    setRows(null);
    const filter = trendRange(TREND_PERIODS[period].days);
    if (appName) filter.application = appName;
    api.timeseries(filter).then(setRows).catch(() => setRows([]));
  }, [period, appName]);

  return (
    <Card title="Cost & request trend">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-gray-500">Daily totals — cost (bars) and requests (line).</p>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {TREND_PERIODS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPeriod(i)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                period === i ? "bg-white text-arbr-charcoal shadow-sm border border-gray-200" : "text-gray-500 hover:text-arbr-charcoal"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {rows === null ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">No data for this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5df" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
            <YAxis yAxisId="cost" orientation="left" tick={{ fontSize: 11 }}
              tickFormatter={(v) => `$${v.toFixed(2)}`} width={58} />
            <YAxis yAxisId="reqs" orientation="right" tick={{ fontSize: 11 }} width={44} />
            <Tooltip
              formatter={(value, name) => name === "cost" ? [`$${value.toFixed(4)}`, "Cost"] : [value.toLocaleString(), "Requests"]}
              labelFormatter={(d) => `Date: ${d}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="cost" dataKey="cost" name="cost" fill="#171817" opacity={0.85} radius={[2, 2, 0, 0]} />
            <Line yAxisId="reqs" dataKey="requests" name="requests" type="monotone"
              stroke="#9ca3af" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
