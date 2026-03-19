import { sql, initSchema } from "./db";
import { createPool } from "@vercel/postgres";
import { fetchOHLCV } from "./data";
import { runBacktest } from "./backtester";
import { runMonteCarlo } from "./monte-carlo";
import type { Params } from "./strategy";

// ── Parameter grid ────────────────────────────────────────────────────────────
// Each array is the discrete values tested for that parameter.
// Constraints: slowEma > fastEma (enforced at generation time).
const GRID = {
  fastEma:   [5, 8, 13, 21],
  slowEma:   [15, 21, 34, 50],
  trendEma:  [50, 100, 150, 200],
  rsiPeriod: [7, 14],
  rsiLow:    [30, 40, 50],
  rsiHigh:   [60, 70, 80],   // always > rsiLow (min rsiHigh=60 > max rsiLow=50)
  slMult:    [0.5, 1.0, 2.0],
  tpMult:    [1.5, 2.5, 4.0],
} as const;

/** Build the full list of valid parameter combinations once at module load. */
function buildAllCombos(): Params[] {
  const combos: Params[] = [];
  for (const fastEma of GRID.fastEma) {
    for (const slowEma of GRID.slowEma) {
      if (slowEma <= fastEma) continue;           // slowEma must be strictly greater
      for (const trendEma of GRID.trendEma) {
        for (const rsiPeriod of GRID.rsiPeriod) {
          for (const rsiLow of GRID.rsiLow) {
            for (const rsiHigh of GRID.rsiHigh) {
              for (const slMult of GRID.slMult) {
                for (const tpMult of GRID.tpMult) {
                  combos.push({
                    fastEma, slowEma, trendEma, rsiPeriod,
                    rsiLow, rsiHigh, slMult, tpMult,
                    positionSizePct: 0.1,
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

const ALL_COMBOS = buildAllCombos();   // ~9,072 valid combos, built once

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
  // Sync total_combos in case it changed (e.g. grid update)
  await sql`
    UPDATE optimizer_state
    SET total_combos = ${ALL_COMBOS.length}
    WHERE id = 1
  `;
  const { rows: stateRows } = await sql`SELECT * FROM optimizer_state WHERE id = 1`;
  const { rows: countRows } = await sql`SELECT COUNT(*) AS cnt FROM strategy_results`;
  return {
    nextIndex:   stateRows[0].next_index,
    totalCombos: ALL_COMBOS.length,
    completed:   Number(countRows[0].cnt),
    isDone:      stateRows[0].next_index >= ALL_COMBOS.length,
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
 * Safe to call concurrently — uses a DB-level state update at the END of the
 * batch so each invocation atomically claims its slice.
 */
export async function runOptimizerBatch(
  batchSize = 30
): Promise<{ ran: number; remaining: number }> {
  await initSchema();

  // Atomically claim the next slice of combos
  const { rows } = await sql`
    UPDATE optimizer_state
    SET next_index   = LEAST(next_index + ${batchSize}, ${ALL_COMBOS.length}),
        total_combos = ${ALL_COMBOS.length},
        updated_at   = NOW()
    WHERE id = 1
    RETURNING (next_index - ${batchSize}) AS start_idx, next_index AS end_idx
  `;

  const startIdx = Math.max(0, Number(rows[0].start_idx));
  const endIdx   = Math.min(Number(rows[0].end_idx), ALL_COMBOS.length);

  if (startIdx >= ALL_COMBOS.length || startIdx >= endIdx) {
    return { ran: 0, remaining: 0 };
  }

  const combosToRun = ALL_COMBOS.slice(startIdx, endIdx);

  // Pre-filter hashes that already exist (idempotency — handles retries)
  const hashes = combosToRun.map(paramsHash);
  const pool = createPool();
  try {
    const { rows: existingRows } = await pool.query<{ params_hash: string }>(
      `SELECT params_hash FROM strategy_results WHERE params_hash = ANY($1::text[])`,
      [hashes]
    );
    const existingSet = new Set(existingRows.map((r) => r.params_hash));

    // Fetch OHLCV data once for this whole batch (1080 days, BTC only)
    const candles = await fetchOHLCV("BTC/USDT:USDT", "1h", 1080);

    // Run each combo
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
        totalReturn:     metrics.totalReturn,
        sharpe:          metrics.sharpe,
        maxDrawdown:     metrics.maxDrawdown,
        winRate:         metrics.winRate,
        nTrades:         metrics.nTrades,
        avgDuration:     metrics.avgDurationHrs,
        finalCapital:    metrics.finalCapital,
        mcP5:            mc?.p5            ?? null,
        mcP50:           mc?.median        ?? null,
        mcP95:           mc?.p95           ?? null,
        mcPctProfit:     mc?.pctProfitable ?? null,
        mcMedianReturn:  mc?.medianReturn  ?? null,
      });
    }

    // Batch upsert all results in one round-trip
    if (results.length > 0) {
      await pool.query(
        `INSERT INTO strategy_results (
           params_hash, params_json, total_return, sharpe, max_drawdown, win_rate,
           n_trades, avg_duration, final_capital,
           mc_p5, mc_p50, mc_p95, mc_pct_profit, mc_median_return
         )
         SELECT
           unnest($1::text[]),
           unnest($2::text[]),
           unnest($3::float8[]),
           unnest($4::float8[]),
           unnest($5::float8[]),
           unnest($6::float8[]),
           unnest($7::int[]),
           unnest($8::float8[]),
           unnest($9::float8[]),
           unnest($10::float8[]),
           unnest($11::float8[]),
           unnest($12::float8[]),
           unnest($13::float8[]),
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
