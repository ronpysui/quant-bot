import { sql, initSchema } from "./db";
import { createPool } from "@vercel/postgres";
import { fetchOHLCV } from "./data";
import { runBacktest } from "./backtester";
import { runMonteCarlo } from "./monte-carlo";
import type { Params } from "./strategy";

/** Generate an inclusive integer (or float) range. */
function range(start: number, stop: number, step = 1): number[] {
  const arr: number[] = [];
  for (let i = start; i <= stop; i = Math.round((i + step) * 1e9) / 1e9) arr.push(i);
  return arr;
}

// ── Parameter grid ────────────────────────────────────────────────────────────
// fastEma / slowEma: every integer in valid range for maximum EMA coverage.
// Other params: representative sampling with filled gaps in SL/TP.
//
// Valid EMA pairs (slowEma > fastEma):
//   fastEma 5-14 (10 values) × slowEma 15-50 step 1 (36 values) = 360 pairs
//   fastEma 15-25 (11 values) × decreasing valid slowEma           = 290 pairs
//   Total EMA pairs: 650
// Total: 650 × 3 × 2 × 4 × 5 × 5 ≈ 390,000 combinations (~4.5 hrs)
const GRID = {
  fastEma:   range(5, 25),                    // every integer 5..25  → 21 values
  slowEma:   range(15, 50),                   // every integer 15..50 → 36 values
  trendEma:  [50, 100, 200],                  // short / mid / long → 3 values
  rsiPeriod: [7, 14],                         // → 2 values
  rsiLow:    [30, 45],                        // momentum floor → 2 values
  rsiHigh:   [65, 80],                        // overbought ceiling → 2 values
  slMult:    [0.5, 1.0, 1.5, 2.0, 3.0],      // ATR stop-loss → 5 values
  tpMult:    [1.5, 2.0, 2.5, 3.0, 5.0],      // ATR take-profit → 5 values
};

