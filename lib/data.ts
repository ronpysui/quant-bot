import ccxt from "ccxt";
import { sql, initSchema } from "./db";
import { createPool } from "@vercel/postgres";

export interface Candle {
  ts: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Kraken: deep historical data (365d+), confirmed accessible from Vercel US
const historyExchange = new ccxt.kraken({ enableRateLimit: true });
// BloFin: accurate recent price for paper trading (last ~4 days available)
const liveExchange = new ccxt.blofin({ enableRateLimit: true });

/** Map USDT perpetual symbol → Kraken USD symbol for historical data. */
function toKrakenSymbol(symbol: string): string {
  return symbol.replace(/\/USDT(?::USDT)?$/, "/USD");
}

/**
 * Batch-insert candles using PostgreSQL unnest — single SQL round-trip
 * regardless of array size. Vastly faster than per-row inserts.
 */
async function batchUpsert(candles: Candle[], symbol: string, timeframe: string) {
  if (!candles.length) return;
  const pool = createPool();
  try {
    const timestamps = candles.map((c) => new Date(c.ts).toISOString());
    const opens   = candles.map((c) => c.open);
    const highs   = candles.map((c) => c.high);
    const lows    = candles.map((c) => c.low);
    const closes  = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

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
      [symbol, timeframe, timestamps, opens, highs, lows, closes, volumes]
    );
  } finally {
    await pool.end();
  }
}

/**
 * Fetch OHLCV candles.
 * - Serves from Postgres if cache is adequate for the requested window.
 * - If cache is stale/insufficient: deletes it and reseeds from Kraken + BloFin.
 */
export async function fetchOHLCV(
  symbol: string,
  timeframe = "1h",
  days = 365
): Promise<Candle[]> {
  await initSchema();

  const minRequired = Math.max(500, days * 20); // ~20 usable candles/day

  const { rows } = await sql`
    SELECT COUNT(*) AS cnt,
           MIN(ts)  AS min_ts,
           MAX(ts)  AS max_ts
    FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `;
  const cached  = Number(rows[0].cnt);
  const minTs   = rows[0].min_ts ? new Date(rows[0].min_ts).getTime() : null;
  const windowMs = days * 86_400_000;
  const coverageOk = minTs !== null && (Date.now() - minTs) >= windowMs * 0.8;

  if (cached >= minRequired && coverageOk) {
    // Cache is adequate — serve directly
    const since = new Date(Date.now() - windowMs).toISOString();
    const { rows: candles } = await sql`
      SELECT ts, open, high, low, close, volume FROM ohlcv
      WHERE symbol = ${symbol} AND timeframe = ${timeframe}
        AND ts >= ${since}
      ORDER BY ts ASC
    `;
    return candles.map((r) => ({
      ts: new Date(r.ts).getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  // Cache is stale or insufficient — wipe it and reseed
  if (cached > 0) {
    await sql`DELETE FROM ohlcv WHERE symbol = ${symbol} AND timeframe = ${timeframe}`;
  }

  return await seedHistory(symbol, timeframe, days);
}

/**
 * Seed full history from Kraken (up to `days` back), then top-up the most
 * recent candles from BloFin for accurate live pricing.
 * Uses batch unnest inserts — completes in one or two Vercel function calls.
 */
export async function seedHistory(
  symbol: string,
  timeframe: string,
  days: number
): Promise<Candle[]> {
  const krakenSymbol = toKrakenSymbol(symbol);
  const sinceMs = Date.now() - days * 86_400_000;
  const tfMs = historyExchange.parseTimeframe(timeframe) * 1000;
  const all: Candle[] = [];

  // ── Fetch historical data from Kraken ────────────────────────────────────
  let since = sinceMs;
  while (true) {
    const batch = await historyExchange.fetchOHLCV(krakenSymbol, timeframe, since, 720);
    if (!batch.length) break;
    all.push(
      ...batch.map(([ts, open, high, low, close, volume]) => ({
        ts:     ts     as number,
        open:   open   as number,
        high:   high   as number,
        low:    low    as number,
        close:  close  as number,
        volume: volume as number,
      }))
    );
    const lastTs = batch[batch.length - 1][0] as number;
    if (lastTs >= Date.now() - tfMs * 2) break;
    since = lastTs + 1;
  }

  // ── Top-up with BloFin recent candles (live-accurate pricing) ────────────
  try {
    const recent = await liveExchange.fetchOHLCV(symbol, timeframe, undefined, 200);
    const recentStart = all.length ? all[all.length - 1].ts : sinceMs;
    const fresh = recent
      .filter(([ts]) => (ts as number) > recentStart)
      .map(([ts, open, high, low, close, volume]) => ({
        ts:     ts     as number,
        open:   open   as number,
        high:   high   as number,
        low:    low    as number,
        close:  close  as number,
        volume: volume as number,
      }));
    all.push(...fresh);
  } catch {
    // BloFin unavailable — Kraken data is sufficient
  }

  // ── Batch-upsert all fetched candles (single SQL round-trip) ─────────────
  await batchUpsert(all, symbol, timeframe);

  // Return the full window from DB
  const since2 = new Date(Date.now() - days * 86_400_000).toISOString();
  const { rows: candles } = await sql`
    SELECT ts, open, high, low, close, volume FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
      AND ts >= ${since2}
    ORDER BY ts ASC
  `;
  return candles.map((r) => ({
    ts: new Date(r.ts).getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

/** Keep cache fresh — called by daily cron. */
export async function refreshCache(symbol: string, timeframe = "1h") {
  let candles: Candle[] = [];
  try {
    const batch = await liveExchange.fetchOHLCV(symbol, timeframe, undefined, 100);
    candles = batch.map(([ts, open, high, low, close, volume]) => ({
      ts: ts as number, open: open as number, high: high as number,
      low: low as number, close: close as number, volume: volume as number,
    }));
  } catch {
    const krakenSymbol = toKrakenSymbol(symbol);
    const since = Date.now() - 200 * historyExchange.parseTimeframe(timeframe) * 1000;
    const batch = await historyExchange.fetchOHLCV(krakenSymbol, timeframe, since, 200);
    candles = batch.map(([ts, open, high, low, close, volume]) => ({
      ts: ts as number, open: open as number, high: high as number,
      low: low as number, close: close as number, volume: volume as number,
    }));
  }
  await batchUpsert(candles, symbol, timeframe);
}
