import { sql, initSchema } from "./db";
import { fetchOHLCV } from "./data";
import { addIndicators, type Params } from "./strategy";

const PAPER_POSITION_USD = 1_000;

export async function runCycle(symbol: string, params: Params): Promise<string> {
  await initSchema();
  const candles = await fetchOHLCV(symbol, "1h", 7); // last 7 days is plenty
  const bars = addIndicators(candles, params);
  if (bars.length < 2) return "Not enough data.";

  const prev = bars[bars.length - 2];
  const last = bars[bars.length - 1];
  const now = new Date().toISOString();

  // Check existing position
  const { rows } = await sql`
    SELECT * FROM paper_positions WHERE symbol = ${symbol}
  `;
  const pos = rows[0];

  if (!pos) {
    if (prev.close < prev.bbLower && prev.rsi < params.rsiOversold) {
      await sql`
        INSERT INTO paper_positions (symbol, direction, entry_price, entry_ts, entry_atr)
        VALUES (${symbol}, 'LONG', ${last.open}, ${now}, ${prev.atr})
        ON CONFLICT (symbol) DO UPDATE
          SET direction=EXCLUDED.direction, entry_price=EXCLUDED.entry_price,
              entry_ts=EXCLUDED.entry_ts, entry_atr=EXCLUDED.entry_atr
      `;
      return `Entered LONG @ ${last.open.toFixed(2)}`;
    }
    if (prev.close > prev.bbUpper && prev.rsi > params.rsiOverbought) {
      await sql`
        INSERT INTO paper_positions (symbol, direction, entry_price, entry_ts, entry_atr)
        VALUES (${symbol}, 'SHORT', ${last.open}, ${now}, ${prev.atr})
        ON CONFLICT (symbol) DO UPDATE
          SET direction=EXCLUDED.direction, entry_price=EXCLUDED.entry_price,
              entry_ts=EXCLUDED.entry_ts, entry_atr=EXCLUDED.entry_atr
      `;
      return `Entered SHORT @ ${last.open.toFixed(2)}`;
    }
    return "No signal — flat.";
  }

  const { direction, entry_price: ep, entry_atr: ea } = pos;
  const sl = direction === "LONG" ? ep - params.slMult * ea : ep + params.slMult * ea;
  const tp = direction === "LONG" ? ep + params.tpMult * ea : ep - params.tpMult * ea;

  let exitPrice: number | null = null;
  if (direction === "LONG") {
    if (last.low <= sl) exitPrice = sl;
    else if (last.high >= tp) exitPrice = tp;
    else if (last.close > last.bbMiddle && last.rsi > params.rsiExitLong) exitPrice = last.close;
  } else {
    if (last.high >= sl) exitPrice = sl;
    else if (last.low <= tp) exitPrice = tp;
    else if (last.close < last.bbMiddle && last.rsi < params.rsiExitShort) exitPrice = last.close;
  }

  if (exitPrice === null) return `Holding ${direction} @ ${ep.toFixed(2)}.`;

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
