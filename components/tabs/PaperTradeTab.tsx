"use client";

import { useState, useEffect } from "react";
import MetricCard from "@/components/MetricCard";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import type { Params } from "@/lib/strategy";

interface Props {
  symbol: string;
  params: Params;
}

interface Trade {
  id: number;
  ts: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
}

interface Position {
  symbol: string;
  direction: string;
  entry_price: number;
  entry_ts: string;
}

export default function PaperTradeTab({ symbol, params }: Props) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [cycleMsg, setCycleMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  async function fetchData() {
    const [tRes, pRes] = await Promise.all([
      fetch(`/api/paper-trade?symbol=${encodeURIComponent(symbol)}`),
      fetch(`/api/paper-trade/position?symbol=${encodeURIComponent(symbol)}`),
    ]);
    const tData = await tRes.json();
    const pData = await pRes.json();
    setTrades(tData.trades ?? []);
    setPosition(pData.position ?? null);
  }

  async function runNow() {
    setLoading(true);
    setCycleMsg(null);
    try {
      const res = await fetch("/api/paper-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, params }),
      });
      const data = await res.json();
      setCycleMsg(data.message ?? data.error ?? "Done");
      await fetchData();
    } catch (e: unknown) {
      setCycleMsg(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const nWins = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length ? (nWins / trades.length) * 100 : 0;

  const equityData = [...trades]
    .reverse()
    .map((t, i, arr) => ({
      ts: t.ts,
      value: 1000 + arr.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0),
    }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-lg font-bold text-white">Paper Trading</h2>
          <p className="text-muted text-sm">
            Simulated trades · $1,000 per position · Vercel Cron runs every 4h
          </p>
        </div>
        <button
          onClick={runNow}
          disabled={loading}
          className="px-6 py-2 rounded-lg bg-accent2 text-white font-bold font-mono text-sm
                     hover:bg-accent2/80 disabled:opacity-50 transition-colors"
        >
          {loading ? "Running…" : "⚡ Run Now"}
        </button>
      </div>

      {cycleMsg && (
        <div className="bg-card border border-accent/20 rounded-lg p-3 text-accent text-sm font-mono">
          {cycleMsg}
        </div>
      )}

      {/* Open position */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">Open Position</h3>
        {position ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Symbol" value={position.symbol} positive={null} />
            <MetricCard
              label="Direction"
              value={position.direction}
              positive={position.direction === "LONG"}
            />
            <MetricCard label="Entry Price" value={`$${Number(position.entry_price).toFixed(2)}`} positive={null} />
            <MetricCard label="Entry Time" value={new Date(position.entry_ts).toLocaleString()} positive={null} />
          </div>
        ) : (
          <p className="text-muted font-mono text-sm">No open position</p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard
          label="Total PnL"
          value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`}
          positive={totalPnl >= 0}
        />
        <MetricCard label="Total Trades" value={trades.length.toString()} positive={null} />
        <MetricCard label="Win Rate" value={trades.length ? `${winRate.toFixed(1)}%` : "—"} positive={winRate >= 50} />
      </div>

      {/* PnL chart */}
      {equityData.length > 1 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">Cumulative PnL</h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={equityData}>
              <defs>
                <linearGradient id="pt-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={totalPnl >= 0 ? "#00d4aa" : "#ff4466"} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={totalPnl >= 0 ? "#00d4aa" : "#ff4466"} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2433" />
              <XAxis dataKey="ts" tick={{ fill: "#64748b", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#1e2433" }} tickFormatter={(v) => new Date(v).toLocaleDateString()} minTickGap={80} />
              <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} width={60} />
              <Tooltip contentStyle={{ background: "#111318", border: "1px solid #1e2433", borderRadius: 8 }} labelStyle={{ color: "#64748b", fontSize: 10 }} formatter={(v) => [`$${Number(v).toFixed(2)}`, "Portfolio"]} />
              <Area type="monotone" dataKey="value" stroke={totalPnl >= 0 ? "#00d4aa" : "#ff4466"} fill="url(#pt-grad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Trade history */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">
          Trade History ({trades.length})
        </h3>
        {trades.length === 0 ? (
          <p className="text-muted font-mono text-sm">
            No trades yet. Click ⚡ Run Now or wait for the Vercel Cron (every 4h).
          </p>
        ) : (
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-card">
                <tr className="text-muted border-b border-border">
                  <th className="text-left p-2">Time</th>
                  <th className="text-left p-2">Dir</th>
                  <th className="text-right p-2">Entry</th>
                  <th className="text-right p-2">Exit</th>
                  <th className="text-right p-2">PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-border/40 hover:bg-border/20">
                    <td className="p-2 text-muted">{new Date(t.ts).toLocaleString()}</td>
                    <td className={`p-2 font-bold ${t.direction === "LONG" ? "text-accent" : "text-danger"}`}>{t.direction}</td>
                    <td className="text-right p-2 text-white">${Number(t.entry_price).toFixed(2)}</td>
                    <td className="text-right p-2 text-white">${Number(t.exit_price).toFixed(2)}</td>
                    <td className={`text-right p-2 font-bold ${t.pnl >= 0 ? "text-accent" : "text-danger"}`}>
                      {t.pnl >= 0 ? "+" : ""}${Number(t.pnl).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-muted text-xs font-mono text-center">
        Vercel Cron runs automatically every 4 hours · No real orders placed
      </p>
    </div>
  );
}
