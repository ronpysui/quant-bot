import { sql, initSchema } from "./db";
import { createPool } from "@vercel/postgres";
import { fetchOHLCV } from "./data";
import { runBacktest } from "./backtester";
import { runMonteCarlo } from "./monte-carlo";
import type { Params } from "./strategy";

export type StrategyType = "meanrev" | "scalp";

// ── Parameter grids ────────────────────────────────────────────────────────────

// Mean Reversion: BB + RSI — 10 × 9 × 4 × 6 × 7 = 15,120 combos
const MEANREV_GRID = {
  bbPeriod:    [8, 10, 12, 14, 16, 18, 20, 24, 28, 32],
  bbStdDev:    [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0],
  rsiPeriod:   [7, 10, 14, 21],
  rsiOversold: [20, 25, 30, 35, 40, 45],
  slMult:      [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0],
};

// EMA Scalp: BB + EMA trend + ATR target + vol filter — 3×3×3×3×3×4×4×3 = 11,664 combos
const SCALP_GRID = {
  bbPeriod:  [10, 14, 20],
  bbStdDev:  [1.5, 2.0, 2.5],
  emaFast:   [5, 9, 13],
  emaSlow:   [18, 21, 26],
  rsiMid:    [45, 50, 55],
  atrTarget: [0.5, 0.75, 1.0, 1.5],
  slMult:    [0.75, 1.0, 1.5, 2.0],
  volFilter: [1.0, 1.2, 1.5],  // 1.0 = off, 1.2 = 20% above SMA, 1.5 = 50% spike
};

/** Asset-class-specific base params for a given symbol */
function buildBaseParams(symbol: string): Pick<
  Params, "assetType" | "contractMultiplier" | "numContracts" | "feeDollar"
        | "initialCapital" | "filterRTH" | "positionSizePct" | "feePct"
> {
  if (symbol.endsWith("=F")) {
    const isMNQ = symbol.startsWith("MNQ");
    return {
      assetType: "futures",
      contractMultiplier: isMNQ ? 2 : 20,
      numContracts: 1,
      feeDollar: 1.50,
      initialCapital: isMNQ ? 5_000 : 50_000,
      filterRTH: false,   // no RTH filter during optimizer — more data = better signal
      positionSizePct: 0.01,
      feePct: 0.0002,
    };
  }
  return {
    assetType: "crypto",
    contractMultiplier: 2,
    numContracts: 1,
    feeDollar: 1.50,
    initialCapital: 10_000,
    filterRTH: false,
    positionSizePct: 0.01,
    feePct: 0.0002,
  };
}

function buildMeanrevCombos(symbol: string): Params[] {
  const base = buildBaseParams(symbol);
  const combos: Params[] = [];
  for (const bbPeriod of MEANREV_GRID.bbPeriod) {
    for (const bbStdDev of MEANREV_GRID.bbStdDev) {
      for (const rsiPeriod of MEANREV_GRID.rsiPeriod) {
        for (const rsiOversold of MEANREV_GRID.rsiOversold) {
          for (const slMult of MEANREV_GRID.slMult) {
            combos.push({
              strategy: "meanrev",
              bbPeriod, bbStdDev, rsiPeriod, rsiOversold, slMult,
              allowShorts: false,
              emaFast: 9, emaSlow: 21, rsiMid: 50, atrTarget: 1.0, volFilter: 1.0,
              ...base,
            });
          }
        }
      }
    }
  }
  return combos;
}

