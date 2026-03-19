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
  await sql`
    CREATE TABLE IF NOT EXISTS optimizer_state (
      id          INT PRIMARY KEY DEFAULT 1,
      next_index  INT  DEFAULT 0,
      total_combos INT DEFAULT 0,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Ensure the single optimizer_state row exists
  await sql`
    INSERT INTO optimizer_state (id, next_index, total_combos)
    VALUES (1, 0, 0)
    ON CONFLICT (id) DO NOTHING
  `;
}

export { sql };
