"use client";

import { useState } from "react";
import MetricCard from "@/components/MetricCard";
import EquityChart from "@/components/charts/EquityChart";
import PnLTable from "@/components/charts/PnLTable";
import type { Params } from "@/lib/strategy";

interface Props {
  symbol: string;
  days: number;
  params: Params;
  onAiParams: (p: Params) => void;
  onTrades?: (pnls: number[]) => void;
}

export default function BacktestTab({ symbol, days, params, onAiParams, onTrades }: Props) {
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [result, setResult] = useState<null | {
    equityCurve: { ts: number; value: number }[];
    trades: { pnl: number; returnPct: number; direction: string; entryPrice: number; exitPrice: number; entryTime: number; exitTime: number }[];
    metrics: {
      totalReturn: number; maxDrawdown: number; sharpe: number;
      winRate: number; nTrades: number; avgWin: number; avgLoss: number;
      avgDurationHrs: number; finalCapital: number;
    };
    monthly: Record<number, Record<number, number>>;
  }>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [showTrades, setShowTrades] = useState(false);

  async function runBacktest() {
    setLoading(true);
    setError(null);
    setAiMsg(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, days, params }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
      onTrades?.(data.trades.map((t: { pnl: number }) => t.pnl));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function runAI() {
    if (!result) return;
    setAiLoading(true);
    setAiMsg(null);
    try {
      const res = await fetch("/api/ai-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params, metrics: result.metrics }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onAiParams(data.params);
      setAiMsg("AI parameters applied — re-run the backtest to see the effect.");
    } catch (e: unknown) {
      setAiMsg(`AI error: ${e instanceof Error ? e.message : "Unknown"}`);
    } finally {
      setAiLoading(false);
    }
  }

  const m = result?.metrics;
  const underperforming = m && (m.totalReturn < 0 || m.sharpe < 0.5);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">EMA Cross Momentum Scalper</h2>
          <p className="text-muted text-sm">
            Long/short on EMA crossovers filtered by trend direction and RSI momentum.
          </p>
        </div>
        <button
          onClick={runBacktest}
          disabled={loading}
          className="px-6 py-2 rounded-lg bg-accent text-bg font-bold font-mono text-sm
                     hover:bg-accent/80 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "▶ Run Backtest"}
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-danger text-sm">
          {error}
        </div>
      )}

      {m && (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MetricCard label="Total Return" value={`${m.totalReturn > 0 ? "+" : ""}${m.totalReturn.toFixed(1)}%`} positive={m.totalReturn >= 0} />
            <MetricCard label="Sharpe Ratio" value={m.sharpe.toFixed(2)} positive={m.sharpe >= 1} />
            <MetricCard label="Max Drawdown" value={`${m.maxDrawdown.toFixed(1)}%`} positive={false} />
            <MetricCard label="Win Rate" value={`${m.winRate.toFixed(1)}%`} positive={m.winRate >= 50} />
            <MetricCard label="Total Trades" value={m.nTrades.toString()} positive={null} />
          </div>

          {/* Equity curve */}
          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">Equity Curve</h3>
            <EquityChart data={result.equityCurve} />
          </div>

          {/* Secondary metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Final Capital" value={`$${m.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} positive={m.finalCapital >= 10000} />
            <MetricCard label="Avg Win" value={`$${m.avgWin.toFixed(2)}`} positive={true} />
            <MetricCard label="Avg Loss" value={`$${m.avgLoss.toFixed(2)}`} positive={false} />
            <MetricCard label="Avg Duration" value={`${m.avgDurationHrs.toFixed(1)}h`} positive={null} />
          </div>

          {/* Monthly PnL table */}
          {result.monthly && Object.keys(result.monthly).length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">Monthly PnL (%)</h3>
              <PnLTable data={result.monthly} />
            </div>
          )}

          {/* Trade log */}
          {result.trades.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <button
                onClick={() => setShowTrades((v) => !v)}
                className="text-sm font-mono text-muted uppercase tracking-wider hover:text-white transition-colors"
              >
                {showTrades ? "▼" : "▶"} Trade Log ({result.trades.length} trades)
              </button>
              {showTrades && (
                <div className="mt-3 overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-muted border-b border-border">
                        <th className="text-left p-2">Direction</th>
                        <th className="text-right p-2">Entry</th>
                        <th className="text-right p-2">Exit</th>
                        <th className="text-right p-2">PnL</th>
                        <th className="text-right p-2">Return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => (
                        <tr key={i} className="border-b border-border/40 hover:bg-border/20">
                          <td className={`p-2 ${t.direction === "long" ? "text-accent" : "text-danger"}`}>
                            {t.direction.toUpperCase()}
                          </td>
                          <td className="text-right p-2 text-white">${t.entryPrice.toFixed(2)}</td>
                          <td className="text-right p-2 text-white">${t.exitPrice.toFixed(2)}</td>
                          <td className={`text-right p-2 font-bold ${t.pnl >= 0 ? "text-accent" : "text-danger"}`}>
                            {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                          </td>
                          <td className={`text-right p-2 ${t.returnPct >= 0 ? "text-accent" : "text-danger"}`}>
                            {t.returnPct >= 0 ? "+" : ""}{t.returnPct.toFixed(2)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* AI Adjuster */}
          <div className={`border rounded-xl p-4 ${underperforming ? "bg-danger/5 border-danger/30" : "bg-accent/5 border-accent/20"}`}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                {underperforming ? (
                  <p className="text-danger text-sm font-mono">
                    ⚠ Strategy underperforming (Return: {m.totalReturn.toFixed(1)}%, Sharpe: {m.sharpe.toFixed(2)})
                  </p>
                ) : (
                  <p className="text-accent text-sm font-mono">
                    ✓ Strategy looks solid — you can still try AI tuning
                  </p>
                )}
              </div>
              <button
                onClick={runAI}
                disabled={aiLoading}
                className="px-4 py-2 rounded-lg border border-accent2 text-accent2 font-mono text-sm
                           hover:bg-accent2/10 disabled:opacity-50 transition-colors"
              >
                {aiLoading ? "Consulting AI…" : "🤖 Adjust with AI"}
              </button>
            </div>
            {aiMsg && <p className="mt-2 text-sm text-muted font-mono">{aiMsg}</p>}
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="text-center text-muted py-16 font-mono">
          Configure parameters in the sidebar, then click ▶ Run Backtest
        </div>
      )}
    </div>
  );
}
