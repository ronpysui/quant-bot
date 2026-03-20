"use client";

import { useEffect, useRef, useState } from "react";
import type { Params } from "@/lib/strategy";
import type { OptimizerStatus, StrategyRow, SortColumn, StrategyType } from "@/lib/strategy-maker";

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

const OPT_PAIRS = [
  { value: "BTC/USDT:USDT",  label: "BTC/USDT",       group: "Crypto" },
  { value: "ETH/USDT:USDT",  label: "ETH/USDT",       group: "Crypto" },
  { value: "SOL/USDT:USDT",  label: "SOL/USDT",       group: "Crypto" },
  { value: "XRP/USDT:USDT",  label: "XRP/USDT",       group: "Crypto" },
  { value: "DOGE/USDT:USDT", label: "DOGE/USDT",      group: "Crypto" },
  { value: "MNQ=F",          label: "MNQ (Micro NQ)", group: "Futures" },
  { value: "NQ=F",           label: "NQ (E-mini NQ)", group: "Futures" },
];

const STRATEGY_LABELS: Record<StrategyType, string> = { meanrev: "Mean Rev", scalp: "Scalp" };

function combosForStrategy(strategy: StrategyType): number {
  return strategy === "scalp" ? 3_888 : 15_120;
}

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
  return (inverse ? v < 0 : v > 0) ? "text-accent" : "text-danger";
}
function formatEta(ms: number): string {
  if (ms <= 0) return "almost done";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `~${secs}s remaining`;
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  if (mins < 60) return `~${mins}m ${s}s remaining`;
  return `~${Math.floor(mins / 60)}h ${mins % 60}m remaining`;
}

