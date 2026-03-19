import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_PARAMS, type Params } from "@/lib/strategy";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { params, metrics } = await req.json();

    const prompt = `You are an expert quantitative trader specialising in mean-reversion scalping on 1-hour crypto candles.

The current Bollinger Band + RSI strategy produced these results:

Current Parameters:
${JSON.stringify(
  Object.fromEntries(
    Object.entries(params as Params).filter(
      ([k]) => !["positionSizePct", "feePct"].includes(k)
    )
  ),
  null,
  2
)}

Backtest Results:
- Total Return : ${metrics.totalReturn.toFixed(2)}%
- Sharpe Ratio : ${metrics.sharpe.toFixed(2)}
- Max Drawdown : ${metrics.maxDrawdown.toFixed(2)}%
- Win Rate     : ${metrics.winRate.toFixed(2)}%
- Total Trades : ${metrics.nTrades}

Suggest improved parameters. Respond with ONLY a JSON object — no markdown, no explanation.
Use exactly these keys: bbPeriod, bbStd, rsiPeriod, rsiOversold, rsiOverbought, rsiExitLong, rsiExitShort, slMult, tpMult

Valid ranges:
bbPeriod: 10-50 (int), bbStd: 1.0-3.0, rsiPeriod: 7-21 (int),
rsiOversold: 20-40 (int), rsiOverbought: 60-80 (int),
rsiExitLong: 50-70 (int), rsiExitShort: 30-50 (int),
slMult: 0.5-3.0, tpMult: 0.5-5.0`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    let raw = (message.content[0] as { text: string }).text.trim();
    // Strip accidental markdown fences
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
    }

    const suggested = JSON.parse(raw);
    const merged: Params = { ...DEFAULT_PARAMS, ...params, ...suggested };

    return NextResponse.json({ params: merged, suggested });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
