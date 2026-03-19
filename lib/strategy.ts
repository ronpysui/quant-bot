import { EMA, RSI } from "technicalindicators";
import type { Candle } from "./data";

export interface Params {
  fastEma: number;        // Fast EMA period
  slowEma: number;        // Slow EMA period
  trendEma: number;       // Trend-filter EMA period
  rsiPeriod: number;      // RSI period
  rsiLow: number;         // RSI must be ABOVE this to enter long (momentum floor)
  rsiHigh: number;        // RSI must be BELOW this to enter long (not overbought)
  slMult: number;         // Stop loss × ATR
  tpMult: number;         // Take profit × ATR
  positionSizePct: number;
  feePct: number;
}

export const DEFAULT_PARAMS: Params = {
  fastEma: 8,
  slowEma: 21,
  trendEma: 50,
  rsiPeriod: 14,
  rsiLow: 45,
  rsiHigh: 70,
  slMult: 1.0,
  tpMult: 2.5,
  positionSizePct: 0.1,
  feePct: 0.001,
};

export interface Bar extends Candle {
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  rsi: number;
  atr: number;
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

  const fastEmaArr  = EMA.calculate({ period: p.fastEma,  values: closes });
  const slowEmaArr  = EMA.calculate({ period: p.slowEma,  values: closes });
  const trendEmaArr = EMA.calculate({ period: p.trendEma, values: closes });
  const rsiArr      = RSI.calculate({ period: p.rsiPeriod, values: closes });
  const atrValues   = calcATR(candles);

  // All indicators have warmup offsets — align to the longest
  const offset = Math.max(p.fastEma, p.slowEma, p.trendEma, p.rsiPeriod, 14);
  const bars: Bar[] = [];

  for (let i = offset; i < candles.length; i++) {
    const emaFast  = fastEmaArr[i - p.fastEma];
    const emaSlow  = slowEmaArr[i - p.slowEma];
    const emaTrend = trendEmaArr[i - p.trendEma];
    const rsi      = rsiArr[i - p.rsiPeriod];
    const atr      = atrValues[i];

    if (
      emaFast === undefined || emaSlow === undefined ||
      emaTrend === undefined || rsi === undefined || isNaN(atr)
    ) continue;

    bars.push({ ...candles[i], emaFast, emaSlow, emaTrend, rsi, atr });
  }

  return bars;
}
