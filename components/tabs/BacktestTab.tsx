"use client";

import { useState } from "react";
import MetricCard from "@/components/MetricCard";
import EquityChart from "@/components/charts/EquityChart";
import PnLTable from "@/components/charts/PnLTable";
import type { Params } from "@/lib/strategy";
import {
  ComposedChart, Line, ReferenceLine, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

interface Props {
  symbol: string;
  days: number;
  params: Params;
  onAiParams: (p: Params) => void;
  onTrades?: (pnls: number[]) => void;
}

interface Trade {
  pnl: number;
  returnPct: number;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number;
  entryTime: number;
  exitTime: number;
  positionValue: number;
  capitalAtEntry: number;
}

interface CandlePoint {
  ts: number;
  close: number;
  entry?: number;
  exit?: number;
}

export default function BacktestTab({ symbol, days, params, onAiParams, onTrades }: Props) {
  const [loading, setLoading]       = useState(false);
  const [aiLoading, setAiLoading]   = useState(false);
  const [result, setResult]         = useState<null | {
    equityCurve: { ts: number; value: number }[];
    trades: Trade[];
    metrics: {
      totalReturn: number; maxDrawdown: number; sharpe: number;
      winRate: number; nTrades: number; avgWin: number; avgLoss: number;
      avgDurationHrs: number; finalCapital: number;
    };
    monthly: Record<number, Record<number, { pct: number; usd: number }>>;
  }>(null);
  const [error, setError]           = useState<string | null>(null);
  const [aiMsg, setAiMsg]           = useState<string | null>(null);
  const [showTrades, setShowTrades] = useState(false);

  // Trade detail modal
  const [selectedTrade, setSelectedTrade]   = useState<Trade | null>(null);
  const [tradeCandles, setTradeCandles]     = useState<CandlePoint[]>([]);
  const [candleLoading, setCandleLoading]   = useState(false);

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
      onTrades?.(data.trades.map((t: Trade) => t.pnl));
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

  async function openTradeDetail(trade: Trade) {
    setSelectedTrade(trade);
    setCandleLoading(true);
    setTradeCandles([]);
    try {
      // 40 bars before entry, 20 bars after exit
      const from = trade.entryTime - 40 * 3_600_000;
      const to   = trade.exitTime  + 20 * 3_600_000;
      const res  = await fetch(
        `/api/backtest/candles?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`
      );
      if (!res.ok) { setCandleLoading(false); return; }
      const data = await res.json();
      const raw: { ts: number; close: number }[] = data.candles ?? [];

      // Attach entry/exit dots at the ACTUAL fill prices (not bar close)
      // Using trade.entryPrice / trade.exitPrice so recharts places the dot
      // at the correct Y position, independent of where the close line sits.
      const points: CandlePoint[] = raw.map((c) => {
        const isEntry = c.ts === trade.entryTime;
        const isExit  = c.ts === trade.exitTime;
        return {
          ts:    c.ts,
          close: c.close,
          ...(isEntry ? { entry: trade.entryPrice } : {}),
          ...(isExit  ? { exit:  trade.exitPrice  } : {}),
        };
      });
      setTradeCandles(points);
    } finally {
      setCandleLoading(false);
    }
  }

  const m = result?.metrics;
  const underperforming = m && (m.totalReturn < 0 || m.sharpe < 0.5);

  return (
    <div className="flex flex-col gap-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          {params.strategy === "scalp" ? (
            <>
              <h2 className="text-lg font-bold text-white">EMA Trend + BB Scalp</h2>
              <p className="text-muted text-sm">
                EMA trend filter · buy BB touch pullbacks · ATR target exit
              </p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-bold text-white">BB + RSI Mean Reversion</h2>
              <p className="text-muted text-sm">
                Buy BB lower oversold dips · exit at BB middle reversion or ATR stop
              </p>
            </>
          )}
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
            <MetricCard label="Total Return"  value={`${m.totalReturn > 0 ? "+" : ""}${m.totalReturn.toFixed(1)}%`} positive={m.totalReturn >= 0} />
            <MetricCard label="Sharpe Ratio"  value={m.sharpe.toFixed(2)} positive={m.sharpe >= 1} />
            <MetricCard label="Max Drawdown"  value={`${m.maxDrawdown.toFixed(1)}%`} positive={false} />
            <MetricCard label="Win Rate"      value={`${m.winRate.toFixed(1)}%`} positive={m.winRate >= 50} />
            <MetricCard label="Total Trades"  value={m.nTrades.toString()} positive={null} />
          </div>

          {/* Equity curve */}
          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">Equity Curve</h3>
            <EquityChart data={result.equityCurve} initialCapital={params.initialCapital} />
          </div>

          {/* Secondary metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Final Capital" value={`$${(m.finalCapital ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} positive={(m.finalCapital ?? 0) >= (params.initialCapital ?? 1000)} />
            <MetricCard label="Avg Win"       value={`$${m.avgWin.toFixed(2)}`} positive={true} />
            <MetricCard label="Avg Loss"      value={`$${m.avgLoss.toFixed(2)}`} positive={false} />
            <MetricCard label="Avg Duration"  value={`${m.avgDurationHrs.toFixed(1)}h`} positive={null} />
          </div>

          {/* Monthly PnL table */}
          {result.monthly && Object.keys(result.monthly).length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">Monthly PnL</h3>
              <PnLTable data={result.monthly} initialCapital={params.initialCapital} />
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
                  <p className="text-[10px] text-muted font-mono mb-2">Click a row to inspect the trade chart</p>
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-muted border-b border-border">
                        <th className="text-left p-2">Date</th>
                        <th className="text-left p-2">Dir</th>
                        <th className="text-right p-2">Entry</th>
                        <th className="text-right p-2">Exit</th>
                        <th className="text-right p-2">PnL</th>
                        <th className="text-right p-2">Return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => (
                        <tr
                          key={i}
                          onClick={() => openTradeDetail(t)}
                          className="border-b border-border/40 hover:bg-accent/5 cursor-pointer transition-colors"
                        >
                          <td className="p-2 text-muted">
                            {new Date(t.entryTime).toLocaleDateString()}
                          </td>
                          <td className={`p-2 font-bold ${t.direction === "long" ? "text-accent" : "text-danger"}`}>
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
                    Strategy underperforming (Return: {m.totalReturn.toFixed(1)}%, Sharpe: {m.sharpe.toFixed(2)})
                  </p>
                ) : (
                  <p className="text-accent text-sm font-mono">
                    Strategy looks solid — you can still try AI tuning
                  </p>
                )}
              </div>
              <button
                onClick={runAI}
                disabled={aiLoading}
                className="px-4 py-2 rounded-lg border border-accent2 text-accent2 font-mono text-sm
                           hover:bg-accent2/10 disabled:opacity-50 transition-colors"
              >
                {aiLoading ? "Consulting AI…" : "Adjust with AI"}
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

      {/* ── Trade Detail Modal ─────────────────────────────────────── */}
      {selectedTrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setSelectedTrade(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <span className={`font-bold font-mono text-sm ${selectedTrade.pnl >= 0 ? "text-accent" : "text-danger"}`}>
                  {selectedTrade.direction.toUpperCase()}
                </span>
                <span className="text-muted font-mono text-sm ml-2">
                  {new Date(selectedTrade.entryTime).toLocaleString()} → {new Date(selectedTrade.exitTime).toLocaleString()}
                </span>
              </div>
              <button
                onClick={() => setSelectedTrade(null)}
                className="text-muted hover:text-white font-mono text-lg leading-none"
              >
                ✕
              </button>
            </div>

            {/* Key levels */}
            <div className="grid grid-cols-3 gap-3 p-4 border-b border-border">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted font-mono uppercase">Entry</span>
                <span className="text-white font-mono font-bold">${selectedTrade.entryPrice.toFixed(2)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted font-mono uppercase">Target (TP)</span>
                <span className="text-accent font-mono font-bold">${selectedTrade.tpPrice.toFixed(2)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted font-mono uppercase">Stop (SL)</span>
                <span className="text-danger font-mono font-bold">${selectedTrade.slPrice.toFixed(2)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted font-mono uppercase">Position size</span>
                <span className="text-white font-mono font-bold">
                  ${selectedTrade.positionValue.toFixed(2)}
                  <span className="text-[10px] text-muted ml-1">
                    ({selectedTrade.capitalAtEntry > 0 ? ((selectedTrade.positionValue / selectedTrade.capitalAtEntry) * 100).toFixed(1) : "0"}%)
                  </span>
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted font-mono uppercase">Balance</span>
                <span className="text-white font-mono font-bold">${selectedTrade.capitalAtEntry.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted font-mono uppercase">PnL</span>
                <span className={`font-mono font-bold ${selectedTrade.pnl >= 0 ? "text-accent" : "text-danger"}`}>
                  {selectedTrade.pnl >= 0 ? "+" : ""}${selectedTrade.pnl.toFixed(2)}
                  <span className="text-[10px] ml-1">({selectedTrade.returnPct >= 0 ? "+" : ""}{selectedTrade.returnPct.toFixed(2)}%)</span>
                </span>
              </div>
            </div>

            {/* Mini chart */}
            <div className="p-4">
              {candleLoading ? (
                <div className="h-48 flex items-center justify-center text-muted font-mono text-sm">
                  Loading chart…
                </div>
              ) : tradeCandles.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={tradeCandles} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2433" />
                    <XAxis
                      dataKey="ts"
                      tick={{ fill: "#64748b", fontSize: 9 }}
                      tickLine={false}
                      axisLine={{ stroke: "#1e2433" }}
                      tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      minTickGap={60}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fill: "#64748b", fontSize: 9 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `$${v.toFixed(0)}`}
                      width={58}
                    />
                    <Tooltip
                      contentStyle={{ background: "#111318", border: "1px solid #1e2433", borderRadius: 8, fontSize: 11 }}
                      labelFormatter={(v) => new Date(v).toLocaleString()}
                      formatter={(v) => [`$${Number(v).toFixed(2)}`]}
                    />

                    {/* Price close line — no dots, just the price path */}
                    <Line
                      type="monotone"
                      dataKey="close"
                      stroke="#64748b"
                      strokeWidth={1.5}
                      name="Price"
                      dot={false}
                      isAnimationActive={false}
                    />

                    {/* Entry dot — rendered at actual fill price (not bar close) */}
                    <Line
                      type="monotone"
                      dataKey="entry"
                      stroke="transparent"
                      name="Entry"
                      isAnimationActive={false}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dot={(props: any) => {
                        const { cx, cy, payload, index } = props;
                        if (payload.entry === undefined) return <circle key={`en${index}`} r={0} />;
                        return <circle key={`en${index}`} cx={cx} cy={cy} r={6} fill="#00d4aa" stroke="#0a0b0d" strokeWidth={1.5} />;
                      }}
                    />

                    {/* Exit dot — teal on win, red on loss, at actual exit price */}
                    <Line
                      type="monotone"
                      dataKey="exit"
                      stroke="transparent"
                      name="Exit"
                      isAnimationActive={false}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      dot={(props: any) => {
                        const { cx, cy, payload, index } = props;
                        if (payload.exit === undefined) return <circle key={`ex${index}`} r={0} />;
                        const col = selectedTrade!.pnl >= 0 ? "#00d4aa" : "#ff4466";
                        return <circle key={`ex${index}`} cx={cx} cy={cy} r={6} fill={col} stroke="#0a0b0d" strokeWidth={1.5} />;
                      }}
                    />

                    {/* Key price levels */}
                    <ReferenceLine y={selectedTrade.entryPrice} stroke="#ffffff" strokeDasharray="4 3" strokeWidth={1} label={{ value: "Entry", fill: "#ffffff", fontSize: 9, position: "insideTopLeft" }} />
                    <ReferenceLine y={selectedTrade.tpPrice}    stroke="#00d4aa" strokeDasharray="4 3" strokeWidth={1} label={{ value: "TP",    fill: "#00d4aa", fontSize: 9, position: "insideTopLeft" }} />
                    <ReferenceLine y={selectedTrade.slPrice}    stroke="#ff4466" strokeDasharray="4 3" strokeWidth={1} label={{ value: "SL",    fill: "#ff4466", fontSize: 9, position: "insideTopLeft" }} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted font-mono text-sm">
                  No cached candles for this period — run a backtest first to seed the cache.
                </div>
              )}
              <p className="text-[10px] text-muted font-mono mt-2 text-center">
                White dashed = entry · Teal dashed = target · Red dashed = stop loss
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
