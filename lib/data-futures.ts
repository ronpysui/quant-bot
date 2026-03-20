/**
 * Yahoo Finance OHLCV fetcher for CME futures (MNQ=F, NQ=F, ES=F …)
 *
 * Yahoo Finance caps 60m (1H) intraday history at ~730 days for futures.
 * When days > 730, we automatically fall back to 1D bars, which Yahoo
 * Finance provides freely for 10+ years. Daily bars are cached under
 * timeframe = '1d' in the shared ohlcv table.
 *
 * Backtester auto-detects the bar spacing and adjusts signal logic accordingly.
 */
import YahooFinance from "yahoo-finance2";
import { createPool } from "@vercel/postgres";
import { sql, initSchema } from "./db";
import type { Candle } from "./data";

const yahooFinance = new YahooFinance();

/** Hard cap Yahoo Finance places on 60m intraday futures data */
export const FUTURES_1H_MAX_DAYS = 730;

/** Maximum daily-bar history we request (MNQ launched May 2019, ~5yr ago) */
const FUTURES_1D_MAX_DAYS = 1825; // 5 years

// ── Shared helpers ────────────────────────────────────────────────────────────

async function upsertCandles(
  symbol: string,
  timeframe: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quotes: any[]
): Promise<void> {
  if (quotes.length === 0) return;
  const pool = createPool();
  try {
    await pool.query(
      `INSERT INTO ohlcv (symbol, timeframe, ts, open, high, low, close, volume)
       SELECT $1, $2,
              unnest($3::timestamptz[]),
              unnest($4::float8[]),
              unnest($5::float8[]),
              unnest($6::float8[]),
              unnest($7::float8[]),
              unnest($8::float8[])
       ON CONFLICT (symbol, timeframe, ts) DO NOTHING`,
      [
        symbol, timeframe,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quotes.map((q: any) => new Date(q.date).toISOString()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quotes.map((q: any) => q.open),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quotes.map((q: any) => q.high),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quotes.map((q: any) => q.low),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quotes.map((q: any) => q.close),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quotes.map((q: any) => q.volume ?? 0),
      ]
    );
  } finally {
    await pool.end();
  }
}

async function queryCachedCandles(
  symbol: string,
  timeframe: string,
  sinceMs: number
): Promise<Candle[]> {
  const since = new Date(sinceMs).toISOString();
  const { rows } = await sql`
    SELECT ts, open, high, low, close, volume FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
      AND ts >= ${since}
    ORDER BY ts ASC
  `;
  return rows.map((r) => ({
    ts:     new Date(r.ts).getTime(),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume),
  }));
}

// ── 1H path (≤ 730 days) ─────────────────────────────────────────────────────

async function fetchAndCache1H(symbol: string, days: number): Promise<void> {
  const end   = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await yahooFinance.chart(symbol, {
    period1: start, period2: end,
    interval: "60m", // Yahoo uses '60m' not '1h' for intraday
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quotes = ((result.quotes ?? []) as any[]).filter(
    (q) => q.open != null && q.high != null && q.low != null && q.close != null
  );
  await upsertCandles(symbol, "1h", quotes);
}

async function fetchFutures1H(symbol: string, days: number): Promise<Candle[]> {
  const sinceMs = Date.now() - days * 86_400_000;

  const { rows } = await sql`
    SELECT COUNT(*) AS cnt, MIN(ts) AS min_ts
    FROM ohlcv WHERE symbol = ${symbol} AND timeframe = '1h'
  `;
  const cached = Number(rows[0].cnt);
  const minTs  = rows[0].min_ts ? new Date(rows[0].min_ts).getTime() : null;
  const coverageOk = minTs !== null && minTs <= sinceMs + days * 86_400_000 * 0.1;

  if (cached >= 100 && coverageOk) {
    await fetchAndCache1H(symbol, 4).catch(() => {});
  } else {
    await fetchAndCache1H(symbol, days);
  }
  return queryCachedCandles(symbol, "1h", sinceMs);
}

// ── 1D path (> 730 days) ─────────────────────────────────────────────────────

async function fetchAndCache1D(symbol: string, days: number): Promise<void> {
  const end   = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await yahooFinance.chart(symbol, {
    period1: start, period2: end,
    interval: "1d",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quotes = ((result.quotes ?? []) as any[]).filter(
    (q) => q.open != null && q.high != null && q.low != null && q.close != null
  );
  await upsertCandles(symbol, "1d", quotes);
}

async function fetchFutures1D(symbol: string, days: number): Promise<Candle[]> {
  const cappedDays = Math.min(days, FUTURES_1D_MAX_DAYS);
  const sinceMs    = Date.now() - cappedDays * 86_400_000;

  const { rows } = await sql`
    SELECT COUNT(*) AS cnt, MIN(ts) AS min_ts
    FROM ohlcv WHERE symbol = ${symbol} AND timeframe = '1d'
  `;
  const cached = Number(rows[0].cnt);
  const minTs  = rows[0].min_ts ? new Date(rows[0].min_ts).getTime() : null;
  const coverageOk = minTs !== null && minTs <= sinceMs + cappedDays * 86_400_000 * 0.1;

  if (cached >= 50 && coverageOk) {
    await fetchAndCache1D(symbol, 7).catch(() => {});
  } else {
    await fetchAndCache1D(symbol, cappedDays);
  }
  return queryCachedCandles(symbol, "1d", sinceMs);
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Fetch OHLCV for a CME futures symbol.
 * - days ≤ 730 → 1H bars (Yahoo Finance intraday cap)
 * - days > 730 → 1D bars (Yahoo Finance daily; years of free history)
 *
 * The returned `Candle[]` looks identical in both cases — the backtester
 * detects the timeframe from bar spacing (≥ 20 h gap = daily bars).
 */
export async function fetchFuturesOHLCV(
  symbol: string,
  days: number
): Promise<Candle[]> {
  await initSchema();
  if (days <= FUTURES_1H_MAX_DAYS) {
    return fetchFutures1H(symbol, days);
  }
  return fetchFutures1D(symbol, days);
}
