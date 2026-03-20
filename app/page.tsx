"use client";

import { useState, useEffect } from "react";
import BacktestTab from "@/components/tabs/BacktestTab";
import MonteCarloTab from "@/components/tabs/MonteCarloTab";
import PaperTradeTab from "@/components/tabs/PaperTradeTab";
import StrategyMakerTab from "@/components/tabs/StrategyMakerTab";
import { DEFAULT_PARAMS, MNQ_DEFAULT_PARAMS, type Params } from "@/lib/strategy";

// Crypto: BloFin perpetual format (symbol:settle)
// Futures: Yahoo Finance CME format (symbol=F)
const PAIRS = [
  "BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT", "XRP/USDT:USDT", "DOGE/USDT:USDT",
  "MNQ=F", "NQ=F",
];
const PAIR_LABELS: Record<string, string> = {
  "BTC/USDT:USDT":  "BTC/USDT",
  "ETH/USDT:USDT":  "ETH/USDT",
  "SOL/USDT:USDT":  "SOL/USDT",
  "XRP/USDT:USDT":  "XRP/USDT",
  "DOGE/USDT:USDT": "DOGE/USDT",
  "MNQ=F":          "MNQ (Micro NQ)",
  "NQ=F":           "NQ (E-mini NQ)",
};
const TABS = ["📊 Backtest", "🎲 Monte Carlo", "🤖 Paper Trade", "⚙ Optimizer"] as const;
type Tab = (typeof TABS)[number];

