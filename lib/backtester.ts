import { addIndicators, type Params } from "./strategy";
import type { Candle } from "./data";

export interface Trade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  slPrice: number;        // stop-loss level at entry time
  tpPrice: number;        // take-profit = BB middle locked at entry
  pnl: number;
  returnPct: number;
  positionValue: number;  // USD notional of this specific trade
  capitalAtEntry: number; // portfolio balance at the moment of entry
}

export interface Metrics {
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  nTrades: number;
  avgWin: number;
  avgLoss: number;
  avgDurationHrs: number;
  finalCapital: number;
}

export interface BacktestResult {
  equityCurve: { ts: number; value: number }[];
  trades: Trade[];
  metrics: Metrics;
}

// ── ET time helpers ───────────────────────────────────────────────────────────
function dstBounds(yr: number): { start: number; end: number } {
  const mar1dow  = new Date(Date.UTC(yr, 2,  1)).getUTCDay();
  const nov1dow  = new Date(Date.UTC(yr, 10, 1)).getUTCDay();
  return {
    start: Date.UTC(yr, 2,  8  + (7 - mar1dow) % 7, 7), // 2 AM ET in March
    end:   Date.UTC(yr, 10, 1  + (7 - nov1dow) % 7, 6), // 2 AM ET in November
  };
}

// Returns YYYY-MM-DD in approximate ET (UTC-5, ignores DST — fine for day boundary)
function getETDate(ts: number): string {
  return new Date(ts - 5 * 3_600_000).toISOString().slice(0, 10);
}

// ── RTH helper (US Eastern Regular Trading Hours) ────────────────────────────
// Returns true if `ts` (unix ms UTC) falls within 9:30 AM–4:15 PM ET on a weekday.
export function isRTH(ts: number): boolean {
  const d = new Date(ts);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const { start, end } = dstBounds(d.getUTCFullYear());
  const isDST  = ts >= start && ts < end;
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open   = isDST ? 13 * 60 + 30 : 14 * 60 + 30; // 9:30 ET
  const close  = isDST ? 20 * 60 + 15 : 21 * 60 + 15; // 4:15 ET
  return utcMin >= open && utcMin < close;
}

// ── Scalp window: 9:30 AM – 11:00 AM ET (morning high-liquidity session) ─────
// Tighter than RTH — highest-quality price discovery window for NQ/MNQ scalps.
export function isScalpWindow(ts: number): boolean {
  const d = new Date(ts);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const { start, end } = dstBounds(d.getUTCFullYear());
  const isDST  = ts >= start && ts < end;
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open   = isDST ? 13 * 60 + 30 : 14 * 60 + 30; // 9:30 ET
  const close  = isDST ? 15 * 60      : 16 * 60;       // 11:00 ET
  return utcMin >= open && utcMin < close;
}

// ── PnL helpers (routes between crypto % and futures pts×multiplier) ─────────
function calcPnl(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  params: Params,
  positionValue: number
): number {
  if (params.assetType === "futures") {
    const pts = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
    return pts * params.contractMultiplier * params.numContracts;
  }
  const pct = direction === "long"
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  return pct * positionValue;
}

function calcFee(params: Params, positionValue: number): number {
  return params.assetType === "futures"
    ? params.feeDollar * params.numContracts
    : positionValue * params.feePct;
}

function calcUnrealized(
  position: 1 | -1,
  closePrice: number,
  entryPrice: number,
  params: Params,
  positionValue: number
): number {
  if (params.assetType === "futures") {
    const pts = position === 1 ? closePrice - entryPrice : entryPrice - closePrice;
    return pts * params.contractMultiplier * params.numContracts;
  }
  const pct = position === 1
    ? (closePrice - entryPrice) / entryPrice
    : (entryPrice - closePrice) / entryPrice;
  return pct * positionValue;
}

