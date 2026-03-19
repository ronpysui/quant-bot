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

// Kraken: deep historical data (365d+), accessible from Vercel US servers
const historyExchange = new ccxt.kraken({ enableRateLimit: true });
// BloFin: accurate recent price for paper trading (last ~4 days available)
const liveExchange = new ccxt.blofin({ enableRateLimit: true });

/**
 * Map UI symbols (USDT perpetual format) to Kraken symbols (USD spot).
 * BTC/USDT:USDT → BTC/USD. Prices track within 0.1% — signals are identical.
 */
function toKrakenSymbol(symbol: string): string {
  return symbol.replace(/\/USDT(?::USDT)?$/, "/USD");
}

/**
 * Fetch OHLCV candles.
 * - Serves from Postgres cache if we have enough rows for the requested period.
 * - Falls back to seeding from Kraken (historical) + BloFin (recent top-up).
 */
export async function fetchOHLCV(
  symbol: string,
  timeframe = "1h",
  days = 365
): Promise<Candle[]> {
  await initSchema();

  // Need ~20 candles/day minimum to consider cache adequate
  const minRequired = Math.max(500, days * 20);

  const { rows } = await sql`
    SELECT COUNT(*) AS cnt FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `;
  const cached = Number(rows[0].cnt);

  if (cached >= minRequired) {
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

  // Not enough data — seed history from Kraken + top-up recent from BloFin
  return await seedHistory(symbol, timeframe, days);
}

/**
 * Seed historical data using Kraken (deep history) then top-up recent
 * candles from BloFin (accurate live pricing).
 * Stored under the original UI symbol so the cache is exchange-agnostic.
 */
export async function seedHistory(
  symbol: string,
  timeframe: string,
  days: number
): Promise<Candle[]> {
  const krakenSymbol = toKrakenSymbol(symbol); // e.g. BTC/USDT:USDT → BTC/USD
  const sinceMs = Date.now() - days * 86_400_000;
  const tfMs = historyExchange.parseTimeframe(timeframe) * 1000;

  // Find what's already cached to avoid re-fetching existing ranges
  const { rows: bounds } = await sql`
    SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `;
  const cachedMin = bounds[0].min_ts ? new Date(bounds[0].min_ts).getTime() : null;
  const cachedMax = bounds[0].max_ts ? new Date(bounds[0].max_ts).getTime() : null;

  const all: Candle[] = [];

  // ── 1. Fill historical gap (sinceMs → cachedMin) via Kraken ──────────────
  if (!cachedMin || cachedMin > sinceMs + tfMs) {
    let since = sinceMs;
    const fetchUntil = cachedMin ? cachedMin - tfMs : Date.now();

    while (since < fetchUntil) {
      const batch = await historyExchange.fetchOHLCV(krakenSymbol, timeframe, since, 720);
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

  // ── 2. Top-up recent candles via BloFin (accurate live price) ────────────
  // BloFin returns last ~4 days regardless of since — fetch and merge
  try {
    const recent = await liveExchange.fetchOHLCV(symbol, timeframe, undefined, 200);
    const recentCutoff = cachedMax ?? sinceMs;
    const fresh = recent
      .filter(([ts]) => (ts as number) > recentCutoff)
      .map(([ts, open, high, low, close, volume]) => ({
        ts: ts as number,
        open: open as number,
        high: high as number,
        low: low as number,
        close: close as number,
        volume: volume as number,
      }));
    all.push(...fresh);
  } catch {
    // BloFin unavailable — Kraken data is sufficient
  }

  // ── 3. Upsert all fetched candles to Postgres ─────────────────────────────
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

  // Return the full requested window from DB
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

/**
 * Append the latest candles to keep cache fresh (called by cron).
 * Uses BloFin for accuracy, falls back to Kraken if unavailable.
 */
export async function refreshCache(symbol: string, timeframe = "1h") {
  let batch: ReturnType<typeof liveExchange.fetchOHLCV> extends Promise<infer T> ? T : never;

  try {
    batch = await liveExchange.fetchOHLCV(symbol, timeframe, undefined, 100);
  } catch {
    // BloFin unavailable — use Kraken
    const krakenSymbol = toKrakenSymbol(symbol);
    const since = Date.now() - 200 * historyExchange.parseTimeframe(timeframe) * 1000;
    batch = await historyExchange.fetchOHLCV(krakenSymbol, timeframe, since, 200);
  }

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
