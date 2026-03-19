import { sql, initSchema } from "./db";
import { fetchOHLCV } from "./data";
import { addIndicators, type Params } from "./strategy";

const PAPER_POSITION_USD = 1_000;

export async function runCycle(symbol: string, params: Params): Promise<string> {
  await initSchema();
  // Need enough bars for warmup (trendEma + buffer)
  const lookbackDays = Math.max(7, Math.ceil(params.trendEma / 24) + 3);
  const candles = await fetchOHLCV(symbol, "1h", lookbackDays);
  const bars = addIndicators(candles, params);
  if (bars.length < 3) return "Not enough data.";

  const b2   = bars[bars.length - 3]; // two bars ago
  const prev = bars[bars.length - 2]; // previous bar (signal bar)
  const last = bars[bars.length - 1]; // latest closed bar
  const now  = new Date().toISOString();

  // Check existing position
  const { rows } = await sql`
    SELECT * FROM paper_positions WHERE symbol = ${symbol}
  `;
  const pos = rows[0];

  if (!pos) {
    const bullCross = b2.emaFast <= b2.emaSlow && prev.emaFast > prev.emaSlow;
    const bearCross = b2.emaFast >= b2.emaSlow && prev.emaFast < prev.emaSlow;

    if (
      bullCross &&
      prev.close > prev.emaTrend &&
      prev.rsi > params.rsiLow &&
      prev.rsi < params.rsiHigh
    ) {
      await sql`
        INSERT INTO paper_positions (symbol, direction, entry_price, entry_ts, entry_atr)
        VALUES (${symbol}, 'LONG', ${last.open}, ${now}, ${prev.atr})
        ON CONFLICT (symbol) DO UPDATE
          SET direction=EXCLUDED.direction, entry_price=EXCLUDED.entry_price,
              entry_ts=EXCLUDED.entry_ts, entry_atr=EXCLUDED.entry_atr
      `;
      return `Entered LONG @ ${last.open.toFixed(2)} (EMA cross + trend + RSI ${prev.rsi.toFixed(0)})`;
    }

    if (
      bearCross &&
      prev.close < prev.emaTrend &&
      prev.rsi < (100 - params.rsiLow) &&
      prev.rsi > (100 - params.rsiHigh)
    ) {
      await sql`
        INSERT INTO paper_positions (symbol, direction, entry_price, entry_ts, entry_atr)
        VALUES (${symbol}, 'SHORT', ${last.open}, ${now}, ${prev.atr})
        ON CONFLICT (symbol) DO UPDATE
          SET direction=EXCLUDED.direction, entry_price=EXCLUDED.entry_price,
              entry_ts=EXCLUDED.entry_ts, entry_atr=EXCLUDED.entry_atr
      `;
      return `Entered SHORT @ ${last.open.toFixed(2)} (EMA cross + trend + RSI ${prev.rsi.toFixed(0)})`;
    }

    return "No signal — flat.";
  }

  const { direction, entry_price: ep, entry_atr: ea } = pos;
  const sl = direction === "LONG" ? ep - params.slMult * ea : ep + params.slMult * ea;
  const tp = direction === "LONG" ? ep + params.tpMult * ea : ep - params.tpMult * ea;

  let exitPrice: number | null = null;

  if (direction === "LONG") {
    if (last.low <= sl)  exitPrice = sl;
    else if (last.high >= tp) exitPrice = tp;
    else if (last.emaFast < last.emaSlow) exitPrice = last.close; // trend reversal
  } else {
    if (last.high >= sl) exitPrice = sl;
    else if (last.low <= tp) exitPrice = tp;
    else if (last.emaFast > last.emaSlow) exitPrice = last.close; // trend reversal
  }

  if (exitPrice === null)
    return `Holding ${direction} @ ${ep.toFixed(2)} | SL ${sl.toFixed(2)} | TP ${tp.toFixed(2)}`;

  const pnl =
    direction === "LONG"
      ? ((exitPrice - ep) / ep) * PAPER_POSITION_USD
      : ((ep - exitPrice) / ep) * PAPER_POSITION_USD;

  await sql`
    INSERT INTO paper_trades (ts, symbol, direction, entry_price, exit_price, pnl, status)
    VALUES (${now}, ${symbol}, ${direction}, ${ep}, ${exitPrice}, ${pnl}, 'CLOSED')
  `;
  await sql`DELETE FROM paper_positions WHERE symbol = ${symbol}`;

  return `Closed ${direction} @ ${exitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)}`;
}

export async function getTrades(symbol?: string) {
  await initSchema();
  if (symbol) {
    const { rows } = await sql`
      SELECT * FROM paper_trades WHERE symbol = ${symbol} ORDER BY ts DESC
    `;
    return rows;
  }
  const { rows } = await sql`SELECT * FROM paper_trades ORDER BY ts DESC`;
  return rows;
}

export async function getPosition(symbol: string) {
  await initSchema();
  const { rows } = await sql`
    SELECT * FROM paper_positions WHERE symbol = ${symbol}
  `;
  return rows[0] ?? null;
}
