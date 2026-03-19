import { NextRequest, NextResponse } from "next/server";
import { runCycle, } from "@/lib/paper-trader";
import { refreshCache } from "@/lib/data";
import { DEFAULT_PARAMS } from "@/lib/strategy";

export async function GET(req: NextRequest) {
  // Protect the cron endpoint
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const symbols = ["BTC/USDT", "ETH/USDT"];
  const results: Record<string, string> = {};

  for (const sym of symbols) {
    await refreshCache(sym, "1h");
    results[sym] = await runCycle(sym, DEFAULT_PARAMS);
  }

  return NextResponse.json({ ok: true, results });
}
