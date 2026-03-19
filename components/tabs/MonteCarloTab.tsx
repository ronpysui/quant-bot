"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import MetricCard from "@/components/MetricCard";

const MonteCarloCanvas = dynamic(
  () => import("@/components/charts/MonteCarloCanvas"),
  { ssr: false }
);

interface Props {
  tradePnls: number[];
}

interface MCResult {
  paths: number[][];
  median: number;
  p5: number;
  p95: number;
  pctProfitable: number;
  medianReturn: number;
}

export default function MonteCarloTab({ tradePnls }: Props) {
  const [nSims, setNSims] = useState(500);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MCResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/monte-carlo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradePnls, nSimulations: nSims }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (!tradePnls.length) {
    return (
      <div className="text-center text-muted py-20 font-mono">
        Run a backtest first to generate trade data for simulation.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-lg font-bold text-white">Monte Carlo Simulation</h2>
          <p className="text-muted text-sm">
            Bootstrap resampling of {tradePnls.length} trades → hundreds of plausible equity paths.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-muted text-xs font-mono">Paths</label>
            <select
              value={nSims}
              onChange={(e) => setNSims(Number(e.target.value))}
              className="bg-card border border-border rounded px-2 py-1 text-white text-sm font-mono"
            >
              {[100, 250, 500, 1000].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <button
            onClick={run}
            disabled={loading}
            className="px-6 py-2 rounded-lg bg-accent2 text-white font-bold font-mono text-sm
                       hover:bg-accent2/80 disabled:opacity-50 transition-colors"
          >
            {loading ? "Simulating…" : "▶ Run Simulation"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-danger text-sm">
          {error}
        </div>
      )}

      {result && (
        <>
          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-sm font-mono text-muted mb-3 uppercase tracking-wider">
              {nSims} Equity Paths — Bootstrap Resampled
            </h3>
            <MonteCarloCanvas paths={result.paths} p5={result.p5} p95={result.p95} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Median Return" value={`${result.medianReturn > 0 ? "+" : ""}${result.medianReturn.toFixed(1)}%`} positive={result.medianReturn >= 0} />
            <MetricCard label="5th Percentile" value={`$${result.p5.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} positive={result.p5 >= 10000} />
            <MetricCard label="Median Final" value={`$${result.median.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} positive={result.median >= 10000} />
            <MetricCard label="95th Percentile" value={`$${result.p95.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} positive={true} />
          </div>

          <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
            <span className="text-muted text-sm font-mono">% of simulations profitable</span>
            <span className={`text-2xl font-bold font-mono ${result.pctProfitable >= 50 ? "text-accent" : "text-danger"}`}>
              {result.pctProfitable.toFixed(1)}%
            </span>
          </div>

          <p className="text-muted text-xs font-mono">
            Each path resamples the actual trade outcomes in random order. The band between
            the 5th and 95th percentile represents the statistically likely range of equity trajectories.
          </p>
        </>
      )}

      {!result && !loading && (
        <div className="text-center text-muted py-16 font-mono">
          Click ▶ Run Simulation to generate {nSims} equity paths
        </div>
      )}
    </div>
  );
}
