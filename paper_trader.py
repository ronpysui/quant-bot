"""
Paper trading engine.

Runs a background thread that wakes up every `interval_hours` and evaluates
the strategy against the latest live candles.  Trades are simulated with a
fixed $1,000 paper position size and recorded to SQLite.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import pandas as pd

import db
from data_fetcher import fetch_latest
from strategy import add_indicators

_lock = threading.Lock()
_thread: threading.Thread | None = None
_running = False

PAPER_POSITION_USD = 1_000.0   # virtual dollars per trade


def is_running() -> bool:
    return _running


def start(symbol: str, params: dict, interval_hours: float = 4.0) -> None:
    global _thread, _running
    with _lock:
        if _running:
            return
        db.init_db()
        _running = True

    def loop():
        while _running:
            try:
                _cycle(symbol, params)
            except Exception as exc:
                print(f"[paper_trader] error: {exc}")
            time.sleep(interval_hours * 3600)

    _thread = threading.Thread(target=loop, daemon=True, name="paper-trader")
    _thread.start()


def stop() -> None:
    global _running
    _running = False


def run_now(symbol: str, params: dict) -> str:
    """Manually trigger one cycle and return a status message."""
    db.init_db()
    return _cycle(symbol, params)


# ─── Internal cycle ───────────────────────────────────────────────────────────

def _cycle(symbol: str, params: dict) -> str:
    df = fetch_latest(symbol, timeframe="1h", limit=120)
    df = add_indicators(df, params)
    if len(df) < 2:
        return "Not enough data."

    prev = df.iloc[-2]
    last = df.iloc[-1]
    now_str = datetime.now(tz=timezone.utc).isoformat()

    conn = db.get_conn()
    try:
        cur = conn.execute(
            "SELECT direction, entry_price, entry_atr FROM paper_positions WHERE symbol = ?",
            (symbol,),
        )
        position = cur.fetchone()

        if position is None:
            # ── Check for entry ───────────────────────────────────────────
            if prev.close < prev.bb_lower and prev.rsi < params["rsi_oversold"]:
                conn.execute(
                    "INSERT OR REPLACE INTO paper_positions "
                    "(symbol, direction, entry_price, entry_time, entry_atr) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (symbol, "LONG", last.open, now_str, prev.atr),
                )
                conn.commit()
                return f"[{now_str}] Entered LONG @ {last.open:.2f}"

            elif prev.close > prev.bb_upper and prev.rsi > params["rsi_overbought"]:
                conn.execute(
                    "INSERT OR REPLACE INTO paper_positions "
                    "(symbol, direction, entry_price, entry_time, entry_atr) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (symbol, "SHORT", last.open, now_str, prev.atr),
                )
                conn.commit()
                return f"[{now_str}] Entered SHORT @ {last.open:.2f}"

            return f"[{now_str}] No signal — flat."

        else:
            direction, entry_price, entry_atr = position
            sl_m = float(params["sl_mult"])
            tp_m = float(params["tp_mult"])

            if direction == "LONG":
                sl = entry_price - sl_m * entry_atr
                tp = entry_price + tp_m * entry_atr
                exit_price = None

                if last.low <= sl:
                    exit_price = sl
                elif last.high >= tp:
                    exit_price = tp
                elif last.close > last.bb_middle and last.rsi > params["rsi_exit_long"]:
                    exit_price = last.close

                if exit_price:
                    pnl = (exit_price - entry_price) / entry_price * PAPER_POSITION_USD
                    _close_position(conn, symbol, direction, entry_price, exit_price, pnl, now_str)
                    return f"[{now_str}] Closed LONG @ {exit_price:.2f} | PnL: ${pnl:+.2f}"

            else:  # SHORT
                sl = entry_price + sl_m * entry_atr
                tp = entry_price - tp_m * entry_atr
                exit_price = None

                if last.high >= sl:
                    exit_price = sl
                elif last.low <= tp:
                    exit_price = tp
                elif last.close < last.bb_middle and last.rsi < params["rsi_exit_short"]:
                    exit_price = last.close

                if exit_price:
                    pnl = (entry_price - exit_price) / entry_price * PAPER_POSITION_USD
                    _close_position(conn, symbol, direction, entry_price, exit_price, pnl, now_str)
                    return f"[{now_str}] Closed SHORT @ {exit_price:.2f} | PnL: ${pnl:+.2f}"

            return f"[{now_str}] Holding {direction} @ {entry_price:.2f}."
    finally:
        conn.close()


def _close_position(conn, symbol, direction, entry_price, exit_price, pnl, ts):
    conn.execute(
        "INSERT INTO paper_trades "
        "(timestamp, symbol, direction, entry_price, exit_price, pnl, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (ts, symbol, direction, entry_price, exit_price, pnl, "CLOSED"),
    )
    conn.execute("DELETE FROM paper_positions WHERE symbol = ?", (symbol,))
    conn.commit()


# ─── Query helpers ────────────────────────────────────────────────────────────

def get_trades() -> pd.DataFrame:
    db.init_db()
    conn = db.get_conn()
    try:
        return pd.read_sql(
            "SELECT * FROM paper_trades ORDER BY timestamp DESC", conn
        )
    except Exception:
        return pd.DataFrame()
    finally:
        conn.close()


def get_open_position(symbol: str) -> dict | None:
    db.init_db()
    conn = db.get_conn()
    try:
        cur = conn.execute(
            "SELECT * FROM paper_positions WHERE symbol = ?", (symbol,)
        )
        row = cur.fetchone()
        if row:
            cols = [d[0] for d in cur.description]
            return dict(zip(cols, row))
        return None
    finally:
        conn.close()
