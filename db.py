import sqlite3

DB_PATH = "data.db"


def get_conn() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH, check_same_thread=False)


def init_db() -> None:
    """Create all tables if they don't exist."""
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS paper_trades (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            symbol    TEXT,
            direction TEXT,
            entry_price REAL,
            exit_price  REAL,
            pnl         REAL,
            status      TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS paper_positions (
            symbol      TEXT PRIMARY KEY,
            direction   TEXT,
            entry_price REAL,
            entry_time  TEXT,
            entry_atr   REAL
        )
    """)
    conn.commit()
    conn.close()
