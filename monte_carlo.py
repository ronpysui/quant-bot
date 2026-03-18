from __future__ import annotations

import numpy as np
import plotly.graph_objects as go


def run_monte_carlo(
    trade_pnls: np.ndarray,
    initial_capital: float = 10_000.0,
    n_simulations: int = 500,
) -> dict | None:
    """
    Bootstrap Monte Carlo simulation.

    For each simulation we resample (with replacement) from *trade_pnls*
    (dollar P&L values) and build a cumulative equity path starting at
    *initial_capital*.  This answers the question: "given this distribution
    of trade outcomes, what range of final account sizes is plausible?"

    Returns
    -------
    dict with keys:
        paths          – (n_simulations × n_trades+1) float array
        median         – median final equity across simulations
        p5             – 5th-percentile final equity
        p95            – 95th-percentile final equity
        pct_profitable – % of simulations ending above initial_capital
        median_return  – median return as a percentage
    """
    if len(trade_pnls) < 2:
        return None

    n = len(trade_pnls)
    paths = np.empty((n_simulations, n + 1), dtype=float)
    paths[:, 0] = initial_capital

    rng = np.random.default_rng()
    for i in range(n_simulations):
        sample = rng.choice(trade_pnls, size=n, replace=True)
        paths[i, 1:] = initial_capital + np.cumsum(sample)
        # Floor at zero — you can't lose more than you have
        paths[i] = np.maximum(paths[i], 0.0)

    final = paths[:, -1]
    return {
        "paths": paths,
        "median": float(np.median(final)),
        "p5": float(np.percentile(final, 5)),
        "p95": float(np.percentile(final, 95)),
        "pct_profitable": float((final > initial_capital).mean() * 100),
        "median_return": float((np.median(final) - initial_capital) / initial_capital * 100),
    }


def build_mc_figure(result: dict, n_simulations: int) -> go.Figure:
    """Return a Plotly figure showing all Monte Carlo equity paths."""
    paths = result["paths"]
    x = list(range(paths.shape[1]))

    fig = go.Figure()

    # Individual paths — very transparent
    for i in range(len(paths)):
        fig.add_trace(go.Scatter(
            x=x, y=paths[i],
            mode="lines",
            line=dict(color="rgba(99, 149, 237, 0.04)", width=1),
            showlegend=False,
            hoverinfo="skip",
        ))

    # Percentile bands
    p5 = np.percentile(paths, 5, axis=0)
    p95 = np.percentile(paths, 95, axis=0)
    median = np.median(paths, axis=0)

    fig.add_trace(go.Scatter(
        x=x, y=p95,
        mode="lines",
        name="95th %ile",
        line=dict(color="#2ecc71", width=2, dash="dash"),
    ))
    fig.add_trace(go.Scatter(
        x=x, y=p5,
        mode="lines",
        name="5th %ile",
        line=dict(color="#e74c3c", width=2, dash="dash"),
        fill="tonexty",
        fillcolor="rgba(231,76,60,0.06)",
    ))
    fig.add_trace(go.Scatter(
        x=x, y=median,
        mode="lines",
        name="Median",
        line=dict(color="#f1c40f", width=3),
    ))

    fig.update_layout(
        title=f"Monte Carlo Simulation — {n_simulations} equity paths",
        xaxis_title="Trade #",
        yaxis_title="Portfolio Value ($)",
        height=520,
        template="plotly_dark",
        legend=dict(orientation="h", y=1.05),
    )
    return fig
