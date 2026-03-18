from __future__ import annotations

import json
import os

import anthropic
import streamlit as st


def _get_api_key() -> str | None:
    try:
        key = st.secrets.get("ANTHROPIC_API_KEY")
        if key:
            return key
    except Exception:
        pass
    return os.environ.get("ANTHROPIC_API_KEY")


def get_ai_suggestion(params: dict, metrics: dict) -> dict | None:
    """
    Send the current strategy params + backtest metrics to Claude and ask
    for improved parameter suggestions.  Returns a merged params dict on
    success, or None on failure.
    """
    api_key = _get_api_key()
    if not api_key:
        st.error("ANTHROPIC_API_KEY not found. Add it to `.streamlit/secrets.toml`.")
        return None

    client = anthropic.Anthropic(api_key=api_key)

    prompt = f"""You are an expert quantitative trader specialising in mean-reversion scalping on 1-hour crypto candles.

The current Bollinger Band + RSI strategy produced the following results:

**Current Parameters:**
{json.dumps({k: v for k, v in params.items() if k not in ('position_size_pct', 'fee_pct')}, indent=2)}

**Backtest Results:**
- Total Return : {metrics['total_return']:.2f}%
- Sharpe Ratio : {metrics['sharpe']:.2f}
- Max Drawdown : {metrics['max_drawdown']:.2f}%
- Win Rate     : {metrics['win_rate']:.2f}%
- Total Trades : {metrics['n_trades']}

Suggest new parameter values that are likely to improve profitability while limiting drawdown.

Respond with **only** a JSON object — no markdown fences, no explanation. Use exactly these keys:
bb_period, bb_std, rsi_period, rsi_oversold, rsi_overbought, rsi_exit_long, rsi_exit_short, sl_mult, tp_mult

Valid ranges:
- bb_period: 10–50 (integer)
- bb_std: 1.0–3.0
- rsi_period: 7–21 (integer)
- rsi_oversold: 20–40 (integer)
- rsi_overbought: 60–80 (integer)
- rsi_exit_long: 50–70 (integer)
- rsi_exit_short: 30–50 (integer)
- sl_mult: 0.5–3.0
- tp_mult: 0.5–5.0"""

    try:
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        # Strip accidental markdown code fences
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        new_p = json.loads(raw)
    except Exception as exc:
        st.error(f"AI suggestion failed: {exc}")
        return None

    # Merge with fixed params (fees, position size)
    merged = {
        **params,
        **new_p,
        "position_size_pct": params["position_size_pct"],
        "fee_pct": params["fee_pct"],
    }
    return merged