/** Build the full list of valid parameter combinations once at module load. */
function buildAllCombos(): Params[] {
  const combos: Params[] = [];
  for (const fastEma of GRID.fastEma) {
    for (const slowEma of GRID.slowEma) {
      if (slowEma <= fastEma) continue;         // slowEma must be strictly greater
      for (const trendEma of GRID.trendEma) {
        for (const rsiPeriod of GRID.rsiPeriod) {
          for (const rsiLow of GRID.rsiLow) {
            for (const rsiHigh of GRID.rsiHigh) {
              if (rsiHigh <= rsiLow) continue;  // sanity guard
              for (const slMult of GRID.slMult) {
                for (const tpMult of GRID.tpMult) {
                  combos.push({
                    fastEma, slowEma, trendEma, rsiPeriod,
                    rsiLow, rsiHigh, slMult, tpMult,
                    positionSizePct: 1.0,
                    feePct: 0.001,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

const ALL_COMBOS = buildAllCombos(); // ≈ 104,544 valid combos, built once at startup

function paramsHash(p: Params): string {
  return [p.fastEma, p.slowEma, p.trendEma, p.rsiPeriod,
          p.rsiLow, p.rsiHigh, p.slMult, p.tpMult].join(",");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface OptimizerStatus {
  nextIndex:   number;
  totalCombos: number;
  completed:   number;
  isDone:      boolean;
  updatedAt:   string | null;
}

export async function getOptimizerStatus(): Promise<OptimizerStatus> {
  await initSchema();
  const { rows: stateRows } = await sql`SELECT * FROM optimizer_state WHERE id = 1`;
  const { rows: countRows } = await sql`SELECT COUNT(*) AS cnt FROM strategy_results`;

  const storedTotal = Number(stateRows[0].total_combos);

  // If the grid changed (app update), reset the index so we re-scan the new grid.
  // Existing results are kept — the existingSet pre-filter skips them efficiently.
  if (storedTotal > 0 && storedTotal !== ALL_COMBOS.length) {
    await sql`
      UPDATE optimizer_state
      SET next_index = 0, total_combos = ${ALL_COMBOS.length}, updated_at = NOW()
      WHERE id = 1
    `;
    return {
      nextIndex:   0,
      totalCombos: ALL_COMBOS.length,
      completed:   Number(countRows[0].cnt),
      isDone:      false,
      updatedAt:   new Date().toISOString(),
    };
  }

  // Normal path — sync total_combos in case it was 0
  await sql`UPDATE optimizer_state SET total_combos = ${ALL_COMBOS.length} WHERE id = 1`;

  return {
    nextIndex:   Number(stateRows[0].next_index),
    totalCombos: ALL_COMBOS.length,
    completed:   Number(countRows[0].cnt),
    isDone:      Number(stateRows[0].next_index) >= ALL_COMBOS.length,
    updatedAt:   stateRows[0].updated_at ?? null,
  };
}

export async function resetOptimizer(): Promise<void> {
  await initSchema();
  await sql`DELETE FROM strategy_results`;
  await sql`UPDATE optimizer_state SET next_index = 0, updated_at = NOW() WHERE id = 1`;
}

/**
 * Run a batch of backtests + Monte Carlo simulations.
 * Fetches OHLCV data once, then iterates through the next `batchSize` combos.
 * Reads the old next_index before updating so the slice is always exact,
 * even when remaining < batchSize at the end of the grid.
 */
export async function runOptimizerBatch(
  batchSize = 100
): Promise<{ ran: number; remaining: number }> {
  await initSchema();

  const pool = createPool();
  try {
    // 1. Read the OLD next_index first — this is the correct start of our slice.
    //    Using the new value from RETURNING would give wrong start when remaining < batchSize.
    const { rows: stateRows } = await pool.query<{ next_index: number }>(
      `SELECT next_index FROM optimizer_state WHERE id = 1`
    );
    const startIdx = Number(stateRows[0].next_index);

    if (startIdx >= ALL_COMBOS.length) {
      return { ran: 0, remaining: 0 };
    }

    const endIdx = Math.min(startIdx + batchSize, ALL_COMBOS.length);

    // 2. Advance the pointer immediately (claim this slice).
    await pool.query(
      `UPDATE optimizer_state
       SET next_index = $1, total_combos = $2, updated_at = NOW()
       WHERE id = 1`,
      [endIdx, ALL_COMBOS.length]
    );

    const combosToRun = ALL_COMBOS.slice(startIdx, endIdx);
    const hashes = combosToRun.map(paramsHash);

    // 3. Pre-filter hashes already in DB (safe for retries / overlapping calls).
    const { rows: existingRows } = await pool.query<{ params_hash: string }>(
      `SELECT params_hash FROM strategy_results WHERE params_hash = ANY($1::text[])`,
      [hashes]
    );
    const existingSet = new Set(existingRows.map((r) => r.params_hash));

    // 4. Fetch OHLCV data once for the entire batch.
    const candles = await fetchOHLCV("BTC/USDT:USDT", "1h", 1080);

    // 5. Run each combo.
    type Row = {
      hash: string; params: Params;
      totalReturn: number; sharpe: number; maxDrawdown: number;
      winRate: number; nTrades: number; avgDuration: number; finalCapital: number;
      mcP5: number | null; mcP50: number | null; mcP95: number | null;
      mcPctProfit: number | null; mcMedianReturn: number | null;
    };
    const results: Row[] = [];

    for (let i = 0; i < combosToRun.length; i++) {
      const params = combosToRun[i];
      const hash   = hashes[i];
      if (existingSet.has(hash)) continue;

      const { metrics, trades } = runBacktest(candles, params);
      const tradePnls = trades.map((t) => t.pnl);
      const mc = runMonteCarlo(tradePnls, 1000);

      results.push({
        hash, params,
        totalReturn:    metrics.totalReturn,
        sharpe:         metrics.sharpe,
        maxDrawdown:    metrics.maxDrawdown,
        winRate:        metrics.winRate,
        nTrades:        metrics.nTrades,
        avgDuration:    metrics.avgDurationHrs,
        finalCapital:   metrics.finalCapital,
        mcP5:           mc?.p5            ?? null,
        mcP50:          mc?.median        ?? null,
        mcP95:          mc?.p95           ?? null,
        mcPctProfit:    mc?.pctProfitable ?? null,
        mcMedianReturn: mc?.medianReturn  ?? null,
      });
    }

    // 6. Batch upsert — single round-trip for all results.
    if (results.length > 0) {
      await pool.query(
        `INSERT INTO strategy_results (
           params_hash, params_json, total_return, sharpe, max_drawdown, win_rate,
           n_trades, avg_duration, final_capital,
           mc_p5, mc_p50, mc_p95, mc_pct_profit, mc_median_return
         )
         SELECT
           unnest($1::text[]),  unnest($2::text[]),
           unnest($3::float8[]), unnest($4::float8[]),
           unnest($5::float8[]), unnest($6::float8[]),
           unnest($7::int[]),    unnest($8::float8[]),
           unnest($9::float8[]),
           unnest($10::float8[]), unnest($11::float8[]),
           unnest($12::float8[]), unnest($13::float8[]),
           unnest($14::float8[])
         ON CONFLICT (params_hash) DO NOTHING`,
        [
          results.map((r) => r.hash),
          results.map((r) => JSON.stringify({
            fastEma: r.params.fastEma, slowEma: r.params.slowEma,
            trendEma: r.params.trendEma, rsiPeriod: r.params.rsiPeriod,
            rsiLow: r.params.rsiLow, rsiHigh: r.params.rsiHigh,
            slMult: r.params.slMult, tpMult: r.params.tpMult,
            positionSizePct: r.params.positionSizePct, feePct: r.params.feePct,
          })),
          results.map((r) => r.totalReturn),
          results.map((r) => r.sharpe),
          results.map((r) => r.maxDrawdown),
          results.map((r) => r.winRate),
          results.map((r) => r.nTrades),
          results.map((r) => r.avgDuration),
          results.map((r) => r.finalCapital),
          results.map((r) => r.mcP5),
          results.map((r) => r.mcP50),
          results.map((r) => r.mcP95),
          results.map((r) => r.mcPctProfit),
          results.map((r) => r.mcMedianReturn),
        ]
      );
    }

    return {
      ran:       combosToRun.length,
      remaining: Math.max(0, ALL_COMBOS.length - endIdx),
    };
  } finally {
    await pool.end();
  }
}

export type SortColumn =
  | "total_return" | "sharpe" | "max_drawdown" | "win_rate"
  | "n_trades" | "mc_p50" | "mc_pct_profit" | "mc_median_return";

export interface StrategyRow {
  params_hash:      string;
  params_json:      string;
  total_return:     number;
  sharpe:           number;
  max_drawdown:     number;
  win_rate:         number;
  n_trades:         number;
  avg_duration:     number;
  final_capital:    number;
  mc_p5:            number | null;
  mc_p50:           number | null;
  mc_p95:           number | null;
  mc_pct_profit:    number | null;
  mc_median_return: number | null;
}

const VALID_SORTS: SortColumn[] = [
  "total_return", "sharpe", "max_drawdown", "win_rate",
  "n_trades", "mc_p50", "mc_pct_profit", "mc_median_return",
];

export async function getTopResults(
  limit = 50,
  sortBy: SortColumn = "total_return"
): Promise<StrategyRow[]> {
  await initSchema();
  const col = VALID_SORTS.includes(sortBy) ? sortBy : "total_return";
  const pool = createPool();
  try {
    const { rows } = await pool.query<StrategyRow>(
      `SELECT * FROM strategy_results ORDER BY ${col} DESC NULLS LAST LIMIT $1`,
      [limit]
    );
    return rows;
  } finally {
    await pool.end();
  }
}
