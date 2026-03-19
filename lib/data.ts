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

// BloFin: live/recent price (last ~4 days — sufficient for paper trading)
const liveExchange = new ccxt.blofin({ enableRateLimit: true });

/** Parse "BTC/USDT:USDT" → { fsym:"BTC", tsym:"USDT" } for CryptoCompare */
function parseSymbol(symbol: string): { fsym: string; tsym: string } {
  const [base, quoteRaw] = symbol.split("/");
  return { fsym: base, tsym: quoteRaw.split(":")[0] };
}

/**
 * CryptoCompare free API: up to 2000 hourly candles per call, no rate limit,
 * no API key, no geo-restrictions. toTs is milliseconds (converted to seconds).
 */
async function fetchCC(
  fsym: string,
  tsym: string,
  toTs: number,
  limit = 2000
): Promise<Candle[]> {
  const url =
    `https://min-api.cryptocompare.com/data/v2/histohour` +
    `?fsym=${fsym}&tsym=${tsym}&limit=${limit}&toTs=${Math.floor(toTs / 1000)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.Response !== "Success") throw new Error(json.Message ?? "CryptoCompare error");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (json.Data.Data as any[])
    .filter((d) => d.open > 0 && d.close > 0)
    .map((d) => ({
      ts:     d.time * 1000,
      open:   d.open,
      high:   d.high,
      low:    d.low,
      close:  d.close,
      volume: d.volumefrom,
    }));
}

/** Single SQL round-trip insert via PostgreSQL unnest — fast regardless of row count. */
async function batchUpsert(candles: Candle[], symbol: string, timeframe: string) {
  if (!candles.length) return;
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
        candles.map((c) => new Date(c.ts).toISOString()),
        candles.map((c) => c.open),
        candles.map((c) => c.high),
        candles.map((c) => c.low),
        candles.map((c) => c.close),
        candles.map((c) => c.volume),
      ]
    );
  } finally {
    await pool.end();
  }
}

/**
 * Fetch OHLCV candles.
 * - Serves from Postgres cache when it is large enough AND covers the window.
 * - Otherwise seeds incrementally from CryptoCompare (2000 candles/request,
 *   no rate limit) — a full year seeds in ~2 s across 5 requests.
 */
export async function fetchOHLCV(
  symbol: string,
  timeframe = "1h",
  days = 365
): Promise<Candle[]> {
  await initSchema();

  const windowMs    = days * 86_400_000;
  const sinceMs     = Date.now() - windowMs;
  const minRequired = Math.max(500, days * 20);

  const { rows } = await sql`
    SELECT COUNT(*)  AS cnt,
           MIN(ts)   AS min_ts,
           MAX(ts)   AS max_ts
    FROM ohlcv
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
  `;
  const cached = Number(rows[0].cnt);
  const minTs  = rows[0].min_ts ? new Date(rows[0].min_ts).getTime() : null;

  // Coverage: oldest cached candle must reach at least 90 % of the window
  const coverageOk =
    minTs !== null && minTs <= sinceMs + windowMs * 0.1;

  if (cached >= minRequired && coverageOk) {
    return queryWindow(symbol, timeframe, sinceMs);
  }

  // ── Seed missing history from CryptoCompare ──────────────────────────────
  const { fsym, tsym } = parseSymbol(symbol);
  // Start from the oldest cached candle (or now if cache is empty/only recent)
  let toTs   = minTs ?? Date.now();
  const newCandles: Candle[] = [];

  for (let i = 0; i < 6; i++) {
    const batch = await fetchCC(fsym, tsym, toTs, 2000);
    if (!batch.length) break;
    newCandles.push(...batch);
    const oldestTs = batch[0].ts;          // ascending order, first = oldest
    if (oldestTs <= sinceMs) break;        // covered the full window
    toTs = oldestTs - 1;                   // next page: older data
  }

  // ── Top-up with BloFin recent candles (live-accurate pricing) ───────────
  try {
    const recent    = await liveExchange.fetchOHLCV(symbol, timeframe, undefined, 200);
    const latestInNew = newCandles.length ? newCandles[newCandles.length - 1].ts : 0;
    const latestInDb  = rows[0].max_ts ? new Date(rows[0].max_ts).getTime() : 0;
    const cutoff      = Math.max(latestInNew, latestInDb);
    const fresh = recent
      .filter(([ts]) => (ts as number) > cutoff)
      .map(([ts, o, h, l, c, v]) => ({
        ts: ts as number, open: o as number, high: h as number,
        low: l as number, close: c as number, volume: v as number,
      }));
    newCandles.push(...fresh);
  } catch {
    // BloFin unavailable — CryptoCompare data is sufficient
  }

  if (newCandles.length > 0) {
    await batchUpsert(newCandles, symbol, timeframe);
  }

  return queryWindow(symbol, timeframe, sinceMs);
}

async function queryWindow(
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
    open:   r.open,
    high:   r.high,
    low:    r.low,
    close:  r.close,
    volume: r.volume,
  }));
}

/** Keep cache fresh — called by daily cron. */
export async function refreshCache(symbol: string, timeframe = "1h") {
  let candles: Candle[] = [];
  try {
    const batch = await liveExchange.fetchOHLCV(symbol, timeframe, undefined, 100);
    candles = batch.map(([ts, o, h, l, c, v]) => ({
      ts: ts as number, open: o as number, high: h as number,
      low: l as number, close: c as number, volume: v as number,
    }));
  } catch {
    const { fsym, tsym } = parseSymbol(symbol);
    candles = await fetchCC(fsym, tsym, Date.now(), 100);
  }
  await batchUpsert(candles, symbol, timeframe);
}
