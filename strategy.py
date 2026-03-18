import pandas as pd
from ta.momentum import RSIIndicator
from ta.volatility import AverageTrueRange, BollingerBands

# ─── Default strategy parameters ────────────────────────────────────────────
DEFAULT_PARAMS: dict = {
    "bb_period": 20,
    "bb_std": 2.0,
    "rsi_period": 14,
    "rsi_oversold": 35,       # long entry threshold
    "rsi_overbought": 65,     # short entry threshold
    "rsi_exit_long": 55,      # exit long when RSI recovers above this
    "rsi_exit_short": 45,     # exit short when RSI drops below this
    "sl_mult": 1.5,           # stop-loss = entry ± sl_mult × ATR
    "tp_mult": 2.0,           # take-profit = entry ± tp_mult × ATR
    "position_size_pct": 0.10,  # 10 % of capital per trade
    "fee_pct": 0.001,           # 0.1 % taker fee per side
}


def add_indicators(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Compute Bollinger Bands, RSI, and ATR and attach them to a copy of *df*.
    Rows where any indicator is NaN are dropped.
    """
    df = df.copy()

    bb = BollingerBands(
        close=df["close"],
        window=int(params["bb_period"]),
        window_dev=float(params["bb_std"]),
        fillna=False,
    )
    df["bb_upper"] = bb.bollinger_hband()
    df["bb_middle"] = bb.bollinger_mavg()
    df["bb_lower"] = bb.bollinger_lband()

    df["rsi"] = RSIIndicator(
        close=df["close"],
        window=int(params["rsi_period"]),
        fillna=False,
    ).rsi()

    df["atr"] = AverageTrueRange(
        high=df["high"],
        low=df["low"],
        close=df["close"],
        window=14,
        fillna=False,
    ).average_true_range()

    return df.dropna()
