from __future__ import annotations

import numpy as np
import pandas as pd

from strategy import add_indicators

MONTH_NAMES = {
    1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr",
    5: "May", 6: "Jun", 7: "Jul", 8: "Aug",
    9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec",
}


def run_backtest(
    df: pd.DataFrame,
    params: dict,
    initial_capital: float = 10_000.0,
) -> dict:
    """
    Bar-by-bar backtest of the BB+RSI mean-reversion scalp strategy.

    Entry signals are evaluated on the *previous* closed bar; orders are
    filled at the *current* bar's open price (realistic simulation).
    Stop-loss and take-profit are checked against the current bar's High/Low.

    Returns
    -------
    dict with keys: equity_curve, trades, metrics
    """
    df = add_indicators(df, params)

    capital = float(initial_capital)
    position = 0          # 0 = flat | 1 = long | -1 = short
    entry_price = 0.0
    entry_atr = 0.0
    position_value = 0.0
    entry_time = None

    equity_curve: list[float] = [capital]
    equity_dates: list = [df.index[0]]
    trades: list[dict] = []

    fee = float(params["fee_pct"])
    pos_pct = float(params["position_size_pct"])
    sl_m = float(params["sl_mult"])
    tp_m = float(params["tp_mult"])

    for i in range(1, len(df)):
        prev = df.iloc[i - 1]
        row = df.iloc[i]

        # ── Evaluate mark-to-market equity ───────────────────────────────
        if position == 1:
            unrealized = (row.close - entry_price) / entry_price * position_value
        elif position == -1:
            unrealized = (entry_price - row.close) / entry_price * position_value
        else:
            unrealized = 0.0

        # ── Flat: look for entry ─────────────────────────────────────────
        if position == 0:
            long_signal = (
                prev.close < prev.bb_lower and prev.rsi < params["rsi_oversold"]
            )
            short_signal = (
                prev.close > prev.bb_upper and prev.rsi > params["rsi_overbought"]
            )

            if long_signal:
                position = 1
                entry_price = row.open
                entry_atr = prev.atr
                position_value = capital * pos_pct
                entry_time = row.name
                capital -= position_value * fee  # entry fee

            elif short_signal:
                position = -1
                entry_price = row.open
                entry_atr = prev.atr
                position_value = capital * pos_pct
                entry_time = row.name
                capital -= position_value * fee

        # ── Long: check exit ─────────────────────────────────────────────
        elif position == 1:
            sl = entry_price - sl_m * entry_atr
            tp = entry_price + tp_m * entry_atr
            exit_price = None

            if row.low <= sl:
                exit_price = sl
            elif row.high >= tp:
                exit_price = tp
            elif row.close > row.bb_middle and row.rsi > params["rsi_exit_long"]:
                exit_price = row.close

            if exit_price is not None:
                pnl = (exit_price - entry_price) / entry_price * position_value
                capital += pnl - position_value * fee
                trades.append(_trade_record(
                    entry_time, row.name, "long",
                    entry_price, exit_price, pnl,
                    (exit_price - entry_price) / entry_price * 100,
                ))
                position = 0
                unrealized = 0.0

        # ── Short: check exit ────────────────────────────────────────────
        elif position == -1:
            sl = entry_price + sl_m * entry_atr
            tp = entry_price - tp_m * entry_atr
            exit_price = None

            if row.high >= sl:
                exit_price = sl
            elif row.low <= tp:
                exit_price = tp
            elif row.close < row.bb_middle and row.rsi < params["rsi_exit_short"]:
                exit_price = row.close

            if exit_price is not None:
                pnl = (entry_price - exit_price) / entry_price * position_value
                capital += pnl - position_value * fee
                trades.append(_trade_record(
                    entry_time, row.name, "short",
                    entry_price, exit_price, pnl,
                    (entry_price - exit_price) / entry_price * 100,
                ))
                position = 0
                unrealized = 0.0

        equity_curve.append(capital + unrealized)
        equity_dates.append(row.name)

    equity = pd.Series(equity_curve, index=equity_dates)
    trades_df = pd.DataFrame(trades) if trades else pd.DataFrame(
        columns=["entry_time", "exit_time", "direction",
                 "entry_price", "exit_price", "pnl", "return_pct"]
    )

    return {
        "equity_curve": equity,
        "trades": trades_df,
        "metrics": _calc_metrics(equity, trades_df, initial_capital),
    }


def _trade_record(entry_time, exit_time, direction,
                  entry_price, exit_price, pnl, return_pct) -> dict:
    return {
        "entry_time": entry_time,
        "exit_time": exit_time,
        "direction": direction,
        "entry_price": entry_price,
        "exit_price": exit_price,
        "pnl": pnl,
        "return_pct": return_pct,
    }


def _calc_metrics(
    equity: pd.Series,
    trades_df: pd.DataFrame,
    initial_capital: float,
) -> dict:
    total_return = (equity.iloc[-1] - initial_capital) / initial_capital * 100

    rolling_max = equity.cummax()
    drawdown = (equity - rolling_max) / rolling_max * 100
    max_drawdown = float(drawdown.min())

    hourly_returns = equity.pct_change().dropna()
    sharpe = (
        hourly_returns.mean() / hourly_returns.std() * np.sqrt(8760)
        if hourly_returns.std() > 0
        else 0.0
    )

    if not trades_df.empty:
        win_mask = trades_df["pnl"] > 0
        win_rate = win_mask.mean() * 100
        avg_win = trades_df.loc[win_mask, "pnl"].mean() if win_mask.any() else 0.0
        avg_loss = trades_df.loc[~win_mask, "pnl"].mean() if (~win_mask).any() else 0.0
        n_trades = len(trades_df)
        durations = pd.to_datetime(trades_df["exit_time"]) - pd.to_datetime(trades_df["entry_time"])
        avg_duration_hrs = durations.mean().total_seconds() / 3600
    else:
        win_rate = avg_win = avg_loss = avg_duration_hrs = 0.0
        n_trades = 0

    return {
        "total_return": float(total_return),
        "max_drawdown": float(max_drawdown),
        "sharpe": float(sharpe),
        "win_rate": float(win_rate),
        "n_trades": n_trades,
        "avg_win": float(avg_win),
        "avg_loss": float(avg_loss),
        "avg_duration_hrs": float(avg_duration_hrs),
        "final_capital": float(equity.iloc[-1]),
    }


def monthly_pnl_table(equity: pd.Series) -> pd.DataFrame:
    """
    Returns a pivot table: rows = year, columns = month (Jan–Dec) + Annual.
    Each cell is the month's return in percent.
    """
    monthly_end = equity.resample("ME").last()
    monthly_ret = monthly_end.pct_change().dropna() * 100

    rows = pd.DataFrame({
        "year": monthly_ret.index.year,
        "month": monthly_ret.index.month,
        "ret": monthly_ret.values,
    })

    rows["month_name"] = rows["month"].map(MONTH_NAMES)
    pivot = rows.pivot(index="year", columns="month_name", values="ret")

    ordered_cols = [m for m in MONTH_NAMES.values() if m in pivot.columns]
    pivot = pivot[ordered_cols]

    # Compound annual return
    annual = (
        rows.groupby("year")["ret"]
        .apply(lambda x: (np.prod(1 + x / 100) - 1) * 100)
    )
    pivot["Annual"] = annual

    return pivot.round(2)
