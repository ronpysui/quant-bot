import { NextRequest, NextResponse } from "next/server";
import { runCycle, getTrades } from "@/lib/paper-trader";
import { DEFAULT_PARAMS, type Params } from "@/lib/strategy";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "BTC/USDT";
  const trades = await getTrades(symbol);
  return NextResponse.json({ trades });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol: string = body.symbol ?? "BTC/USDT";
    const params: Params = { ...DEFAULT_PARAMS, ...body.params };
    const msg = await runCycle(symbol, params);
    return NextResponse.json({ message: msg });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
