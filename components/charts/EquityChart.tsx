"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface Props {
  data: { ts: number; value: number }[];
}

const fmt = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", year: "2-digit" });

export default function EquityChart({ data }: Props) {
  const sampled = data.filter((_, i) => i % Math.max(1, Math.floor(data.length / 500)) === 0);
  const isPositive = data.length > 0 && data.at(-1)!.value >= 10_000;

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={sampled} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="eq-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={isPositive ? "#00d4aa" : "#ff4466"} stopOpacity={0.3} />
            <stop offset="95%" stopColor={isPositive ? "#00d4aa" : "#ff4466"} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2433" />
        <XAxis
          dataKey="ts"
          tickFormatter={fmtDate}
          tick={{ fill: "#64748b", fontSize: 11 }}
          axisLine={{ stroke: "#1e2433" }}
          tickLine={false}
          minTickGap={80}
        />
        <YAxis
          tickFormatter={fmt}
          tick={{ fill: "#64748b", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={75}
        />
        <Tooltip
          contentStyle={{ background: "#111318", border: "1px solid #1e2433", borderRadius: 8 }}
          labelStyle={{ color: "#64748b", fontSize: 11 }}
          formatter={(v) => [fmt(Number(v)), "Portfolio"]}
          labelFormatter={(ts) => new Date(Number(ts)).toLocaleString()}
        />
        <ReferenceLine y={10000} stroke="#64748b" strokeDasharray="4 4" label={{ value: "Start", fill: "#64748b", fontSize: 10 }} />
        <Area
          type="monotone"
          dataKey="value"
          stroke={isPositive ? "#00d4aa" : "#ff4466"}
          strokeWidth={2}
          fill="url(#eq-gradient)"
          dot={false}
          activeDot={{ r: 4, fill: isPositive ? "#00d4aa" : "#ff4466" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
