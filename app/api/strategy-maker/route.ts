import { NextRequest, NextResponse } from "next/server";
import {
  getOptimizerStatus,
  getTopResults,
  resetOptimizer,
  runOptimizerBatch,
  type SortColumn,
  type StrategyType,
} from "@/lib/strategy-maker";

const VALID_STRATEGIES: StrategyType[] = ["meanrev", "scalp"];

function parseStrategy(s: string | null): StrategyType {
  return VALID_STRATEGIES.includes(s as StrategyType) ? (s as StrategyType) : "meanrev";
}

function parseSymbol(s: string | null): string {
  return s && s.trim().length > 0 ? s.trim() : "BTC/USDT:USDT";
}

/** GET /api/strategy-maker — return current status + top results */
export async function GET(req: NextRequest) {
  try {
    const sortBy   = (req.nextUrl.searchParams.get("sortBy") ?? "total_return") as SortColumn;
    const strategy = parseStrategy(req.nextUrl.searchParams.get("strategy"));
    const symbol   = parseSymbol(req.nextUrl.searchParams.get("symbol"));
    const [status, results] = await Promise.all([
      getOptimizerStatus(strategy, symbol),
      getTopResults(50, sortBy, strategy, symbol),
    ]);
    return NextResponse.json({ status, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** POST /api/strategy-maker — run a batch then return updated status + results */
export async function POST(req: NextRequest) {
  try {
    const body      = await req.json().catch(() => ({}));
    const batchSize: number       = body.batchSize ?? 100;
    const sortBy:    SortColumn   = body.sortBy    ?? "total_return";
    const strategy: StrategyType  = parseStrategy(body.strategy);
    const symbol:   string        = parseSymbol(body.symbol);

    const { ran, remaining } = await runOptimizerBatch(batchSize, strategy, symbol);
    const [status, results] = await Promise.all([
      getOptimizerStatus(strategy, symbol),
      getTopResults(50, sortBy, strategy, symbol),
    ]);

    return NextResponse.json({ ran, remaining, status, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** DELETE /api/strategy-maker — wipe results for the given (strategy, symbol) pair */
export async function DELETE(req: NextRequest) {
  try {
    const strategy = parseStrategy(req.nextUrl.searchParams.get("strategy"));
    const symbol   = parseSymbol(req.nextUrl.searchParams.get("symbol"));
    await resetOptimizer(strategy, symbol);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
