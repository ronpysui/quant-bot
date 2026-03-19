import ccxt from "ccxt";
import { sql, initSchema } from "./db";

export interface Candle {
  ts: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const exchange = new ccxt.blofin({ enableRateLimit: true });

/**
 * Fetch OHLCV candles.
 * Strategy: read from Postgres cache first; if cache has enough rows for the
 * requested period, serve from DB instantly (avoids Vercel 10s timeout).
 * Otherwise seed from BloFin and persist.
 */
export async function fetchOHLCV(
  symbol: string,
  timeframe = "1h",
  days = 365
): Promise<Candle[]> {
  await initSchema();

  // Need ~20 candles/day minimum to consider the cache adequate for the period
  const minRequired = Math.max(500, days * 20);

  const { rows } = await sql`
    SELECT COUNT(*) AS cnt FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `;
  const cached = Number(rows[0].cnt);

  if (cached >= minRequired) {
    // Serve from Postgres
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
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

  // Seed from BloFin (first run or cache too small for requested period)
  return await seedFromBlofin(symbol, timeframe, days);
}

export async function seedFromBlofin(
  symbol: string,
  timeframe: string,
  days: number
): Promise<Candle[]> {
  const sinceMs = Date.now() - days * 86_400_000;

  // Start from where the cache ends (if partial), to avoid re-fetching
  const { rows: bounds } = await sql`
    SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `;
  const cachedMin = bounds[0].min_ts ? new Date(bounds[0].min_ts).getTime() : null;
  const cachedMax = bounds[0].max_ts ? new Date(bounds[0].max_ts).getTime() : null;

  const tfMs = exchange.parseTimeframe(timeframe) * 1000;
  const all: Candle[] = [];

  // 1. Fill historical gap (sinceMs → cachedMin)
  if (!cachedMin || cachedMin > sinceMs + tfMs) {
    let since = sinceMs;
    const fetchUntil = cachedMin ? cachedMin - tfMs : Date.now();
    while (since < fetchUntil) {
      const batch = await exchange.fetchOHLCV(symbol, timeframe, since, 1000);
      if (!batch.length) break;
      all.push(
        ...batch.map(([ts, open, high, low, close, volume]) => ({
          ts: ts as number,
          open: open as number,
          high: high as number,
          low: low as number,
          close: close as number,
          volume: volume as number,
        }))
      );
      const lastTs = batch[batch.length - 1][0] as number;
      if (lastTs >= fetchUntil) break;
      since = lastTs + 1;
    }
  }

  // 2. Fill recent gap (cachedMax → now)
  if (cachedMax && cachedMax < Date.now() - tfMs * 2) {
    let since = cachedMax + 1;
    while (true) {
      const batch = await exchange.fetchOHLCV(symbol, timeframe, since, 1000);
      if (!batch.length) break;
      all.push(
        ...batch.map(([ts, open, high, low, close, volume]) => ({
          ts: ts as number,
          open: open as number,
          high: high as number,
          low: low as number,
          close: close as number,
          volume: volume as number,
        }))
      );
      const lastTs = batch[batch.length - 1][0] as number;
      if (lastTs >= Date.now() - tfMs) break;
      since = lastTs + 1;
    }
  }

  // Upsert to Postgres in chunks of 500
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    for (const c of chunk) {
      const ts = new Date(c.ts).toISOString();
      await sql`
        INSERT INTO ohlcv (symbol, timeframe, ts, open, high, low, close, volume)
        VALUES (${symbol}, ${timeframe}, ${ts}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume})
        ON CONFLICT (symbol, timeframe, ts) DO NOTHING
      `;
    }
  }

  // Return whatever we fetched plus what's already in cache for this period
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
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

/** Append the last 200 candles (used by cron to keep cache fresh). */
export async function refreshCache(symbol: string, timeframe = "1h") {
  const since = Date.now() - 200 * exchange.parseTimeframe(timeframe) * 1000;
  const batch = await exchange.fetchOHLCV(symbol, timeframe, since, 200);
  for (const [ts, open, high, low, close, volume] of batch) {
    const tsStr = new Date(ts as number).toISOString();
    await sql`
      INSERT INTO ohlcv (symbol, timeframe, ts, open, high, low, close, volume)
      VALUES (${symbol}, ${timeframe}, ${tsStr}, ${open as number}, ${high as number},
              ${low as number}, ${close as number}, ${volume as number})
      ON CONFLICT (symbol, timeframe, ts) DO NOTHING
    `;
  }
}