function buildScalpCombos(symbol: string): Params[] {
  const base = buildBaseParams(symbol);
  const combos: Params[] = [];
  for (const bbPeriod of SCALP_GRID.bbPeriod) {
    for (const bbStdDev of SCALP_GRID.bbStdDev) {
      for (const emaFast of SCALP_GRID.emaFast) {
        for (const emaSlow of SCALP_GRID.emaSlow) {
          for (const rsiMid of SCALP_GRID.rsiMid) {
            for (const atrTarget of SCALP_GRID.atrTarget) {
              for (const slMult of SCALP_GRID.slMult) {
                for (const volFilter of SCALP_GRID.volFilter) {
                  combos.push({
                    strategy: "scalp",
                    bbPeriod, bbStdDev,
                    emaFast, emaSlow, rsiMid, atrTarget, slMult, volFilter,
                    rsiPeriod: 14, rsiOversold: 30,
                    allowShorts: false,
                    ...base,
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

function getCombos(strategy: StrategyType, symbol: string): Params[] {
  return strategy === "scalp" ? buildScalpCombos(symbol) : buildMeanrevCombos(symbol);
}

function totalCombos(strategy: StrategyType): number {
  return strategy === "scalp" ? 11_664 : 15_120;
}

/** Unique key for optimizer_state_kv row */
function stateKey(strategy: StrategyType, symbol: string): string {
  return `${strategy}:${symbol}`;
}

/** Hash includes symbol to prevent cross-pair collisions in strategy_results */
function paramsHash(p: Params, symbol: string): string {
  if (p.strategy === "scalp") {
    return [symbol, "s", p.bbPeriod, p.bbStdDev, p.emaFast, p.emaSlow, p.rsiMid, p.atrTarget, p.slMult, p.volFilter].join("|");
  }
  return [symbol, p.bbPeriod, p.bbStdDev, p.rsiPeriod, p.rsiOversold, p.slMult].join("|");
}

function serializeParams(p: Params): string {
  const base = {
    strategy: p.strategy,
    bbPeriod: p.bbPeriod, bbStdDev: p.bbStdDev,
    slMult: p.slMult,
    rsiPeriod: p.rsiPeriod, rsiOversold: p.rsiOversold,
    positionSizePct: p.positionSizePct, feePct: p.feePct,
    assetType: p.assetType, contractMultiplier: p.contractMultiplier,
    numContracts: p.numContracts, feeDollar: p.feeDollar,
  };
  if (p.strategy === "scalp") {
    return JSON.stringify({ ...base, emaFast: p.emaFast, emaSlow: p.emaSlow, rsiMid: p.rsiMid, atrTarget: p.atrTarget });
  }
  return JSON.stringify(base);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface OptimizerStatus {
  nextIndex:   number;
  totalCombos: number;
  completed:   number;
  isDone:      boolean;
  updatedAt:   string | null;
}

export async function getOptimizerStatus(
  strategy: StrategyType = "meanrev",
  symbol = "BTC/USDT:USDT"
): Promise<OptimizerStatus> {
  await initSchema();
  const key    = stateKey(strategy, symbol);
  const total  = totalCombos(strategy);

  // Ensure the state row exists for this (strategy, symbol)
  await sql`
    INSERT INTO optimizer_state_kv (state_key, next_index, total_combos)
    VALUES (${key}, 0, 0)
    ON CONFLICT (state_key) DO NOTHING
  `;

  const { rows: stateRows } = await sql`SELECT * FROM optimizer_state_kv WHERE state_key = ${key}`;
  const { rows: countRows } = await sql`
    SELECT COUNT(*) AS cnt FROM strategy_results
    WHERE strategy = ${strategy} AND symbol = ${symbol}
  `;

  const storedTotal = Number(stateRows[0].total_combos);
  if (storedTotal > 0 && storedTotal !== total) {
    // Grid size changed — reset this entry
    await sql`
      UPDATE optimizer_state_kv
      SET next_index = 0, total_combos = ${total}, updated_at = NOW()
      WHERE state_key = ${key}
    `;
    return {
      nextIndex: 0, totalCombos: total,
      completed: Number(countRows[0].cnt),
      isDone: false, updatedAt: new Date().toISOString(),
    };
  }

  await sql`UPDATE optimizer_state_kv SET total_combos = ${total} WHERE state_key = ${key}`;

  return {
    nextIndex:   Number(stateRows[0].next_index),
    totalCombos: total,
    completed:   Number(countRows[0].cnt),
    isDone:      Number(stateRows[0].next_index) >= total,
    updatedAt:   stateRows[0].updated_at ?? null,
  };
}

export async function resetOptimizer(
  strategy: StrategyType = "meanrev",
  symbol = "BTC/USDT:USDT"
): Promise<void> {
  await initSchema();
  const key = stateKey(strategy, symbol);
  await sql`DELETE FROM strategy_results WHERE strategy = ${strategy} AND symbol = ${symbol}`;
  await sql`
    INSERT INTO optimizer_state_kv (state_key, next_index, total_combos)
    VALUES (${key}, 0, 0)
    ON CONFLICT (state_key) DO UPDATE SET next_index = 0, updated_at = NOW()
  `;
}

export async function runOptimizerBatch(
  batchSize = 100,
  strategy: StrategyType = "meanrev",
  symbol = "BTC/USDT:USDT"
): Promise<{ ran: number; remaining: number }> {
  await initSchema();
  const key    = stateKey(strategy, symbol);
  const combos = getCombos(strategy, symbol);

  const pool = createPool();
  try {
    // Ensure state row exists
    await pool.query(
      `INSERT INTO optimizer_state_kv (state_key, next_index, total_combos)
       VALUES ($1, 0, 0) ON CONFLICT (state_key) DO NOTHING`,
      [key]
    );

    const { rows: stateRows } = await pool.query<{ next_index: number }>(
      `SELECT next_index FROM optimizer_state_kv WHERE state_key = $1`,
      [key]
    );
    const startIdx = Number(stateRows[0].next_index);

    if (startIdx >= combos.length) {
      return { ran: 0, remaining: 0 };
    }

    const endIdx = Math.min(startIdx + batchSize, combos.length);

    await pool.query(
      `UPDATE optimizer_state_kv
       SET next_index = $1, total_combos = $2, updated_at = NOW()
       WHERE state_key = $3`,
      [endIdx, combos.length, key]
    );

    const combosToRun = combos.slice(startIdx, endIdx);
    const hashes = combosToRun.map((p) => paramsHash(p, symbol));

    const { rows: existingRows } = await pool.query<{ params_hash: string }>(
      `SELECT params_hash FROM strategy_results
       WHERE strategy = $1 AND symbol = $2 AND params_hash = ANY($3::text[])`,
      [strategy, symbol, hashes]
    );
    const existingSet = new Set(existingRows.map((r) => r.params_hash));

    // Fetch OHLCV — futures: 1825 days (1H up to 730, auto-falls back to 1D beyond)
    // Crypto: 1080 days of 1H from CryptoCompare (no cap)
    const days = symbol.endsWith("=F") ? 1825 : 1080;
    const candles = await fetchOHLCV(symbol, "1h", days);

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

    if (results.length > 0) {
      await pool.query(
        `INSERT INTO strategy_results (
           strategy, symbol, params_hash, params_json,
           total_return, sharpe, max_drawdown, win_rate,
           n_trades, avg_duration, final_capital,
           mc_p5, mc_p50, mc_p95, mc_pct_profit, mc_median_return
         )
         SELECT
           $1, $2,
           unnest($3::text[]),  unnest($4::text[]),
           unnest($5::float8[]), unnest($6::float8[]),
           unnest($7::float8[]), unnest($8::float8[]),
           unnest($9::int[]),    unnest($10::float8[]),
           unnest($11::float8[]),
           unnest($12::float8[]), unnest($13::float8[]),
           unnest($14::float8[]), unnest($15::float8[]),
           unnest($16::float8[])
         ON CONFLICT (params_hash) DO NOTHING`,
        [
          strategy,
          symbol,
          results.map((r) => r.hash),
          results.map((r) => serializeParams(r.params)),
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
      remaining: Math.max(0, combos.length - endIdx),
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
  strategy:         string;
  symbol:           string;
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
  sortBy: SortColumn = "total_return",
  strategy: StrategyType = "meanrev",
  symbol = "BTC/USDT:USDT"
): Promise<StrategyRow[]> {
  await initSchema();
  const col = VALID_SORTS.includes(sortBy) ? sortBy : "total_return";
  const pool = createPool();
  try {
    const { rows } = await pool.query<StrategyRow>(
      `SELECT * FROM strategy_results
       WHERE strategy = $1 AND symbol = $2
       ORDER BY ${col} DESC NULLS LAST LIMIT $3`,
      [strategy, symbol, limit]
    );
    return rows;
  } finally {
    await pool.end();
  }
}
