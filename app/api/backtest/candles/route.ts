import { NextRequest, NextResponse } from "next/server";
import { sql, initSchema } from "@/lib/db";

/**
 * GET /api/backtest/candles?symbol=SOL/USDT:USDT&from=<ms>&to=<ms>
 * Returns cached 1H OHLCV rows for a given time window — used by the
 * trade detail mini chart in the backtest trade log.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? "BTC/USDT:USDT";
  const from   = Number(searchParams.get("from") ?? 0);
  const to     = Number(searchParams.get("to")   ?? Date.now());

  await initSchema();

  const fromIso = new Date(from).toISOString();
  const toIso   = new Date(to).toISOString();

  const { rows } = await sql`
    SELECT ts, open, high, low, close
    FROM ohlcv
    WHERE symbol    = ${symbol}
      AND timeframe = '1h'
      AND ts >= ${fromIso}
      AND ts <= ${toIso}
    ORDER BY ts ASC
  `;

  return NextResponse.json({
    candles: rows.map((r) => ({
      ts:    new Date(r.ts).getTime(),
      open:  r.open,
      high:  r.high,
      low:   r.low,
      close: r.close,
    })),
  });
}
