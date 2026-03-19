import { sql } from "@vercel/postgres";

export async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS ohlcv (
      symbol    TEXT,
      timeframe TEXT,
      ts        TIMESTAMPTZ,
      open      FLOAT8,
      high      FLOAT8,
      low       FLOAT8,
      close     FLOAT8,
      volume    FLOAT8,
      PRIMARY KEY (symbol, timeframe, ts)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ DEFAULT NOW(),
      symbol    TEXT,
      direction TEXT,
      entry_price FLOAT8,
      exit_price  FLOAT8,
      pnl         FLOAT8,
      status      TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS paper_positions (
      symbol      TEXT PRIMARY KEY,
      direction   TEXT,
      entry_price FLOAT8,
      entry_ts    TIMESTAMPTZ,
      entry_atr   FLOAT8
    )
  `;
}

export { sql };
