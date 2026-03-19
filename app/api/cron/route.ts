import { NextRequest, NextResponse } from "next/server";
import { runCycle } from "@/lib/paper-trader";
import { refreshCache } from "@/lib/data";
import { runOptimizerBatch } from "@/lib/strategy-maker";
import { DEFAULT_PARAMS } from "@/lib/strategy";

export async function GET(req: NextRequest) {
  // Protect the cron endpoint
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Refresh cache + run paper trading cycle for active symbols
  const symbols = ["BTC/USDT:USDT", "ETH/USDT:USDT"];
  const paperResults: Record<string, string> = {};

  for (const sym of symbols) {
    await refreshCache(sym, "1h");
    paperResults[sym] = await runCycle(sym, DEFAULT_PARAMS);
  }

  // Advance the optimizer by a small batch (stays within Vercel's 10s limit)
  const { ran, remaining } = await runOptimizerBatch(30);

  return NextResponse.json({
    ok: true,
    paper: paperResults,
    optimizer: { ran, remaining },
  });
}
