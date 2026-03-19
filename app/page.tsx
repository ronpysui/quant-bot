"use client";

import { useState } from "react";
import BacktestTab from "@/components/tabs/BacktestTab";
import MonteCarloTab from "@/components/tabs/MonteCarloTab";
import PaperTradeTab from "@/components/tabs/PaperTradeTab";
import { DEFAULT_PARAMS, type Params } from "@/lib/strategy";

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"];
const TABS = ["📊 Backtest", "🎲 Monte Carlo", "🤖 Paper Trade"] as const;
type Tab = (typeof TABS)[number];

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs font-mono">
        <span className="text-muted">{label}</span>
        <span className="text-accent">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default function Page() {
  const [activeTab, setActiveTab] = useState<Tab>("📊 Backtest");
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [days, setDays] = useState(365);
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [tradePnls, setTradePnls] = useState<number[]>([]);
  const [aiActive, setAiActive] = useState(false);

  function updateParam<K extends keyof Params>(key: K, val: Params[K]) {
    setParams((p) => ({ ...p, [key]: val }));
  }

  function handleAiParams(newParams: Params) {
    setParams(newParams);
    setAiActive(true);
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 bg-card border-r border-border flex flex-col overflow-y-auto">
        {/* Logo */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-accent text-xl">◈</span>
            <span className="font-bold text-white tracking-tight">QuantScalp</span>
          </div>
          <p className="text-muted text-xs mt-1 font-mono">BB + RSI · 1h · Paper</p>
        </div>

        {/* Market */}
        <div className="p-4 border-b border-border flex flex-col gap-3">
          <p className="text-muted text-xs uppercase tracking-widest font-mono">Market</p>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="bg-bg border border-border rounded px-3 py-2 text-white text-sm font-mono w-full"
          >
            {PAIRS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-muted">History (days)</span>
              <span className="text-accent">{days}</span>
            </div>
            <input
              type="range"
              min={90}
              max={1095}
              step={30}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
            <div className="flex justify-between text-[10px] text-muted font-mono">
              <span>3mo</span>
              <span>3yr</span>
            </div>
          </div>
        </div>

        {/* Strategy Params */}
        <div className="p-4 flex flex-col gap-4 flex-1">
          <div className="flex items-center justify-between">
            <p className="text-muted text-xs uppercase tracking-widest font-mono">Strategy</p>
            {aiActive && (
              <button
                onClick={() => { setParams(DEFAULT_PARAMS); setAiActive(false); }}
                className="text-[10px] text-accent2 font-mono hover:text-white transition-colors"
              >
                ↩ Reset
              </button>
            )}
          </div>
          {aiActive && (
            <div className="text-[10px] font-mono text-accent2 bg-accent2/10 rounded px-2 py-1">
              🤖 AI parameters active
            </div>
          )}
          <Slider label="BB Period" value={params.bbPeriod} min={10} max={50} step={1}
            onChange={(v) => updateParam("bbPeriod", v)} />
          <Slider label="BB Std Dev" value={params.bbStd} min={1} max={3} step={0.1}
            onChange={(v) => updateParam("bbStd", v)} />
          <Slider label="RSI Period" value={params.rsiPeriod} min={7} max={21} step={1}
            onChange={(v) => updateParam("rsiPeriod", v)} />
          <Slider label="RSI Oversold" value={params.rsiOversold} min={20} max={45} step={1}
            onChange={(v) => updateParam("rsiOversold", v)} />
          <Slider label="RSI Overbought" value={params.rsiOverbought} min={55} max={80} step={1}
            onChange={(v) => updateParam("rsiOverbought", v)} />
          <Slider label="Stop Loss (× ATR)" value={params.slMult} min={0.5} max={3} step={0.1}
            onChange={(v) => updateParam("slMult", v)} />
          <Slider label="Take Profit (× ATR)" value={params.tpMult} min={0.5} max={5} step={0.1}
            onChange={(v) => updateParam("tpMult", v)} />
        </div>

        <div className="p-4 border-t border-border">
          <p className="text-[10px] text-muted font-mono">Data: BloFin public API</p>
          <p className="text-[10px] text-muted font-mono">No real orders · Paper only</p>
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="bg-card border-b border-border px-6 flex gap-1 flex-shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "📊 Backtest" && (
            <BacktestTab
              symbol={symbol}
              days={days}
              params={params}
              onAiParams={handleAiParams}
              onTrades={setTradePnls}
            />
          )}
          {activeTab === "🎲 Monte Carlo" && (
            <MonteCarloTab tradePnls={tradePnls} />
          )}
          {activeTab === "🤖 Paper Trade" && (
            <PaperTradeTab symbol={symbol} params={params} />
          )}
        </div>
      </main>
    </div>
  );
}
