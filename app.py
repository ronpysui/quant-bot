"""
Quant Scalp Bot — Streamlit Dashboard
======================================
Tabs:
  1. Backtest    – run BB+RSI strategy on historical data
  2. Monte Carlo – bootstrap equity-path simulation
  3. Paper Trade – live paper trading with scheduler
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import paper_trader
from ai_advisor import get_ai_suggestion
from backtester import monthly_pnl_table, run_backtest
from data_fetcher import fetch_ohlcv
from monte_carlo import build_mc_figure, run_monte_carlo
from strategy import DEFAULT_PARAMS

# ─── Page config ─────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="Quant Scalp Bot",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─── Sidebar ─────────────────────────────────────────────────────────────────

with st.sidebar:
    st.markdown("## 📈 Quant Scalp Bot")
    st.markdown("---")

    st.markdown("### Market")
    symbol = st.selectbox(
        "Trading Pair",
        ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"],
    )
    lookback_years = st.slider("Backtest History (years)", 1, 3, 3)

    st.markdown("---")
    st.markdown("### Strategy Parameters")

    # Check if AI suggested params are loaded
    ai_active = "ai_params" in st.session_state
    if ai_active:
        st.info("🤖 Using AI-suggested parameters")
        if st.button("↩ Revert to Manual"):
            del st.session_state["ai_params"]
            st.rerun()

    # Pull defaults from AI params or DEFAULT_PARAMS
    _p = st.session_state.get("ai_params", DEFAULT_PARAMS)

    bb_period = st.slider("BB Period", 10, 50, int(_p["bb_period"]))
    bb_std = st.slider("BB Std Dev", 1.0, 3.0, float(_p["bb_std"]), 0.1)
    rsi_period = st.slider("RSI Period", 7, 21, int(_p["rsi_period"]))
    rsi_oversold = st.slider("RSI Oversold (long entry)", 20, 40, int(_p["rsi_oversold"]))
    rsi_overbought = st.slider("RSI Overbought (short entry)", 60, 80, int(_p["rsi_overbought"]))
    sl_mult = st.slider("Stop Loss (× ATR)", 0.5, 3.0, float(_p["sl_mult"]), 0.1)
    tp_mult = st.slider("Take Profit (× ATR)", 0.5, 5.0, float(_p["tp_mult"]), 0.1)

    params: dict = {
        "bb_period": bb_period,
        "bb_std": bb_std,
        "rsi_period": rsi_period,
        "rsi_oversold": rsi_oversold,
        "rsi_overbought": rsi_overbought,
        "rsi_exit_long": min(rsi_overbought - 10, 65),
        "rsi_exit_short": max(rsi_oversold + 10, 35),
        "sl_mult": sl_mult,
        "tp_mult": tp_mult,
        "position_size_pct": 0.10,
        "fee_pct": 0.001,
    }

    st.markdown("---")
    st.caption("Data: Binance public API · No API key required")


# ─── Tabs ─────────────────────────────────────────────────────────────────────

tab_bt, tab_mc, tab_pt = st.tabs(["📊 Backtest", "🎲 Monte Carlo", "🤖 Paper Trading"])


# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — BACKTEST
# ══════════════════════════════════════════════════════════════════════════════

with tab_bt:
    st.markdown("### Bollinger Band + RSI Mean-Reversion Scalper")
    st.markdown(
        "Entries trigger when price breaches the outer BB **and** RSI confirms "
        "oversold / overbought conditions. Exits via middle-BB reversion, "
        "ATR-based stop-loss, or ATR-based take-profit."
    )

    col_btn, col_info = st.columns([1, 4])
    with col_btn:
        run_btn = st.button("▶ Run Backtest", type="primary", use_container_width=True)

    if run_btn:
        with st.spinner(f"Fetching {symbol} ({lookback_years}y of 1h candles)…"):
            try:
                raw_df = fetch_ohlcv(symbol, "1h", days=int(lookback_years * 365))
            except Exception as exc:
                st.error(f"Data fetch failed: {exc}")
                st.stop()

        with st.spinner("Running backtest…"):
            result = run_backtest(raw_df, params)
            st.session_state["bt_result"] = result
            st.session_state["bt_symbol"] = symbol

    if "bt_result" in st.session_state:
        result = st.session_state["bt_result"]
        m = result["metrics"]
        equity = result["equity_curve"]
        trades = result["trades"]

        # ── Metric cards ──────────────────────────────────────────────────
        c1, c2, c3, c4, c5 = st.columns(5)
        ret_color = "normal" if m["total_return"] >= 0 else "inverse"
        c1.metric("Total Return", f"{m['total_return']:.1f}%",
                  delta=f"{m['total_return']:.1f}%", delta_color=ret_color)
        c2.metric("Sharpe Ratio", f"{m['sharpe']:.2f}")
        c3.metric("Max Drawdown", f"{m['max_drawdown']:.1f}%",
                  delta=f"{m['max_drawdown']:.1f}%", delta_color="inverse")
        c4.metric("Win Rate", f"{m['win_rate']:.1f}%")
        c5.metric("Total Trades", m["n_trades"])

        st.markdown("---")

        # ── Equity curve ──────────────────────────────────────────────────
        fig_eq = go.Figure()
        fig_eq.add_trace(go.Scatter(
            x=equity.index, y=equity.values,
            mode="lines",
            name="Portfolio Value",
            line=dict(color="#4f8df5", width=2),
            fill="tozeroy",
            fillcolor="rgba(79,141,245,0.1)",
        ))
        fig_eq.add_hline(y=10_000, line_dash="dot",
                         line_color="gray", annotation_text="Start ($10k)")
        fig_eq.update_layout(
            title="Equity Curve",
            xaxis_title="Date",
            yaxis_title="Portfolio Value ($)",
            height=400,
            template="plotly_dark",
            margin=dict(l=0, r=0, t=40, b=0),
        )
        st.plotly_chart(fig_eq, use_container_width=True)

        # ── Monthly PnL heatmap ───────────────────────────────────────────
        if not trades.empty:
            st.markdown("#### Monthly PnL (%)")
            monthly = monthly_pnl_table(equity)

            def color_cell(val):
                if pd.isna(val):
                    return ""
                if val > 0:
                    intensity = min(int(abs(val) / 20 * 180), 180)
                    return f"background-color: rgba(46,204,113,{intensity/255:.2f}); color: white"
                else:
                    intensity = min(int(abs(val) / 20 * 180), 180)
                    return f"background-color: rgba(231,76,60,{intensity/255:.2f}); color: white"

            styled = monthly.style.applymap(color_cell).format("{:.1f}%", na_rep="—")
            st.dataframe(styled, use_container_width=True)

        # ── Extra metrics row ─────────────────────────────────────────────
        if not trades.empty:
            st.markdown("---")
            col_a, col_b, col_c, col_d = st.columns(4)
            col_a.metric("Final Capital", f"${m['final_capital']:,.0f}")
            col_b.metric("Avg Win", f"${m['avg_win']:.2f}")
            col_c.metric("Avg Loss", f"${m['avg_loss']:.2f}")
            col_d.metric("Avg Trade Duration", f"{m['avg_duration_hrs']:.1f}h")

        # ── Trade log ─────────────────────────────────────────────────────
        if not trades.empty:
            with st.expander("📋 Trade Log"):
                display_trades = trades.copy()
                display_trades["pnl"] = display_trades["pnl"].map("${:+.2f}".format)
                display_trades["return_pct"] = display_trades["return_pct"].map("{:+.2f}%".format)
                display_trades["entry_price"] = display_trades["entry_price"].map("{:.4f}".format)
                display_trades["exit_price"] = display_trades["exit_price"].map("{:.4f}".format)
                st.dataframe(display_trades, use_container_width=True, height=300)

        # ── AI Adjustment ─────────────────────────────────────────────────
        st.markdown("---")
        underperforming = m["total_return"] < 0 or m["sharpe"] < 0.5
        if underperforming:
            st.warning(
                f"⚠️ Strategy is underperforming "
                f"(Return: {m['total_return']:.1f}%, Sharpe: {m['sharpe']:.2f}). "
                "Try AI-assisted tuning."
            )
        else:
            st.success(
                f"✅ Strategy looks solid "
                f"(Return: {m['total_return']:.1f}%, Sharpe: {m['sharpe']:.2f})."
            )
            st.caption("You can still run AI tuning below to try for better parameters.")

        if st.button("🤖 Adjust Strategy with AI", type="secondary"):
            with st.spinner("Consulting Claude…"):
                new_params = get_ai_suggestion(params, m)
            if new_params:
                st.session_state["ai_params"] = new_params
                st.success("AI parameters loaded! Check the sidebar, then re-run the backtest.")
                st.json({k: v for k, v in new_params.items()
                         if k not in ("position_size_pct", "fee_pct")})

    else:
        st.info("Configure parameters in the sidebar, then click **▶ Run Backtest**.")


# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — MONTE CARLO
# ══════════════════════════════════════════════════════════════════════════════

with tab_mc:
    st.markdown("### Monte Carlo Simulation")
    st.markdown(
        "Bootstrap resample trade P&L values to generate **hundreds of plausible "
        "equity paths** — showing the full range of outcomes the strategy "
        "could produce by chance."
    )

    if "bt_result" not in st.session_state:
        st.info("▶ Run a backtest first (Backtest tab) to generate trades.")
    else:
        result = st.session_state["bt_result"]
        trades = result["trades"]

        if trades.empty:
            st.warning("The backtest produced no trades — nothing to simulate.")
        else:
            col_n, col_btn2 = st.columns([3, 1])
            with col_n:
                n_sims = st.slider("Number of Simulations", 100, 1000, 500, 50)
            with col_btn2:
                mc_btn = st.button("▶ Run Simulation", type="primary", use_container_width=True)

            if mc_btn or "mc_result" in st.session_state:
                if mc_btn:
                    with st.spinner(f"Running {n_sims} Monte Carlo paths…"):
                        mc = run_monte_carlo(
                            trade_pnls=trades["pnl"].values,
                            n_simulations=n_sims,
                        )
                        st.session_state["mc_result"] = mc
                        st.session_state["mc_n"] = n_sims

                mc = st.session_state["mc_result"]
                n_used = st.session_state.get("mc_n", n_sims)

                if mc is None:
                    st.error("Not enough trades to run Monte Carlo (need ≥ 2).")
                else:
                    # ── Chart ─────────────────────────────────────────────
                    fig_mc = build_mc_figure(mc, n_used)
                    st.plotly_chart(fig_mc, use_container_width=True)

                    # ── Summary cards ──────────────────────────────────────
                    c1, c2, c3, c4 = st.columns(4)
                    c1.metric("Median Return", f"{mc['median_return']:.1f}%")
                    c2.metric("5th Percentile", f"${mc['p5']:,.0f}")
                    c3.metric("Median Final", f"${mc['median']:,.0f}")
                    c4.metric("95th Percentile", f"${mc['p95']:,.0f}")

                    st.metric(
                        "% of Simulations Profitable",
                        f"{mc['pct_profitable']:.1f}%",
                    )

                    st.caption(
                        "Each path resamples the actual trade outcomes in random order. "
                        "The band between the 5th and 95th percentile is the "
                        "statistically likely range of equity trajectories."
                    )


# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — PAPER TRADING
# ══════════════════════════════════════════════════════════════════════════════

with tab_pt:
    st.markdown("### Paper Trading")
    st.markdown(
        "The bot checks for signals every **4 hours** using live Binance data. "
        "All trades are simulated — no real money is at risk. "
        f"Paper position size: **$1,000 per trade**."
    )

    # ── Controls ──────────────────────────────────────────────────────────────
    col_start, col_stop, col_now, _ = st.columns([1, 1, 1, 3])

    with col_start:
        if st.button("▶ Start Scheduler", type="primary", use_container_width=True):
            paper_trader.start(symbol, params, interval_hours=4)
            st.success("Scheduler started — runs every 4 hours.")

    with col_stop:
        if st.button("⏹ Stop Scheduler", use_container_width=True):
            paper_trader.stop()
            st.info("Scheduler stopped.")

    with col_now:
        if st.button("⚡ Run Now", use_container_width=True):
            with st.spinner("Evaluating signal…"):
                msg = paper_trader.run_now(symbol, params)
            st.info(msg)

    status = "🟢 Running" if paper_trader.is_running() else "🔴 Stopped"
    st.markdown(f"**Scheduler status:** {status}")
    st.markdown("---")

    # ── Open position ─────────────────────────────────────────────────────────
    st.markdown("#### Open Position")
    pos = paper_trader.get_open_position(symbol)
    if pos:
        pc1, pc2, pc3, pc4 = st.columns(4)
        pc1.metric("Symbol", pos["symbol"])
        pc2.metric("Direction", pos["direction"])
        pc3.metric("Entry Price", f"${pos['entry_price']:,.4f}")
        pc4.metric("Entry Time", str(pos["entry_time"])[:19])
    else:
        st.info("No open position.")

    # ── Trade history ─────────────────────────────────────────────────────────
    st.markdown("#### Trade History")
    pt_trades = paper_trader.get_trades()

    if pt_trades.empty:
        st.info("No paper trades yet. Start the scheduler or click ⚡ Run Now.")
    else:
        total_pnl = pt_trades["pnl"].sum()
        n_wins = (pt_trades["pnl"] > 0).sum()
        n_total = len(pt_trades)

        tc1, tc2, tc3 = st.columns(3)
        tc1.metric("Total Paper PnL", f"${total_pnl:+,.2f}",
                   delta=f"${total_pnl:+,.2f}",
                   delta_color="normal" if total_pnl >= 0 else "inverse")
        tc2.metric("Trades", n_total)
        tc3.metric("Win Rate", f"{n_wins/n_total*100:.1f}%" if n_total else "—")

        # Paper equity curve
        if len(pt_trades) > 1:
            pt_trades_sorted = pt_trades.sort_values("timestamp")
            cumulative = pt_trades_sorted["pnl"].cumsum() + 1_000  # start from $1k base
            fig_pt = go.Figure(go.Scatter(
                x=pt_trades_sorted["timestamp"],
                y=cumulative,
                mode="lines+markers",
                name="Cumulative PnL",
                line=dict(color="#2ecc71" if total_pnl >= 0 else "#e74c3c", width=2),
            ))
            fig_pt.update_layout(
                title="Paper Trading — Cumulative PnL",
                xaxis_title="Date",
                yaxis_title="Value ($)",
                height=300,
                template="plotly_dark",
                margin=dict(l=0, r=0, t=40, b=0),
            )
            st.plotly_chart(fig_pt, use_container_width=True)

        # Trade table
        display_pt = pt_trades.copy()
        display_pt["pnl"] = display_pt["pnl"].map("${:+.2f}".format)
        st.dataframe(display_pt, use_container_width=True, height=300)

    st.markdown("---")
    st.caption(
        "Data source: Binance public OHLCV API · Exchange: simulated paper account · "
        "No real orders are placed."
    )
