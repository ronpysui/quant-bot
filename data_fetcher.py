import time
from datetime import datetime, timedelta, timezone

import ccxt
import pandas as pd
import streamlit as st


EXCHANGE = ccxt.binance({"enableRateLimit": True})


@st.cache_data(ttl=3600, show_spinner=False)
def fetch_ohlcv(symbol: str, timeframe: str = "1h", days: int = 365 * 3) -> pd.DataFrame:
    """
    Fetch OHLCV candles from Binance (public — no API key required).
    Results are cached in Streamlit for 1 hour to avoid redundant calls.
    Paginates automatically to retrieve the full requested history.
    """
    since_ms = int(
        (datetime.now(tz=timezone.utc) - timedelta(days=days)).timestamp() * 1000
    )

    all_candles: list[list] = []

    while True:
        batch = EXCHANGE.fetch_ohlcv(symbol, timeframe, since=since_ms, limit=1000)
        if not batch:
            break
        all_candles.extend(batch)
        last_ts = batch[-1][0]
        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        if last_ts >= now_ms - EXCHANGE.parse_timeframe(timeframe) * 1000:
            break
        since_ms = last_ts + 1
        time.sleep(EXCHANGE.rateLimit / 1000)

    df = pd.DataFrame(
        all_candles, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df = df.set_index("timestamp")
    df = df[~df.index.duplicated(keep="last")]
    df = df.sort_index()
    return df


def fetch_latest(symbol: str, timeframe: str = "1h", limit: int = 100) -> pd.DataFrame:
    """Fetch the most recent `limit` candles without caching (used by paper trader)."""
    candles = EXCHANGE.fetch_ohlcv(symbol, timeframe, limit=limit)
    df = pd.DataFrame(
        candles, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df = df.set_index("timestamp").sort_index()
    return df
