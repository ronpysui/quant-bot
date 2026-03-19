import { BollingerBands, RSI } from "technicalindicators";
import type { Candle } from "./data";

export interface Params {
  bbPeriod: number;
  bbStd: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  rsiExitLong: number;
  rsiExitShort: number;
  slMult: number;
  tpMult: number;
  positionSizePct: number;
  feePct: number;
}

export const DEFAULT_PARAMS: Params = {
  bbPeriod: 20,
  bbStd: 2.0,
  rsiPeriod: 14,
  rsiOversold: 35,
  rsiOverbought: 65,
  rsiExitLong: 55,
  rsiExitShort: 45,
  slMult: 1.5,
  tpMult: 2.0,
  positionSizePct: 0.1,
  feePct: 0.001,
};

export interface Bar extends Candle {
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  rsi: number;
  atr: number;
}

function calcATR(candles: Candle[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low, close: prevClose } = candles[i - 1];
    const c = candles[i];
    tr.push(
      Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
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

  const bbResults = BollingerBands.calculate({
    period: p.bbPeriod,
    stdDev: p.bbStd,
    values: closes,
  });

  const rsiResults = RSI.calculate({
    period: p.rsiPeriod,
    values: closes,
  });

  const atrValues = calcATR(candles);

  // Align to the same length — all indicators have leading NaN due to warmup
  const offset = Math.max(p.bbPeriod, p.rsiPeriod, 14);
  const bars: Bar[] = [];

  for (let i = offset; i < candles.length; i++) {
    const bbIdx = i - p.bbPeriod;
    const rsiIdx = i - p.rsiPeriod;
    const bb = bbResults[bbIdx];
    const rsi = rsiResults[rsiIdx];
    const atr = atrValues[i];

    if (!bb || rsi === undefined || isNaN(atr)) continue;

    bars.push({
      ...candles[i],
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      rsi,
      atr,
    });
  }

  return bars;
}