function Toggle({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <div className="flex items-center justify-between text-xs font-mono">
      <span className="text-muted">{label}</span>
      <button
        onClick={onChange}
        className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors duration-200 focus:outline-none ${
          checked ? "bg-accent" : "bg-border"
        }`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-5" : "translate-x-0"
        }`} />
      </button>
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number;
  step: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs font-mono">
        <span className="text-muted">{label}</span>
        <span className="text-accent">{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

const LS_PARAMS  = "qs:params";
const LS_SYMBOL  = "qs:symbol";
const LS_DAYS    = "qs:days";
const LS_VERSION = "qs:version";
const CURRENT_VERSION = "6"; // bump when Params shape changes to force a reset

export default function Page() {
  const [activeTab, setActiveTab] = useState<Tab>("📊 Backtest");
  const [symbol, setSymbol] = useState<string>("BTC/USDT:USDT");
  const [days,   setDays]   = useState<number>(365);
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [tradePnls, setTradePnls] = useState<number[]>([]);
  const [aiActive, setAiActive]   = useState(false);

  // Derived: is the current symbol a CME futures contract?
  const isFutures = symbol.endsWith("=F");

  // ── Restore persisted values after hydration ────────────────────────────
  useEffect(() => {
    try {
      const storedVersion = localStorage.getItem(LS_VERSION);
      if (storedVersion !== CURRENT_VERSION) {
        localStorage.removeItem(LS_PARAMS);
        localStorage.setItem(LS_VERSION, CURRENT_VERSION);
      }
      const s = localStorage.getItem(LS_SYMBOL);
      const d = localStorage.getItem(LS_DAYS);
      const p = localStorage.getItem(LS_PARAMS);
      if (s) setSymbol(JSON.parse(s));
      if (d) setDays(JSON.parse(d));
      if (p) setParams({ ...DEFAULT_PARAMS, ...JSON.parse(p) });
    } catch { /* ignore corrupt storage */ }
  }, []);

  // ── Auto-load #1 optimizer result on mount (crypto only) ────────────────
  useEffect(() => {
    async function loadBestStrategy() {
      try {
        const res  = await fetch("/api/strategy-maker?sortBy=total_return");
        const data = await res.json();
        if (data.error || !data.results?.length) return;
        const bestParams = JSON.parse(data.results[0].params_json);
        let userCapital     = DEFAULT_PARAMS.initialCapital;
        let userAllowShorts = DEFAULT_PARAMS.allowShorts;
        try {
          const stored = localStorage.getItem(LS_PARAMS);
          if (stored) {
            const p = JSON.parse(stored);
            if (typeof p.initialCapital === "number")  userCapital     = p.initialCapital;
            if (typeof p.allowShorts    === "boolean") userAllowShorts = p.allowShorts;
          }
        } catch { /* ignore */ }
        handleAiParams({ ...DEFAULT_PARAMS, ...bestParams, initialCapital: userCapital, allowShorts: userAllowShorts });
      } catch { /* optimizer may have no results yet */ }
    }
    loadBestStrategy();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist changes ─────────────────────────────────────────────────────
  useEffect(() => { localStorage.setItem(LS_PARAMS, JSON.stringify(params)); }, [params]);
  useEffect(() => { localStorage.setItem(LS_SYMBOL, JSON.stringify(symbol)); }, [symbol]);
  useEffect(() => { localStorage.setItem(LS_DAYS,   JSON.stringify(days));   }, [days]);

  function updateParam<K extends keyof Params>(key: K, val: Params[K]) {
    setParams((p) => ({ ...p, [key]: val }));
  }

  function handleAiParams(newParams: Params) {
    setParams(newParams);
    setAiActive(true);
  }

  // ── Symbol change: auto-switch param preset on asset-class change ────────
  function handleSymbolChange(newSymbol: string) {
    setSymbol(newSymbol);
    const toFutures = newSymbol.endsWith("=F") && !symbol.endsWith("=F");
    const toCrypto  = !newSymbol.endsWith("=F") && symbol.endsWith("=F");
    if (toFutures) {
      const multiplier = newSymbol.startsWith("NQ") ? 20 : 2;
      const minCap     = newSymbol.startsWith("NQ") ? 20000 : 5000;
      setParams({ ...MNQ_DEFAULT_PARAMS, contractMultiplier: multiplier, initialCapital: minCap });
      setAiActive(false);
    } else if (toCrypto) {
      // Crypto only supports mean rev — scalp is futures-only
      setParams({ ...DEFAULT_PARAMS, initialCapital: 1000 });
      setAiActive(false);
    } else if (!newSymbol.endsWith("=F") && params.strategy === "scalp") {
      // Switching between crypto pairs while somehow on scalp — reset to meanrev
      updateParam("strategy", "meanrev");
    }
  }

  // ── Days: futures use 1H up to 730 days, then auto-switch to 1D bars ───
  // Yahoo Finance caps 60m intraday at ~730 days; daily bars go back 10+ yrs.
  // MNQ launched May 2019 (~1800 days), so 1825 days (5yr) covers near-all history.
  const maxDays    = isFutures ? 1825 : 3650;
  const cappedDays = Math.min(days, maxDays);
  const isDaily1D  = isFutures && cappedDays > 730;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Sidebar ────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 bg-card border-r border-border flex flex-col overflow-y-auto">
        {/* Logo */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-accent text-xl">◈</span>
            <span className="font-bold text-white tracking-tight">QuantScalp</span>
          </div>
          <p className="text-muted text-xs mt-1 font-mono">
            {isFutures
              ? (params.strategy === "scalp" ? "EMA Scalp · 9:30–11:00 ET" : "BB + RSI Rev")
              : "BB + RSI Mean Rev"
            } · {isDaily1D ? "1D" : "1H"} · {isFutures ? "Futures" : "Crypto"}
          </p>
        </div>

        {/* Market */}
        <div className="p-4 border-b border-border flex flex-col gap-3">

          {/* ── Crypto section ─────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-muted text-[10px] font-mono uppercase tracking-widest w-14">Crypto</span>
              <span className="text-[9px] font-mono text-muted/60">BloFin · Mean Rev only</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              {PAIRS.filter((p) => !p.endsWith("=F")).map((p) => (
                <button
                  key={p}
                  onClick={() => handleSymbolChange(p)}
                  className={`px-2.5 py-1 rounded text-xs font-mono border transition-colors ${
                    symbol === p
                      ? "bg-accent/20 border-accent text-accent font-bold"
                      : "border-border text-muted hover:text-white hover:border-white/30"
                  }`}
                >
                  {PAIR_LABELS[p]?.split("/")[0] ?? p}
                </button>
              ))}
            </div>
          </div>

          {/* ── Futures section ────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-muted text-[10px] font-mono uppercase tracking-widest w-14">Futures</span>
              <span className="text-[9px] font-mono text-muted/60">Yahoo Finance · Scalp + Mean Rev</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              {PAIRS.filter((p) => p.endsWith("=F")).map((p) => (
                <button
                  key={p}
                  onClick={() => handleSymbolChange(p)}
                  className={`px-2.5 py-1 rounded text-xs font-mono border transition-colors ${
                    symbol === p
                      ? "bg-accent2/20 border-accent2 text-accent2 font-bold"
                      : "border-border text-muted hover:text-white hover:border-white/30"
                  }`}
                >
                  {p === "MNQ=F" ? "MNQ" : "NQ"}
                </button>
              ))}
            </div>
            {isFutures && (
              <div className="text-[10px] font-mono text-accent2/80 bg-accent2/10 rounded px-2 py-1.5 flex flex-col gap-0.5">
                <span className="font-bold text-accent2">
                  {symbol === "MNQ=F" ? "Micro E-mini Nasdaq-100" : "E-mini Nasdaq-100"}
                </span>
                <span className="text-muted">
                  ${params.contractMultiplier}/pt · CME margin ~${symbol === "MNQ=F" ? "2,200" : "22,000"}
                </span>
                <span className="text-muted">Min recommended: ${symbol === "MNQ=F" ? "5,000" : "50,000"}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-muted">History (days)</span>
              <div className="flex items-center gap-1.5">
                {isDaily1D && (
                  <span className="text-[9px] font-mono bg-accent2/20 text-accent2 rounded px-1.5 py-0.5">
                    1D bars
                  </span>
                )}
                <span className="text-accent">{cappedDays}</span>
              </div>
            </div>
            <input
              type="range"
              min={90}
              max={maxDays}
              step={30}
              value={cappedDays}
              onChange={(e) => setDays(Number(e.target.value))}
            />
            <div className="flex justify-between text-[10px] text-muted font-mono">
              <span>3mo</span>
              <span>{isFutures ? (isDaily1D ? "5yr (1D)" : "2yr · drag for 1D →") : "10yr"}</span>
            </div>
            {isDaily1D && (
              <p className="text-[10px] font-mono text-muted leading-snug">
                Intraday window filter disabled on daily bars. Signals fire on price conditions only.
              </p>
            )}
          </div>
        </div>

        {/* Strategy Params */}
        <div className="p-4 flex flex-col gap-4 flex-1">
          <div className="flex items-center justify-between">
            <p className="text-muted text-xs uppercase tracking-widest font-mono">Strategy</p>
            {aiActive && (
              <button
                onClick={() => { setParams(isFutures ? MNQ_DEFAULT_PARAMS : DEFAULT_PARAMS); setAiActive(false); }}
                className="text-[10px] text-accent2 font-mono hover:text-white transition-colors"
              >
                ↩ Reset
              </button>
            )}
          </div>
          {aiActive && (
            <div className="text-[10px] font-mono text-accent2 bg-accent2/10 rounded px-2 py-1">
              AI parameters active
            </div>
          )}

          {/* Strategy selector — Scalp is futures-only */}
          <div className="flex flex-col gap-2">
            {/* Crypto: Mean Rev is the only strategy */}
            {!isFutures && (
              <div className="flex flex-col gap-1.5">
                <div className="rounded-lg overflow-hidden border border-border text-xs font-mono">
                  <div className="w-full py-1.5 text-center bg-accent text-bg font-bold">Mean Rev</div>
                </div>
                <p className="text-[10px] font-mono text-muted">
                  Scalp strategy is futures-only (9:30–11:00 ET session window).
                </p>
              </div>
            )}
            {/* Futures: both strategies available */}
            {isFutures && (
              <>
                <div className="flex rounded-lg overflow-hidden border border-border text-xs font-mono">
                  {(["meanrev", "scalp"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => updateParam("strategy", s)}
                      className={`flex-1 py-1.5 transition-colors ${
                        params.strategy === s
                          ? "bg-accent text-bg font-bold"
                          : "text-muted hover:text-white"
                      }`}
                    >
                      {s === "meanrev" ? "Mean Rev" : "Scalp"}
                    </button>
                  ))}
                </div>
                {params.strategy === "scalp" && (
                  <div className="text-[10px] font-mono text-accent2 bg-accent2/10 rounded px-2 py-1.5 flex flex-col gap-0.5">
                    <span className="font-bold">EMA Trend + BB Touch</span>
                    <span className="text-muted">9:30–11:00 ET · max 2 trades/session</span>
                    <span className="text-muted">EMA up + below VWAP + vol spike + BB dip</span>
                    <span className="text-muted">TP = ATR target (fast exit)</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Starting capital */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-muted">Starting capital</span>
              <span className="text-accent">${(params.initialCapital ?? 1000).toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={isFutures ? 2000 : 100}
              max={isFutures ? 500000 : 100000}
              step={isFutures ? 500 : 100}
              value={params.initialCapital ?? (isFutures ? 5000 : 1000)}
              onChange={(e) => updateParam("initialCapital", Number(e.target.value))}
            />
            <div className="flex justify-between text-[10px] text-muted font-mono">
              <span>{isFutures ? "$2k" : "$100"}</span>
              <span>{isFutures ? "$500k" : "$100k"}</span>
            </div>
          </div>

          {/* Position size — crypto only */}
          {!isFutures && (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-muted">Position size</span>
                <span className="text-accent">{(params.positionSizePct * 100).toFixed(1)}% / trade</span>
              </div>
              <input
                type="range" min={0.001} max={1.0} step={0.001}
                value={params.positionSizePct}
                onChange={(e) => updateParam("positionSizePct", Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-muted font-mono">
                <span>0.1%</span><span>100%</span>
              </div>
            </div>
          )}

          {/* Contracts — futures only */}
          {isFutures && (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-muted">Contracts</span>
                <span className="text-accent">{params.numContracts} × ${params.contractMultiplier}/pt</span>
              </div>
              <input
                type="range" min={1} max={10} step={1}
                value={params.numContracts}
                onChange={(e) => updateParam("numContracts", Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-muted font-mono">
                <span>1 contract</span><span>10 contracts</span>
              </div>
            </div>
          )}

          <Slider label="BB Period"       value={params.bbPeriod}    min={10} max={32}  step={1}   onChange={(v) => updateParam("bbPeriod", v)} />
          <Slider label="BB Std Dev (σ)"  value={params.bbStdDev}    min={1.0} max={3.0} step={0.1} onChange={(v) => updateParam("bbStdDev", v)} />
          <Slider label="RSI Period"      value={params.rsiPeriod}   min={7}  max={21}  step={1}   onChange={(v) => updateParam("rsiPeriod", v)} />
          {params.strategy === "meanrev" && (
            <Slider label="RSI Oversold"  value={params.rsiOversold} min={20} max={45}  step={1}   onChange={(v) => updateParam("rsiOversold", v)} />
          )}
          {params.strategy === "scalp" && (
            <>
              <Slider label="EMA Fast"    value={params.emaFast}     min={5}  max={20}  step={1}   onChange={(v) => updateParam("emaFast", v)} />
              <Slider label="EMA Slow"    value={params.emaSlow}     min={10} max={50}  step={1}   onChange={(v) => updateParam("emaSlow", v)} />
              <Slider label="RSI Mid (entry filter)" value={params.rsiMid} min={40} max={65} step={1} onChange={(v) => updateParam("rsiMid", v)} />
              <Slider label="ATR Target (× ATR)"     value={params.atrTarget} min={0.5} max={3.0} step={0.1} onChange={(v) => updateParam("atrTarget", v)} />
              <Slider label="Vol Filter (× SMA)"     value={params.volFilter} min={1.0} max={2.0} step={0.1} onChange={(v) => updateParam("volFilter", v)} />
            </>
          )}
          <Slider label="Stop Loss (× ATR)" value={params.slMult}   min={0.5} max={4}  step={0.1} onChange={(v) => updateParam("slMult", v)} />

          {/* Fee — crypto: percentage, futures: flat dollar */}
          {!isFutures ? (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-muted">Fee / side</span>
                <span className="text-accent">{(params.feePct * 100).toFixed(3)}%</span>
              </div>
              <input
                type="range" min={0.0001} max={0.001} step={0.0001}
                value={params.feePct}
                onChange={(e) => updateParam("feePct", Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-muted font-mono">
                <span>0.01% maker</span><span>0.10% taker</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-muted">Fee / contract / side</span>
                <span className="text-accent">${params.feeDollar.toFixed(2)}</span>
              </div>
              <input
                type="range" min={0.5} max={5.0} step={0.25}
                value={params.feeDollar}
                onChange={(e) => updateParam("feeDollar", Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-muted font-mono">
                <span>$0.50 min</span><span>$5.00 max</span>
              </div>
            </div>
          )}

          <Toggle label="Allow shorts"
            checked={params.allowShorts}
            onChange={() => updateParam("allowShorts", !params.allowShorts)} />

          {/* RTH filter — futures only */}
          {isFutures && (
            <Toggle label="RTH only (9:30–4:15 ET)"
              checked={params.filterRTH}
              onChange={() => updateParam("filterRTH", !params.filterRTH)} />
          )}

          <p className="text-muted text-xs uppercase tracking-widest font-mono pt-2">Fixed Config</p>
          <div className="flex flex-col gap-1.5">
            {[
              { label: "Timeframe",   value: "1H candles" },
              ...(params.strategy === "scalp" ? [
                { label: "Window",  value: "9:30–11:00 ET · max 2 trades/session" },
                { label: "Entry",   value: `EMA${params.emaFast}>${params.emaSlow} + below VWAP + vol>${params.volFilter}×SMA + BB touch + RSI<${params.rsiMid}` },
                { label: "Exit",    value: `ATR × ${params.atrTarget} target` },
              ] : [
                { label: "Entry",  value: `Close < BB lower + RSI < ${params.rsiOversold}` },
                { label: "Exit",   value: "Reversion to BB middle" },
              ]),
              { label: "Stop loss",   value: `${params.slMult}x ATR` },
              { label: "Data source", value: isFutures ? "Yahoo Finance" : "BloFin / CryptoCompare" },
              ...(isFutures ? [{ label: "Contract", value: `${PAIR_LABELS[symbol]} · $${params.contractMultiplier}/pt` }] : []),
              { label: "Mode",        value: "Paper only" },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between items-start gap-2">
                <span className="text-muted font-mono text-[10px] shrink-0">{label}</span>
                <span className="text-white font-mono text-[10px] text-right">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* ── Main area ──────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="bg-card border-b border-border px-6 flex gap-1 flex-shrink-0">
          {TABS.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-mono transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-white"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "📊 Backtest" && (
            <BacktestTab symbol={symbol} days={cappedDays} params={params}
              onAiParams={handleAiParams} onTrades={setTradePnls} />
          )}
          {activeTab === "🎲 Monte Carlo" && <MonteCarloTab tradePnls={tradePnls} />}
          {activeTab === "🤖 Paper Trade" && <PaperTradeTab symbol={symbol} params={params} />}
          {activeTab === "⚙ Optimizer"   && <StrategyMakerTab onLoadParams={handleAiParams} />}
        </div>
      </main>
    </div>
  );
}
