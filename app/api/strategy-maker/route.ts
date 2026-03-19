import { NextRequest, NextResponse } from "next/server";
import {
  getOptimizerStatus,
  getTopResults,
  resetOptimizer,
  runOptimizerBatch,
  type SortColumn,
} from "@/lib/strategy-maker";

/** GET /api/strategy-maker — return current status + top results (no compute) */
export async function GET(req: NextRequest) {
  try {
    const sortBy = (req.nextUrl.searchParams.get("sortBy") ?? "total_return") as SortColumn;
    const [status, results] = await Promise.all([
      getOptimizerStatus(),
      getTopResults(50, sortBy),
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
    const body = await req.json().catch(() => ({}));
    const batchSize: number = body.batchSize ?? 30;
    const sortBy: SortColumn = body.sortBy ?? "total_return";

    const { ran, remaining } = await runOptimizerBatch(batchSize);
    const [status, results] = await Promise.all([
      getOptimizerStatus(),
      getTopResults(50, sortBy),
    ]);

    return NextResponse.json({ ran, remaining, status, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** DELETE /api/strategy-maker — wipe all results and reset index to 0 */
export async function DELETE() {
  try {
    await resetOptimizer();
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
