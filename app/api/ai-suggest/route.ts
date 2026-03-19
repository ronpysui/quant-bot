import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_PARAMS, type Params } from "@/lib/strategy";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { params, metrics } = await req.json();

    const prompt = `You are an expert quantitative trader specialising in EMA crossover momentum strategies on 1-hour crypto candles.

The current strategy (EMA Cross + RSI Momentum Filter) produced these results:

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

Strategy logic:
- LONG when fast EMA crosses above slow EMA, price > trend EMA, and rsiLow < RSI < rsiHigh
- SHORT when fast EMA crosses below slow EMA, price < trend EMA, and (100-rsiHigh) < RSI < (100-rsiLow)
- Exit on SL/TP (ATR multiples) or trend reversal (EMA cross back)

Suggest improved parameters to maximise risk-adjusted returns (Sharpe > 1, positive return, controlled drawdown).
Respond with ONLY a JSON object — no markdown, no explanation.

Use exactly these keys: fastEma, slowEma, trendEma, rsiPeriod, rsiLow, rsiHigh, slMult, tpMult

Valid ranges:
fastEma: 5-25 (int), slowEma: 15-50 (int), trendEma: 30-200 (int, step 5),
rsiPeriod: 7-21 (int), rsiLow: 30-60 (int), rsiHigh: 55-85 (int),
slMult: 0.5-3.0, tpMult: 1.0-6.0`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    let raw = (message.content[0] as { text: string }).text.trim();
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