export default function StrategyMakerTab({ onLoadParams }: Props) {
  const [strategy, setStrategy] = useState<StrategyType>("meanrev");
  const [symbol,   setSymbol]   = useState<string>("BTC/USDT:USDT");
  const [status,   setStatus]   = useState<OptimizerStatus | null>(null);
  const [results,  setResults]  = useState<StrategyRow[]>([]);
  const [sortBy,   setSortBy]   = useState<SortColumn>("total_return");
  const [autoRun,  setAutoRun]  = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loadedHash, setLoadedHash] = useState<string | null>(null);
  const [eta,      setEta]      = useState<string | null>(null);

  const runningRef    = useRef(false);
  const sortRef       = useRef<SortColumn>("total_return");
  const strategyRef   = useRef<StrategyType>("meanrev");
  const symbolRef     = useRef<string>("BTC/USDT:USDT");
  const batchStartRef = useRef<number>(0);
  const avgBatchMsRef = useRef<number>(0);
  const batchCountRef = useRef<number>(0);

  // Load status + results whenever strategy or symbol changes
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus(null);
      setResults([]);
      setError(null);
      setEta(null);
      setLoadedHash(null);
      try {
        const url = `/api/strategy-maker?sortBy=total_return&strategy=${strategyRef.current}&symbol=${encodeURIComponent(symbolRef.current)}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setStatus(data.status);
        setResults(data.results);
        setSortBy("total_return");
        sortRef.current = "total_return";
        if (!data.status.isDone) setAutoRun(true);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [strategy, symbol]);

  // Auto-run loop
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
          batchStartRef.current = Date.now();
          const res = await fetch("/api/strategy-maker", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batchSize: 1000,
              sortBy:    sortRef.current,
              strategy:  strategyRef.current,
              symbol:    symbolRef.current,
            }),
          });
          const data = await res.json();
          if (data.error) { setError(data.error); break; }

          const elapsed = Date.now() - batchStartRef.current;
          batchCountRef.current += 1;
          avgBatchMsRef.current = batchCountRef.current === 1
            ? elapsed
            : 0.7 * avgBatchMsRef.current + 0.3 * elapsed;
          const remaining   = data.status.totalCombos - data.status.completed;
          const batchesLeft = Math.ceil(remaining / 1000);
          setEta(batchesLeft > 0 ? formatEta(batchesLeft * avgBatchMsRef.current) : null);

          setStatus(data.status);
          setResults(data.results);
          if (data.status.isDone) { setAutoRun(false); setEta(null); break; }
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e));
          break;
        } finally {
          runningRef.current = false;
          setLoading(false);
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    loop();
    return () => { cancelled = true; };
  }, [autoRun]);

  function stopAndReset() {
    setAutoRun(false);
    runningRef.current = false;
    batchCountRef.current = 0;
    avgBatchMsRef.current = 0;
  }

  function handleStrategyChange(s: StrategyType) {
    if (s === strategyRef.current) return;
    stopAndReset();
    strategyRef.current = s;
    setStrategy(s);
  }

  function handleSymbolChange(s: string) {
    if (s === symbolRef.current) return;
    stopAndReset();
    symbolRef.current = s;
    setSymbol(s);
  }

  async function handleReset() {
    const label = OPT_PAIRS.find((p) => p.value === symbolRef.current)?.label ?? symbolRef.current;
    if (!confirm(`Reset ${strategy} results for ${label}? This cannot be undone.`)) return;
    setResetting(true);
    setError(null);
    try {
      await fetch(
        `/api/strategy-maker?strategy=${strategyRef.current}&symbol=${encodeURIComponent(symbolRef.current)}`,
        { method: "DELETE" }
      );
      setResults([]);
      setLoadedHash(null);
      const res  = await fetch(
        `/api/strategy-maker?sortBy=${sortRef.current}&strategy=${strategyRef.current}&symbol=${encodeURIComponent(symbolRef.current)}`
      );
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
      const res  = await fetch(
        `/api/strategy-maker?sortBy=${col}&strategy=${strategyRef.current}&symbol=${encodeURIComponent(symbolRef.current)}`
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setStatus(data.status);
      setResults(data.results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleLoadParams(row: StrategyRow) {
    const parsed = JSON.parse(row.params_json);
    onLoadParams(parsed as Params);
    setLoadedHash(row.params_hash);
  }

  const pct     = status ? Math.min(100, (status.completed / Math.max(1, status.totalCombos)) * 100) : 0;
  const isScalp = strategy === "scalp";
  const isFuturesSym = symbol.endsWith("=F");
  const symLabel = OPT_PAIRS.find((p) => p.value === symbol)?.label ?? symbol;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Header + selectors ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-white font-bold text-lg tracking-tight">Strategy Optimizer</h2>
            <p className="text-muted text-xs font-mono mt-1">
              {combosForStrategy(strategy).toLocaleString()} combos · {symLabel} · {isFuturesSym ? "1H/1D · 5yr" : "1H · 3yr"} backtest + 1000 MC paths
            </p>
          </div>
        </div>

        {/* Strategy selector */}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-muted text-[10px] font-mono uppercase tracking-widest w-14">Strategy</span>
          <div className="flex rounded-lg overflow-hidden border border-border text-xs font-mono">
            {(["meanrev", "scalp"] as StrategyType[]).map((s) => (
              <button key={s} onClick={() => handleStrategyChange(s)} disabled={autoRun}
                className={`px-4 py-2 transition-colors disabled:opacity-50 ${
                  strategy === s ? "bg-accent text-bg font-bold" : "text-muted hover:text-white"
                }`}
              >
                {STRATEGY_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {/* Pair selector — split Crypto / Futures */}
        <div className="flex flex-col gap-1.5">
          {(["Crypto", "Futures"] as const).map((group) => (
            <div key={group} className="flex gap-2 items-center">
              <span className="text-muted text-[10px] font-mono uppercase tracking-widest w-14">{group}</span>
              <div className="flex gap-1 flex-wrap">
                {OPT_PAIRS.filter((p) => p.group === group).map((p) => (
                  <button
                    key={p.value}
                    disabled={autoRun}
                    onClick={() => handleSymbolChange(p.value)}
                    className={`px-3 py-1 rounded text-xs font-mono border transition-colors disabled:opacity-50 ${
                      symbol === p.value
                        ? "bg-accent2/20 border-accent2 text-accent2 font-bold"
                        : "border-border text-muted hover:text-white hover:border-white/30"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                {group === "Futures" && isFuturesSym && (
                  <span className="self-center text-[10px] font-mono text-accent2 bg-accent2/10 rounded px-2 py-1 ml-1">
                    Yahoo Finance · 1H≤730d → 1D up to 5yr
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
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
            <span className="text-accent font-mono text-sm">({pct.toFixed(1)}%)</span>
            {status?.isDone && (
              <span className="text-accent2 font-mono text-xs bg-accent2/10 px-2 py-0.5 rounded">COMPLETE</span>
            )}
          </div>
          <span className="text-muted font-mono text-xs">
            {status?.updatedAt ? `Updated ${new Date(status.updatedAt).toLocaleTimeString()}` : "Not started"}
          </span>
        </div>

        <div className="h-2 bg-bg rounded-full overflow-hidden">
          <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>

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
              onClick={() => { setAutoRun(false); setEta(null); }}
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

          {loading && <span className="text-accent font-mono text-xs animate-pulse">Running batch…</span>}
          {eta && autoRun && <span className="text-muted font-mono text-xs">{eta}</span>}
        </div>

        <p className="text-muted text-[10px] font-mono">
          Results are stored per strategy + pair — switching resets the view, not the data.
          {isScalp ? " Scalp: 3,888 combos." : " Mean Rev: 15,120 combos."}
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
            <h3 className="text-white font-mono text-sm">Top {results.length} Results</h3>
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
                  {isScalp ? (
                    <>
                      <th className="px-3 py-2 text-right text-muted font-normal">BB P</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">BB σ</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">EMA F</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">EMA S</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">RSI Mid</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">ATR Tgt</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">SL×</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2 text-right text-muted font-normal">BB Per</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">BB σ</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">RSI P</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">Ovrsld</th>
                      <th className="px-3 py-2 text-right text-muted font-normal">SL×</th>
                    </>
                  )}
                  <th className="px-3 py-2 text-right text-accent font-normal">Return%</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Sharpe</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">DD%</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">WR%</th>
                  <th className="px-3 py-2 text-right text-muted font-normal">Trades</th>
                  <th className="px-3 py-2 text-right text-accent2 font-normal">MC p50</th>
                  <th className="px-3 py-2 text-right text-accent2 font-normal">MC Ret%</th>
                  <th className="px-3 py-2 text-right text-accent2 font-normal">MC Win%</th>
                  <th className="px-3 py-2 text-center text-muted font-normal">Use</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row, i) => {
                  const p = JSON.parse(row.params_json) as Params;
                  const isLoaded = loadedHash === row.params_hash;
                  return (
                    <tr key={row.params_hash}
                      className={`border-b border-border/50 hover:bg-card/60 transition-colors ${
                        isLoaded ? "bg-accent/5 border-l-2 border-l-accent" : ""
                      }`}
                    >
                      <td className="px-3 py-2 text-muted">{i + 1}</td>
                      {isScalp ? (
                        <>
                          <td className="px-3 py-2 text-right text-white">{p.bbPeriod}</td>
                          <td className="px-3 py-2 text-right text-white">{p.bbStdDev}</td>
                          <td className="px-3 py-2 text-right text-white">{p.emaFast}</td>
                          <td className="px-3 py-2 text-right text-white">{p.emaSlow}</td>
                          <td className="px-3 py-2 text-right text-white">{p.rsiMid}</td>
                          <td className="px-3 py-2 text-right text-white">{p.atrTarget}</td>
                          <td className="px-3 py-2 text-right text-white">{p.slMult}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right text-white">{p.bbPeriod}</td>
                          <td className="px-3 py-2 text-right text-white">{p.bbStdDev}</td>
                          <td className="px-3 py-2 text-right text-white">{p.rsiPeriod}</td>
                          <td className="px-3 py-2 text-right text-white">{p.rsiOversold}</td>
                          <td className="px-3 py-2 text-right text-white">{p.slMult}</td>
                        </>
                      )}
                      <td className={`px-3 py-2 text-right font-bold ${colorClass(row.total_return)}`}>
                        {fmt(row.total_return, 1, "%")}
                      </td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.sharpe)}`}>{fmt(row.sharpe)}</td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.max_drawdown, true)}`}>
                        {fmt(row.max_drawdown, 1, "%")}
                      </td>
                      <td className="px-3 py-2 text-right text-white">{fmt(row.win_rate, 1, "%")}</td>
                      <td className="px-3 py-2 text-right text-white">{row.n_trades}</td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.mc_p50 ? row.mc_p50 - 10000 : null)}`}>
                        {fmtDollar(row.mc_p50)}
                      </td>
                      <td className={`px-3 py-2 text-right ${colorClass(row.mc_median_return)}`}>
                        {fmt(row.mc_median_return, 1, "%")}
                      </td>
                      <td className="px-3 py-2 text-right text-accent2">{fmt(row.mc_pct_profit, 1, "%")}</td>
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

      {results.length === 0 && status !== null && !loading && (
        <div className="bg-card border border-border rounded-lg p-8 text-center">
          <p className="text-muted font-mono text-sm">
            No results for {STRATEGY_LABELS[strategy]} · {symLabel}. Press{" "}
            <span className="text-accent">▶ Auto-Run</span> to start.
          </p>
        </div>
      )}
    </div>
  );
}
