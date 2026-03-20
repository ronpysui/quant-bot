import { RSI, BollingerBands } from "technicalindicators";
import type { Candle } from "./data";

export interface Params {
  // ── Strategy selector ──────────────────────────────────────────────────────
  strategy: "meanrev" | "scalp";
  // "meanrev" = classic BB + RSI mean reversion (exit at BB middle)
  // "scalp"   = EMA trend + VWAP + volume confirmation; 9:30–11:00 window; max 2/session
  bbPeriod: number;        // Bollinger Band window
  bbStdDev: number;        // BB standard deviation multiplier
  rsiPeriod: number;       // RSI period
  rsiOversold: number;     // Mean rev: enter long when RSI < this
  slMult: number;          // Stop loss × ATR
  positionSizePct: number; // Fraction of capital risked per trade — crypto only
  feePct: number;          // Fee as fraction of notional — crypto only
  initialCapital: number;  // Starting account balance in USD
  allowShorts: boolean;    // Also enter short on upper BB
  // ── EMA Scalp fields ───────────────────────────────────────────────────────
  emaFast: number;    // Fast EMA period (e.g. 9)  — trend direction
  emaSlow: number;    // Slow EMA period (e.g. 21) — trend filter
  rsiMid: number;     // Scalp: enter long when RSI < rsiMid (pullback, not extreme)
  atrTarget: number;  // Scalp TP = entry ± atrTarget × ATR
  volFilter: number;  // Volume confirmation: volume must exceed volFilter × 20-bar vol SMA (1.0 = off)
  // ── Futures fields ────────────────────────────────────────────────────────
  assetType: "crypto" | "futures";
  contractMultiplier: number; // $ per point: 2 for MNQ, 20 for NQ
  numContracts: number;       // integer number of contracts (≥ 1)
  feeDollar: number;          // flat fee per contract per side ($)
  filterRTH: boolean;         // only generate signals during RTH (9:30–4:15 ET)
}

export const DEFAULT_PARAMS: Params = {
  strategy: "meanrev",
  bbPeriod: 14,
  bbStdDev: 2.0,
  rsiPeriod: 14,
  rsiOversold: 30,
  slMult: 1.5,
  positionSizePct: 0.01,  // 1% of capital per trade (crypto)
  feePct: 0.0002,         // BloFin maker fee — 0.02% per side (crypto)
  initialCapital: 1000,   // $1,000 starting balance
  allowShorts: false,     // long-only by default
  emaFast: 9,
  emaSlow: 21,
  rsiMid: 50,
  atrTarget: 1.0,
  volFilter: 1.0,   // 1.0 = off (no volume requirement)
  assetType: "crypto",
  contractMultiplier: 2,  // MNQ default (unused for crypto)
  numContracts: 1,
  feeDollar: 1.50,        // ~$1.50/contract/side: exchange + NFA + brokerage
  filterRTH: false,
};

// Sensible defaults when switching to MNQ futures — uses scalp by default
export const MNQ_DEFAULT_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  strategy: "scalp",      // scalp is well-suited for intraday futures sessions
  assetType: "futures",
  contractMultiplier: 2,  // MNQ: $2/point
  numContracts: 1,
  feeDollar: 1.50,
  initialCapital: 5000,   // ~2× CME overnight margin (~$2,200) — recommended minimum
  filterRTH: true,        // only trade regular trading hours
  allowShorts: false,
};

export interface Bar extends Candle {
  rsi: number;
  atr: number;
  bbUpper: number;
  bbMiddle: number;  // BB middle = SMA = reversion target
  bbLower: number;
  emaF: number;      // fast EMA (trend direction)
  emaS: number;      // slow EMA (trend filter)
  vwap: number;      // intraday VWAP — resets each calendar day (order flow fair value)
  volSma: number;    // 20-period volume SMA — baseline for volume spike detection
}

function calcEMA(closes: number[], period: number): number[] {
  const k   = 2 / (period + 1);
  const ema: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return ema;
  // Seed with SMA of the first `period` bars
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ── Intraday VWAP — resets at midnight UTC each day ──────────────────────────
// Typical price = (H + L + C) / 3; cumulate per calendar day.
// Midnight UTC ≈ 7 PM ET (EST) which is safely outside any RTH session.
function calcVWAP(candles: Candle[]): number[] {
  const vwap: number[] = new Array(candles.length).fill(NaN);
  let cumTPV = 0, cumVol = 0, lastDate = "";
  for (let i = 0; i < candles.length; i++) {
    const dateStr = new Date(candles[i].ts).toISOString().slice(0, 10);
    if (dateStr !== lastDate) { cumTPV = 0; cumVol = 0; lastDate = dateStr; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume;
    cumVol += candles[i].volume;
    vwap[i] = cumVol > 0 ? cumTPV / cumVol : candles[i].close;
  }
  return vwap;
}

// ── 20-period rolling volume SMA (O(n) sliding window) ───────────────────────
function calcVolSma(candles: Candle[], period = 20): number[] {
  const volSma: number[] = new Array(candles.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].volume;
    if (i >= period) sum -= candles[i - period].volume;
    if (i >= period - 1) volSma[i] = sum / period;
  }
  return volSma;
}

function calcATR(candles: Candle[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const c = candles[i];
    tr.push(
      Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
    );
  }
  const atr: number[] = new Array(candles.length).fill(NaN);
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  atr[period] = sum / period;
  for (let i = period + 1; i < tr.length + 1; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i - 1]) / period;
  }
  return atr;
}

export function addIndicators(candles: Candle[], p: Params): Bar[] {
  const closes = candles.map((c) => c.close);

  // RSI: output[k] corresponds to candle at k + p.rsiPeriod
  const rsiArr = RSI.calculate({ period: p.rsiPeriod, values: closes });

  // BollingerBands: output[k] corresponds to candle at k + (p.bbPeriod - 1)
  const bbArr = BollingerBands.calculate({
    period: p.bbPeriod,
    stdDev: p.bbStdDev,
    values: closes,
  });

  const atrValues  = calcATR(candles);
  const emaFastArr = calcEMA(closes, p.emaFast);
  const emaSlowArr = calcEMA(closes, p.emaSlow);
  const vwapArr    = calcVWAP(candles);
  const volSmaArr  = calcVolSma(candles);

  // Start after the longest warmup (emaSlow - 1 seeds first valid EMA at index emaSlow-1)
  const offset = Math.max(p.rsiPeriod, p.bbPeriod - 1, 14, p.emaSlow - 1);

  const bars: Bar[] = [];

  for (let i = offset; i < candles.length; i++) {
    const rsi  = rsiArr[i - p.rsiPeriod];
    const bb   = bbArr[i - (p.bbPeriod - 1)];
    const atr  = atrValues[i];
    const emaF = emaFastArr[i];
    const emaS = emaSlowArr[i];

    if (rsi === undefined || bb === undefined || isNaN(atr) || isNaN(emaF) || isNaN(emaS)) continue;

    bars.push({
      ...candles[i],
      rsi, atr,
      bbUpper:  bb.upper,
      bbMiddle: bb.middle,
      bbLower:  bb.lower,
      emaF, emaS,
      vwap:   vwapArr[i],
      volSma: volSmaArr[i],
    });
  }

  return bars;
}
