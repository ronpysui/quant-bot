"use client";

import { useEffect, useRef, useState } from "react";
import type { Params } from "@/lib/strategy";
import type { OptimizerStatus, StrategyRow, SortColumn } from "@/lib/strategy-maker";

interface Props {
  onLoadParams: (params: Params) => void;
}

const SORT_OPTIONS: { key: SortColumn; label: string }[] = [
  { key: "total_return",     label: "Return %" },
  { key: "sharpe",           label: "Sharpe" },
  { key: "win_rate",         label: "Win Rate" },
  { key: "mc_median_return", label: "MC Median Return" },
  { key: "mc_pct_profit",    label: "MC % Profitable" },
  { key: "mc_p50",           label: "MC Median $" },
  { key: "n_trades",         label: "Trades" },
];

function fmt(v: number | null, decimals = 2, suffix = "") {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toFixed(decimals) + suffix;
}

function fmtDollar(v: number | null) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return "$" + v.toFixed(0);
}

function colorClass(v: number | null, inverse = false) {
  if (v === null || v === undefined || isNaN(v)) return "text-muted";
  const positive = inverse ? v < 0 : v > 0;
  return positive ? "text-accent" : "text-danger";
}

export default function StrategyMakerTab({ onLoadParams }: Props) {
  const [status, setStatus]       = useState<OptimizerStatus | null>(null);
  const [results, setResults]     = useState<StrategyRow[]>([]);
  const [sortBy, setSortBy]       = useState<SortColumn>("total_return");
  const [autoRun, setAutoRun]     = useState(false);
  const [loading, setLoading]     = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [loadedHash, setLoadedHash] = useState<string | null>(null);
  const runningRef = useRef(false);
  const sortRef    = useRef<SortColumn>("total_return");

  // Load initial status + auto-start the loop if work remains
  useEffect(() => {
    async function init() {
      try {
        const res  = await fetch(`/api/strategy-maker?sortBy=total_return`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setStatus(data.status);
        setResults(data.results);
        // Auto-start every time this tab mounts, unless optimizer is fully done
        if (!data.status.isDone) setAutoRun(true);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    init();
  }, []); // only on mount — intentional empty deps

  // Auto-run loop: fires batches back-to-back while enabled.
  // Uses sortRef instead of sortBy state to avoid restarting the loop on sort change.
  useEffect(() => {
    if (!autoRun) return;
    let cancelled = false;

    async function loop() {
      while (!cancelled) {
        if (runningRef.current) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        runningRef.current = true;
        try {
          setLoading(true);
          const res = await fetch("/api/strategy-maker", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batchSize: 100, sortBy: sortRef.current }),
          });
          const data = await res.json();
          if (data.error) { setError(data.error); break; }
          setStatus(data.status);
          setResults(data.results);
          if (data.status.isDone) { setAutoRun(false); break; }
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e));
          break;
        } finally {
          runningRef.current = false;
          setLoading(false);
        }
        // Brief pause between batches
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    loop();
    return () => { cancelled = true; };
  }, [autoRun]); // sortRef is a ref — changes don't restart the loop

  async function handleReset() {
    if (!confirm("Reset all optimizer results? This cannot be undone.")) return;
    setResetting(true);
    setError(null);
    try {
      await fetch("/api/strategy-maker", { method: "DELETE" });
      setResults([]);
      setLoadedHash(null);
      // Reload status after reset
      const res  = await fetch(`/api/strategy-maker?sortBy=${sortRef.current}`);
      const data = await res.json();
      if (!data.error) { setStatus(data.status); setResults(data.results); }
    } finally {
      setResetting(false);
    }
  }

  async function handleSortChange(col: SortColumn) {
    setSortBy(col);
    sortRef.current = col;
    try {
      const res  = await fetch(`/api/strategy-maker?sortBy=${col}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStatus(data.status);
      setResults(data.results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleLoadParams(row: StrategyRow) {
    const p: Params = JSON.parse(row.params_json);
    onLoadParams(p);
    setLoadedHash(row.params_hash);
  }

  const pct = status
    ? Math.min(100, (status.completed / Math.max(1, status.totalCombos)) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-white font-bold text-lg tracking-tight">Strategy Optimizer</h2>
        <p className="text-muted text-xs font-mono mt-1">
          Grid-searches {status?.totalCombos.toLocaleString() ?? "…"} parameter combinations ·
          1080-day BTC/USDT backtest · 1000 MC paths each
        </p>
      </div>

      {/* ── Progress ───────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-white font-mono text-sm font-bold">
              {status?.completed.toLocaleString() ?? "—"}
              <span className="text-muted font-normal">
                {" "}/ {status?.totalCombos.toLocaleString() ?? "—"} combos
              </span>
            </span>
            <span className="text-accent font-mono text-sm">
              ({pct.toFixed(1)}%)
            </span>
            {status?.isDone && (
              <span className="text-accent2 font-mono text-xs bg-accent2/10 px-2 py-0.5 rounded">
                COMPLETE
              </span>
            )}
          </div>
          <span className="text-muted font-mono text-xs">
            {status?.updatedAt
              ? `Updated ${new Date(status.updatedAt).toLocaleTimeString()}`
              : "Not started"}
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-2 bg-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {!autoRun ? (
            <button
              onClick={() => { setError(null); setAutoRun(true); }}
              disabled={status?.isDone || loading}
              className="px-4 py-2 bg-accent/20 border border-accent text-accent font-mono text-sm rounded hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status?.isDone ? "Complete" : "▶ Auto-Run"}
            </button>
          ) : (
            <button
              onClick={() => setAutoRun(false)}
              className="px-4 py-2 bg-accent2/20 border border-accent2 text-accent2 font-mono text-sm rounded hover:bg-accent2/30 transition-colors"
            >
              ⏸ Pause
            </button>
          )}

          <button
            onClick={handleReset}
            disabled={resetting || autoRun}
            className="px-4 py-2 bg-danger/10 border border-danger/40 text-danger font-mono text-sm rounded hover:bg-danger/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {resetting ? "Resetting…" : "↺ Reset"}
          </button>

          {loading && (
            <span className="text-accent font-mono text-xs animate-pulse">
              Running batch…
            </span>
          )}
        </div>

        <p className="text-muted text-[10px] font-mono">
          Auto-Run processes batches while this tab is open.
          Daily cron advances +30 combos when closed (takes ~300 days for full grid).
          For fastest results, keep Auto-Run enabled.
        </p>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div className="bg-danger/10 border border-danger/40 rounded-lg px-4 py-3 text-danger font-mono text-xs">
          {error}
        </div>
      )}

      {/* ── Results table ──────────────────────────────────────────────── */}
      {results.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-white font-mono text-sm">
              Top {results.length} Results
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-muted text-xs font-mono">Sort by:</span>
              <select
                value={sortBy}
                onChange={(e) => handleSortChange(e.target.value as SortColumn)}
                className="bg-bg border border-border rounded px-2 py-1 text-white text-xs font-mono"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="bg-card border-b border-border">
                  <th className="px-3 py-2 text-left text-muted font-normal">#</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Fast</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Slow</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Trend</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">RSI P</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Lo</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Hi</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">SL×</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">TP×</th>
                  <th className="px-3 py-2 text-right text-accent font-normal">Return%</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Sharpe</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">DD%</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">WR%</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Trades</th>
                  <th className="px-3 py-2 text-right text-accent2 font-normal">MC p50</th>
                  <th className="px-3 py-2 text-right text-accent2 font-normal">MC Ret%</th>
                  <th className="px-3 py-2 text-right text-accent2 font-normal">MC Profit%</th>
                  <th className="px-3 py-2 text-center text-muted font-normal">Use</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row, i) => {
                  const p = JSON.parse(row.params_json) as Params;
                  const isLoaded = loadedHash === row.params_hash;
                  return (
                    <tr
                      key={row.params_hash}
                      className={`border-b border-border/50 hover:bg-card/60 transition-colors ${
                        isLoaded ? "bg-accent/5 border-l-2 border-l-accent" : ""
                      }`}
                    >
                      <td className="px-3 py-2 text-muted">{i + 1}</td>
                      <td className="px-3 py-2 text-right text-white">{p.fastEma}</td>
                      <td className="px-3 py-2 text-right text-white">{p.slowEma}</td>
                      <td className="px-3 py-2 text-right text-white">{p.trendEma}</td>
                      <td className="px-3 py-2 text-right text-white">{p.rsiPeriod}</td>
                      <td className="px-3 py-2 text-right text-white">{p.rsiLow}</td>
                      <td className="px-3 py-2 text-right text-white">{p.rsiHigh}</td>
                      <td className="px-3 py-2 text-right text-white">{p.slMult}</td>
                      <td className="px-3 py-2 text-right text-white">{p.tpMult}</td>
                      <td className={`px-3 py-2 text-right font-bold ${colorClass(row.total_return)}`}>
                        {fmt(row.total_return, 1, "%")}
                      </td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.sharpe)}`}>
                        {fmt(row.sharpe)}
                      </td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.max_drawdown, true)}`}>
                        {fmt(row.max_drawdown, 1, "%")}
                      </td>
                      <td className="px-3 py-2 text-right text-white">
                        {fmt(row.win_rate, 1, "%")}
                      </td>
                      <td className="px-3 py-2 text-right text-white">
                        {row.n_trades}
                      </td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.mc_p50 ? row.mc_p50 - 10000 : null)}`}>
                        {fmtDollar(row.mc_p50)}
                      </td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.mc_median_return)}`}>
                        {fmt(row.mc_median_return, 1, "%")}
                      </td>
                      <td className="px-3 py-2 text-right text-accent2">
                        {fmt(row.mc_pct_profit, 1, "%")}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => handleLoadParams(row)}
                          className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                            isLoaded
                              ? "bg-accent/20 border-accent text-accent"
                              : "bg-bg border-border text-muted hover:border-accent hover:text-accent"
                          }`}
                        >
                          {isLoaded ? "Active" : "Load"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {results.length === 0 && status !== null && !loading && (
        <div className="bg-card border border-border rounded-lg p-8 text-center">
          <p className="text-muted font-mono text-sm">
            No results yet. Press{" "}
            <span className="text-accent">▶ Auto-Run</span>{" "}
            to start the optimizer.
          </p>
        </div>
      )}
    </div>
  );
}
