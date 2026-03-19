import { addIndicators, type Bar, type Params } from "./strategy";
import type { Candle } from "./data";

export interface Trade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  returnPct: number;
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

const INITIAL_CAPITAL = 10_000;

export function runBacktest(candles: Candle[], params: Params): BacktestResult {
  const bars = addIndicators(candles, params);

  let capital       = INITIAL_CAPITAL;
  let position: 0 | 1 | -1 = 0;
  let entryPrice    = 0;
  let entryAtr      = 0;
  let positionValue = 0;
  let entryTime     = 0;
  let partialTaken  = false;
  let currentSL     = 0;                    // tracks SL level (moves to BE after partial TP)
  let pendingReentry: 0 | 1 | -1 = 0;      // re-enter on next bar if cross still valid

  const equityCurve: { ts: number; value: number }[] = [
    { ts: bars[0].ts, value: capital },
  ];
  const trades: Trade[] = [];

  for (let i = 2; i < bars.length; i++) {
    const b2   = bars[i - 2];
    const prev = bars[i - 1];
    const bar  = bars[i];

    // ── Re-entry: enter at this bar's open if cross still valid ──────────
    if (pendingReentry !== 0 && position === 0) {
      const dir    = pendingReentry;
      const adxOk  = params.adxMin === 0    || bar.adx >= params.adxMin;
      const volOk  = params.volumeMult === 0 || bar.volume >= bar.volSMA * params.volumeMult;

      const stillLong  = dir === 1  &&
        bar.emaFast > bar.emaSlow &&
        bar.close > bar.emaTrend &&
        bar.rsi > params.rsiLow && bar.rsi < params.rsiHigh;
      const stillShort = dir === -1 &&
        bar.emaFast < bar.emaSlow &&
        bar.close < bar.emaTrend &&
        bar.rsi < (100 - params.rsiLow) && bar.rsi > (100 - params.rsiHigh);

      if ((stillLong || stillShort) && adxOk && volOk) {
        position      = dir;
        entryPrice    = bar.open;
        entryAtr      = bar.atr;
        positionValue = capital * params.positionSizePct;
        entryTime     = bar.ts;
        partialTaken  = false;
        currentSL     = dir === 1
          ? entryPrice - params.slMult * entryAtr
          : entryPrice + params.slMult * entryAtr;
        capital -= positionValue * params.feePct;
      }
      pendingReentry = 0;
    }

    if (position === 0) {
      // ── Entry signals ───────────────────────────────────────────────────
      const bullCross = b2.emaFast <= b2.emaSlow && prev.emaFast > prev.emaSlow;
      const bearCross = b2.emaFast >= b2.emaSlow && prev.emaFast < prev.emaSlow;
      const adxOk    = params.adxMin === 0    || prev.adx >= params.adxMin;
      const volOk    = params.volumeMult === 0 || prev.volume >= prev.volSMA * params.volumeMult;

      if (
        bullCross &&
        prev.close > prev.emaTrend &&
        prev.rsi > params.rsiLow && prev.rsi < params.rsiHigh &&
        adxOk && volOk
      ) {
        position      = 1;
        entryPrice    = bar.open;
        entryAtr      = prev.atr;
        positionValue = capital * params.positionSizePct;
        entryTime     = bar.ts;
        partialTaken  = false;
        currentSL     = entryPrice - params.slMult * entryAtr;
        capital -= positionValue * params.feePct;
      } else if (
        bearCross &&
        prev.close < prev.emaTrend &&
        prev.rsi < (100 - params.rsiLow) && prev.rsi > (100 - params.rsiHigh) &&
        adxOk && volOk
      ) {
        position      = -1;
        entryPrice    = bar.open;
        entryAtr      = prev.atr;
        positionValue = capital * params.positionSizePct;
        entryTime     = bar.ts;
        partialTaken  = false;
        currentSL     = entryPrice + params.slMult * entryAtr;
        capital -= positionValue * params.feePct;
      }

    } else if (position === 1) {
      const tp           = entryPrice + params.tpMult * entryAtr;
      const partialLevel = params.partialTpMult > 0
        ? entryPrice + params.partialTpMult * entryAtr
        : null;

      let exitPrice: number | null = null;

      if (bar.low <= currentSL) {
        // SL hit (original SL or breakeven after partial)
        exitPrice = currentSL;
      } else {
        // SL not hit — check partial TP first
        if (!partialTaken && partialLevel !== null && bar.high >= partialLevel) {
          const half = positionValue * 0.5;
          const pnl  = ((partialLevel - entryPrice) / entryPrice) * half;
          capital += pnl - half * params.feePct;
          trades.push({
            entryTime, exitTime: bar.ts, direction: "long",
            entryPrice, exitPrice: partialLevel, pnl,
            returnPct: ((partialLevel - entryPrice) / entryPrice) * 100,
          });
          positionValue = half;
          currentSL     = entryPrice; // move SL to breakeven
          partialTaken  = true;
        }
        // Full TP or trend reversal exit
        if (bar.high >= tp)              exitPrice = tp;
        else if (bar.emaFast < bar.emaSlow) exitPrice = bar.close;
      }

      if (exitPrice !== null) {
        const pnl = ((exitPrice - entryPrice) / entryPrice) * positionValue;
        capital += pnl - positionValue * params.feePct;
        trades.push({
          entryTime, exitTime: bar.ts, direction: "long",
          entryPrice, exitPrice, pnl,
          returnPct: ((exitPrice - entryPrice) / entryPrice) * 100,
        });
        if (bar.emaFast > bar.emaSlow) pendingReentry = 1;
        position = 0;
      }

    } else if (position === -1) {
      const tp           = entryPrice - params.tpMult * entryAtr;
      const partialLevel = params.partialTpMult > 0
        ? entryPrice - params.partialTpMult * entryAtr
        : null;

      let exitPrice: number | null = null;

      if (bar.high >= currentSL) {
        // SL hit
        exitPrice = currentSL;
      } else {
        // SL not hit — check partial TP first
        if (!partialTaken && partialLevel !== null && bar.low <= partialLevel) {
          const half = positionValue * 0.5;
          const pnl  = ((entryPrice - partialLevel) / entryPrice) * half;
          capital += pnl - half * params.feePct;
          trades.push({
            entryTime, exitTime: bar.ts, direction: "short",
            entryPrice, exitPrice: partialLevel, pnl,
            returnPct: ((entryPrice - partialLevel) / entryPrice) * 100,
          });
          positionValue = half;
          currentSL     = entryPrice; // move SL to breakeven
          partialTaken  = true;
        }
        // Full TP or trend reversal exit
        if (bar.low <= tp)               exitPrice = tp;
        else if (bar.emaFast > bar.emaSlow) exitPrice = bar.close;
      }

      if (exitPrice !== null) {
        const pnl = ((entryPrice - exitPrice) / entryPrice) * positionValue;
        capital += pnl - positionValue * params.feePct;
        trades.push({
          entryTime, exitTime: bar.ts, direction: "short",
          entryPrice, exitPrice, pnl,
          returnPct: ((entryPrice - exitPrice) / entryPrice) * 100,
        });
        if (bar.emaFast < bar.emaSlow) pendingReentry = -1;
        position = 0;
      }
    }

    // Mark-to-market equity (recomputed after all position changes this bar)
    let unrealized = 0;
    if (position === 1) {
      unrealized = ((bar.close - entryPrice) / entryPrice) * positionValue;
    } else if (position === -1) {
      unrealized = ((entryPrice - bar.close) / entryPrice) * positionValue;
    }
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

export function monthlyPnlTable(
  equity: { ts: number; value: number }[]
): Record<number, Record<number, number>> {
  const byMonth: Record<string, number[]> = {};
  for (const e of equity) {
    const d = new Date(e.ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(e.value);
  }

  const table: Record<number, Record<number, number>> = {};
  const keys = Object.keys(byMonth).sort();

  for (let i = 1; i < keys.length; i++) {
    const [yr, mo] = keys[i].split("-").map(Number);
    const prevLast = byMonth[keys[i - 1]].at(-1)!;
    const curLast  = byMonth[keys[i]].at(-1)!;
    const ret = ((curLast - prevLast) / prevLast) * 100;
    if (!table[yr]) table[yr] = {};
    table[yr][mo] = ret;
  }

  return table;
}
