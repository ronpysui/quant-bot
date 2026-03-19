import { NextRequest, NextResponse } from "next/server";
import { fetchOHLCV } from "@/lib/data";
import { runBacktest, monthlyPnlTable } from "@/lib/backtester";
import { DEFAULT_PARAMS, type Params } from "@/lib/strategy";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol: string = body.symbol ?? "BTC/USDT";
    const days: number = body.days ?? 365;
    const params: Params = { ...DEFAULT_PARAMS, ...body.params };

    const candles = await fetchOHLCV(symbol, "1h", days);
    if (candles.length < 100) {
      return NextResponse.json({ error: "Not enough data" }, { status: 400 });
    }

    const result = runBacktest(candles, params);
    const monthly = monthlyPnlTable(result.equityCurve);

    return NextResponse.json({
      equityCurve: result.equityCurve,
      trades: result.trades,
      metrics: result.metrics,
      monthly,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
