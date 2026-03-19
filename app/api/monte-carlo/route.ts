import { NextRequest, NextResponse } from "next/server";
import { runMonteCarlo } from "@/lib/monte-carlo";

export async function POST(req: NextRequest) {
  try {
    const { tradePnls, nSimulations = 500 } = await req.json();
    if (!tradePnls?.length) {
      return NextResponse.json({ error: "No trade PnLs provided" }, { status: 400 });
    }
    const result = runMonteCarlo(tradePnls, nSimulations);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
