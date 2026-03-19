import { NextRequest, NextResponse } from "next/server";
import { getPosition } from "@/lib/paper-trader";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "BTC/USDT";
  const position = await getPosition(symbol);
  return NextResponse.json({ position });
}
