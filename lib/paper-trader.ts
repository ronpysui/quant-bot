import { sql, initSchema } from "./db";
import { fetchOHLCV } from "./data";
import { addIndicators, type Params } from "./strategy";
import { isRTH, isScalpWindow } from "./backtester";

export async function runCycle(symbol: string, params: Params): Promise<string> {
  await initSchema();
  // 7 days = 168 hourly bars, sufficient warmup for BB up to period 32
  const candles = await fetchOHLCV(symbol, "1h", 7);
  const bars = addIndicators(candles, params);
  if (bars.length < 2) return "Not enough data.";

  const prev = bars[bars.length - 2]; // signal bar (previous closed bar)
  const last = bars[bars.length - 1]; // latest closed bar (entry/exit at open)
  const now  = new Date().toISOString();
  const isFutures = params.assetType === "futures";

  // Check existing position
  const { rows } = await sql`
    SELECT * FROM paper_positions WHERE symbol = ${symbol}
  `;
  const pos = rows[0];

  if (!pos) {
    // Window filter
    if (params.filterRTH) {
      const inWindow = params.strategy === "scalp" ? isScalpWindow(prev.ts) : isRTH(prev.ts);
      if (!inWindow) {
        const label = params.strategy === "scalp" ? "Outside 9:30–11:00 window" : "Outside RTH";
        return `${label} — no signal. ${new Date(prev.ts).toUTCString()}`;
      }
    }

    // Scalp: enforce max 2 trades per session (rolling 24h as proxy for current session)
    if (params.strategy === "scalp" && params.filterRTH) {
      const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const { rows: recent } = await sql`
        SELECT COUNT(*) AS cnt FROM paper_trades
        WHERE symbol = ${symbol} AND ts > ${cutoff} AND status = 'CLOSED'
      `;
      const tradesToday = parseInt(String(recent[0]?.cnt ?? "0"));
      if (tradesToday >= 2) {
        return `Session limit reached — ${tradesToday}/2 trades today. No new entries.`;
      }
    }

    let longSignal: boolean;
    let shortSignal: boolean;

    if (params.strategy === "scalp") {
      // VWAP: buy below fair value (order flow discount zone); volume confirmation
      const vwapLongOk  = isNaN(prev.vwap) || prev.close < prev.vwap;
      const vwapShortOk = isNaN(prev.vwap) || prev.close > prev.vwap;
      const volOk = isNaN(prev.volSma) || prev.volSma === 0
        || prev.volume > prev.volSma * params.volFilter;
      const rsiSellZone = 100 - params.rsiMid;
      longSignal  = volOk && vwapLongOk && prev.emaF > prev.emaS
        && prev.close < prev.bbLower && prev.rsi < params.rsiMid;
      shortSignal = volOk && vwapShortOk && params.allowShorts && prev.emaF < prev.emaS
        && prev.close > prev.bbUpper && prev.rsi > rsiSellZone;
    } else {
      const rsiOverbought = 100 - params.rsiOversold;
      longSignal  = prev.close < prev.bbLower && prev.rsi < params.rsiOversold;
      shortSignal = params.allowShorts && prev.close > prev.bbUpper && prev.rsi > rsiOverbought;
    }

    if (longSignal) {
      // TP: scalp = ATR-based fast target above entry; mean rev = BB middle
      const tpTarget = params.strategy === "scalp"
        ? last.open + params.atrTarget * prev.atr
        : prev.bbMiddle;
      await sql`
        INSERT INTO paper_positions
          (symbol, direction, entry_price, entry_ts, entry_atr, entry_bb_middle)
        VALUES
          (${symbol}, 'LONG', ${last.open}, ${now}, ${prev.atr}, ${tpTarget})
        ON CONFLICT (symbol) DO UPDATE
          SET direction=EXCLUDED.direction, entry_price=EXCLUDED.entry_price,
              entry_ts=EXCLUDED.entry_ts, entry_atr=EXCLUDED.entry_atr,
              entry_bb_middle=EXCLUDED.entry_bb_middle
      `;
      const signalTag = params.strategy === "scalp"
        ? `EMA up | BB touch | RSI ${prev.rsi.toFixed(0)}`
        : `BB lower | RSI ${prev.rsi.toFixed(0)}`;
      return `Entered LONG @ ${last.open.toFixed(2)} — ${signalTag} | target ${tpTarget.toFixed(2)}`;
    }

    if (shortSignal) {
      const tpTarget = params.strategy === "scalp"
        ? last.open - params.atrTarget * prev.atr
        : prev.bbMiddle;
      await sql`
        INSERT INTO paper_positions
          (symbol, direction, entry_price, entry_ts, entry_atr, entry_bb_middle)
        VALUES
          (${symbol}, 'SHORT', ${last.open}, ${now}, ${prev.atr}, ${tpTarget})
        ON CONFLICT (symbol) DO UPDATE
          SET direction=EXCLUDED.direction, entry_price=EXCLUDED.entry_price,
              entry_ts=EXCLUDED.entry_ts, entry_atr=EXCLUDED.entry_atr,
              entry_bb_middle=EXCLUDED.entry_bb_middle
      `;
      const signalTag = params.strategy === "scalp"
        ? `EMA down | BB touch | RSI ${prev.rsi.toFixed(0)}`
        : `BB upper | RSI ${prev.rsi.toFixed(0)}`;
      return `Entered SHORT @ ${last.open.toFixed(2)} — ${signalTag} | target ${tpTarget.toFixed(2)}`;
    }

    const noSigDetail = params.strategy === "scalp"
      ? `EMA[${prev.emaF.toFixed(0)}/${prev.emaS.toFixed(0)}] RSI ${prev.rsi.toFixed(0)} VWAP ${prev.vwap.toFixed(0)} Vol ${prev.volume.toFixed(0)} (sma ${prev.volSma.toFixed(0)}) BB[${prev.bbLower.toFixed(0)}–${prev.bbUpper.toFixed(0)}]`
      : `RSI ${prev.rsi.toFixed(0)} BB[${prev.bbLower.toFixed(0)}–${prev.bbUpper.toFixed(0)}]`;
    return `No signal — flat. ${noSigDetail}, close ${prev.close.toFixed(0)}`;
  }

  const { direction, entry_price: ep, entry_atr: ea, entry_bb_middle: target } = pos;
  const isLong = direction === "LONG";

  const sl = isLong
    ? ep - params.slMult * ea
    : ep + params.slMult * ea;

  const revTarget = target ?? last.bbMiddle;

  let exitPrice: number | null = null;
  let exitReason = "";

  if (isLong) {
    if (last.low  <= sl)             { exitPrice = sl;        exitReason = "SL"; }
    else if (last.high >= revTarget) { exitPrice = revTarget; exitReason = "mean reversion"; }
  } else {
    if (last.high >= sl)             { exitPrice = sl;        exitReason = "SL"; }
    else if (last.low  <= revTarget) { exitPrice = revTarget; exitReason = "mean reversion"; }
  }

  if (exitPrice === null)
    return `Holding ${direction} @ ${ep.toFixed(2)} | SL ${sl.toFixed(2)} | target ${revTarget.toFixed(2)} | current ${last.close.toFixed(2)}`;

  // PnL: futures uses pts × multiplier × contracts; crypto uses % × notional
  let pnl: number;
  if (isFutures) {
    const pts = isLong ? exitPrice - ep : ep - exitPrice;
    pnl = pts * params.contractMultiplier * params.numContracts
        - params.feeDollar * params.numContracts * 2; // entry + exit fee
  } else {
    const positionNotional = params.initialCapital * params.positionSizePct;
    pnl = isLong
      ? ((exitPrice - ep) / ep) * positionNotional
      : ((ep - exitPrice) / ep) * positionNotional;
  }

  await sql`
    INSERT INTO paper_trades (ts, symbol, direction, entry_price, exit_price, pnl, status)
    VALUES (${now}, ${symbol}, ${direction}, ${ep}, ${exitPrice}, ${pnl}, 'CLOSED')
  `;
  await sql`DELETE FROM paper_positions WHERE symbol = ${symbol}`;

  return `Closed ${direction} @ ${exitPrice.toFixed(2)} (${exitReason}) | PnL: $${pnl.toFixed(2)}`;
}

export async function getTrades(symbol?: string) {
  await initSchema();
  if (symbol) {
    const { rows } = await sql`
      SELECT * FROM paper_trades WHERE symbol = ${symbol} ORDER BY ts DESC
    `;
    return rows;
  }
  const { rows } = await sql`SELECT * FROM paper_trades ORDER BY ts DESC`;
  return rows;
}

export async function getPosition(symbol: string) {
  await initSchema();
  const { rows } = await sql`
    SELECT * FROM paper_positions WHERE symbol = ${symbol}
  `;
  return rows[0] ?? null;
}
