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
      symbol           TEXT PRIMARY KEY,
      direction        TEXT,
      entry_price      FLOAT8,
      entry_ts         TIMESTAMPTZ,
      entry_atr        FLOAT8,
      entry_bb_middle  FLOAT8
    )
  `;
  // Add entry_bb_middle to existing tables that predate this column
  await sql`
    ALTER TABLE paper_positions
    ADD COLUMN IF NOT EXISTS entry_bb_middle FLOAT8
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS strategy_results (
      params_hash      TEXT PRIMARY KEY,
      params_json      TEXT NOT NULL,
      total_return     FLOAT8,
      sharpe           FLOAT8,
      max_drawdown     FLOAT8,
      win_rate         FLOAT8,
      n_trades         INT,
      avg_duration     FLOAT8,
      final_capital    FLOAT8,
      mc_p5            FLOAT8,
      mc_p50           FLOAT8,
      mc_p95           FLOAT8,
      mc_pct_profit    FLOAT8,
      mc_median_return FLOAT8,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Add strategy + symbol columns (tracks which grid + pair produced each row)
  await sql`ALTER TABLE strategy_results ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'meanrev'`;
  await sql`ALTER TABLE strategy_results ADD COLUMN IF NOT EXISTS symbol   TEXT DEFAULT 'BTC/USDT:USDT'`;

  // optimizer_state_kv: TEXT primary key = "strategy:symbol", replaces the old integer-id table
  await sql`
    CREATE TABLE IF NOT EXISTS optimizer_state_kv (
      state_key    TEXT PRIMARY KEY,
      next_index   INT  NOT NULL DEFAULT 0,
      total_combos INT  NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Legacy table kept for backward compat — no longer written to
  await sql`
    CREATE TABLE IF NOT EXISTS optimizer_state (
      id           INT PRIMARY KEY DEFAULT 1,
      next_index   INT  DEFAULT 0,
      total_combos INT  DEFAULT 0,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export { sql };