export function runBacktest(candles: Candle[], params: Params): BacktestResult {
  const bars = addIndicators(candles, params);

  // ── Detect daily bars from bar spacing ────────────────────────────────────
  // Yahoo Finance 1D bars are ≥ 20 h apart; 1H bars are exactly 1 h apart.
  // When daily, intraday time-based filters (RTH window, session limit) are
  // irrelevant — signals fire on price conditions alone across all sessions.
  const isDaily = bars.length > 1 && (bars[1].ts - bars[0].ts) >= 20 * 3_600_000;

  const INITIAL_CAPITAL = params.initialCapital;
  let capital           = INITIAL_CAPITAL;
  let position: 0 | 1 | -1 = 0;
  let entryPrice     = 0;
  let entryAtr       = 0;
  let positionValue  = 0;
  let capitalAtEntry = 0;
  let entryTime      = 0;
  let currentSL   = 0;
  let tpTarget    = 0; // take-profit level locked at entry (BB middle or ATR-based)

  const equityCurve: { ts: number; value: number }[] = [
    { ts: bars[0].ts, value: capital },
  ];
  const trades: Trade[] = [];

  // ── Per-session trade counter (scalp only) ─────────────────────────────────
  // Reset on each new ET calendar day; cap entries at 2 when filterRTH is on.
  let sessionDate    = "";
  let sessionEntries = 0;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const bar  = bars[i];

    if (position === 0) {
      // ── Entry Signals (strategy-aware) ────────────────────────────────────
      const rthOk = !params.filterRTH || isRTH(prev.ts);
      let longSignal: boolean;
      let shortSignal: boolean;

      if (params.strategy === "scalp") {
        // Refresh session counter on each new ET day
        const barETDate = getETDate(bar.ts);
        if (barETDate !== sessionDate) { sessionDate = barETDate; sessionEntries = 0; }

        // 9:30–11:00 ET window — irrelevant for daily bars (no intraday time)
        const windowOk  = isDaily || !params.filterRTH || isScalpWindow(prev.ts);
        // Max 2 trades per session — daily bars get one bar/day, effectively same
        const sessionOk = isDaily || !params.filterRTH || sessionEntries < 2;
        // VWAP: buy dips that are trading below fair value (order flow: price at discount)
        const vwapLongOk  = isNaN(prev.vwap) || prev.close < prev.vwap;
        const vwapShortOk = isNaN(prev.vwap) || prev.close > prev.vwap;
        // Volume confirmation: require elevated volume at the BB touch
        const volOk = isNaN(prev.volSma) || prev.volSma === 0
          || prev.volume > prev.volSma * params.volFilter;

        const rsiSellZone = 100 - params.rsiMid;
        longSignal  = windowOk && sessionOk && volOk && vwapLongOk
          && prev.emaF > prev.emaS && prev.close < prev.bbLower && prev.rsi < params.rsiMid;
        shortSignal = windowOk && sessionOk && volOk && vwapShortOk
          && params.allowShorts && prev.emaF < prev.emaS
          && prev.close > prev.bbUpper && prev.rsi > rsiSellZone;
      } else {
        // Mean rev: RTH gate skipped for daily bars (no intraday timestamps)
        const revRthOk = isDaily || rthOk;
        const rsiOverbought = 100 - params.rsiOversold;
        longSignal  = revRthOk && prev.close < prev.bbLower && prev.rsi < params.rsiOversold;
        shortSignal = revRthOk && params.allowShorts
          && prev.close > prev.bbUpper && prev.rsi > rsiOverbought;
      }

      if (longSignal || shortSignal) {
        if (params.strategy === "scalp") sessionEntries++;
        const dir = longSignal ? 1 : -1;
        position       = dir;
        entryPrice     = bar.open;
        entryAtr       = prev.atr;
        capitalAtEntry = capital;
        // Crypto: fraction of capital. Futures: full notional for display only.
        positionValue  = params.assetType === "futures"
          ? bar.open * params.contractMultiplier * params.numContracts
          : capital * params.positionSizePct;
        entryTime      = bar.ts;
        currentSL      = dir === 1
          ? entryPrice - params.slMult * entryAtr
          : entryPrice + params.slMult * entryAtr;
        // TP: scalp uses fast ATR-based target; mean rev waits for BB middle
        tpTarget = params.strategy === "scalp"
          ? (dir === 1
              ? entryPrice + params.atrTarget * entryAtr
              : entryPrice - params.atrTarget * entryAtr)
          : prev.bbMiddle;
        capital -= calcFee(params, positionValue);
      }

    } else if (position === 1) {
      // ── Long Exit ─────────────────────────────────────────────────────────
      let exitPrice: number | null = null;
      if (bar.low <= currentSL)      exitPrice = currentSL;
      else if (bar.high >= tpTarget) exitPrice = tpTarget;

      if (exitPrice !== null) {
        const pnl = calcPnl("long", entryPrice, exitPrice, params, positionValue);
        capital += pnl - calcFee(params, positionValue);
        trades.push({
          entryTime, exitTime: bar.ts, direction: "long",
          entryPrice, exitPrice,
          slPrice: currentSL, tpPrice: tpTarget,
          pnl, returnPct: ((exitPrice - entryPrice) / entryPrice) * 100,
          positionValue, capitalAtEntry,
        });
        position = 0;
      }

    } else if (position === -1) {
      // ── Short Exit ────────────────────────────────────────────────────────
      let exitPrice: number | null = null;
      if (bar.high >= currentSL)    exitPrice = currentSL;
      else if (bar.low <= tpTarget) exitPrice = tpTarget;

      if (exitPrice !== null) {
        const pnl = calcPnl("short", entryPrice, exitPrice, params, positionValue);
        capital += pnl - calcFee(params, positionValue);
        trades.push({
          entryTime, exitTime: bar.ts, direction: "short",
          entryPrice, exitPrice,
          slPrice: currentSL, tpPrice: tpTarget,
          pnl, returnPct: ((entryPrice - exitPrice) / entryPrice) * 100,
          positionValue, capitalAtEntry,
        });
        position = 0;
      }
    }

    // Mark-to-market equity
    const unrealized = position !== 0
      ? calcUnrealized(position, bar.close, entryPrice, params, positionValue)
      : 0;
    equityCurve.push({ ts: bar.ts, value: capital + unrealized });
  }

  return {
    equityCurve,
    trades,
    metrics: calcMetrics(equityCurve, trades, INITIAL_CAPITAL),
  };
}

function calcMetrics(
  equity: { ts: number; value: number }[],
  trades: Trade[],
  initial: number
): Metrics {
  const values = equity.map((e) => e.value);
  const finalCapital = values[values.length - 1];
  const totalReturn = ((finalCapital - initial) / initial) * 100;

  let peak = values[0];
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }

  const returns = values.slice(1).map((v, i) => (v - values[i]) / values[i]);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length
  );
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(8760) : 0;

  const wins   = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  return {
    totalReturn,
    maxDrawdown: maxDd * 100,
    sharpe,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    nTrades: trades.length,
    avgWin:  wins.length   ? wins.reduce((a, t)   => a + t.pnl, 0) / wins.length   : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0,
    avgDurationHrs: trades.length
      ? trades.reduce((a, t) => a + (t.exitTime - t.entryTime), 0) / trades.length / 3_600_000
      : 0,
    finalCapital,
  };
}

export interface MonthlyRow {
  year: number;
  month: number;
  returnPct: number;
}

export interface MonthlyCell {
  pct: number;  // percentage return for the month
  usd: number;  // absolute dollar PnL for the month
}

export function monthlyPnlTable(
  equity: { ts: number; value: number }[]
): Record<number, Record<number, MonthlyCell>> {
  const byMonth: Record<string, number[]> = {};
  for (const e of equity) {
    const d = new Date(e.ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(e.value);
  }

  const table: Record<number, Record<number, MonthlyCell>> = {};
  const keys = Object.keys(byMonth).sort();

  for (let i = 1; i < keys.length; i++) {
    const [yr, mo] = keys[i].split("-").map(Number);
    const prevLast = byMonth[keys[i - 1]].at(-1)!;
    const curLast  = byMonth[keys[i]].at(-1)!;
    const pct = ((curLast - prevLast) / prevLast) * 100;
    const usd = curLast - prevLast;
    if (!table[yr]) table[yr] = {};
    table[yr][mo] = { pct, usd };
  }

  return table;
}
