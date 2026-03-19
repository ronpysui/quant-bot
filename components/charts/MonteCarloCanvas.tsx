"use client";

import { useEffect, useRef } from "react";

interface Props {
  paths: number[][];
  p5: number;
  p95: number;
}

export default function MonteCarloCanvas({ paths, p5, p95 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !paths.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    // Find min/max across all paths
    let minV = Infinity, maxV = -Infinity;
    for (const path of paths) {
      for (const v of path) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    const pad = { l: 60, r: 16, t: 16, b: 32 };
    const chartW = W - pad.l - pad.r;
    const chartH = H - pad.t - pad.b;
    const nPoints = paths[0].length;

    const xScale = (i: number) => pad.l + (i / (nPoints - 1)) * chartW;
    const yScale = (v: number) =>
      pad.t + chartH - ((v - minV) / (maxV - minV || 1)) * chartH;

    // Background
    ctx.fillStyle = "#0a0b0d";
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "#1e2433";
    ctx.lineWidth = 0.5;
    for (let g = 0; g <= 4; g++) {
      const y = pad.t + (g / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
      const val = maxV - (g / 4) * (maxV - minV);
      ctx.fillStyle = "#64748b";
      ctx.font = "10px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`$${Math.round(val).toLocaleString()}`, pad.l - 4, y + 3);
    }

    // All paths — semi-transparent teal
    ctx.lineWidth = 0.8;
    for (const path of paths) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 212, 170, 0.04)";
      for (let i = 0; i < path.length; i++) {
        const x = xScale(i);
        const y = yScale(path[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Median path
    const median = paths[0].map((_, i) => {
      const vals = paths.map((p) => p[i]).sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)];
    });
    ctx.beginPath();
    ctx.strokeStyle = "#f1c40f";
    ctx.lineWidth = 2.5;
    for (let i = 0; i < median.length; i++) {
      const x = xScale(i);
      const y = yScale(median[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 95th percentile line
    const p95Path = paths[0].map((_, i) => {
      const vals = paths.map((p) => p[i]).sort((a, b) => a - b);
      return vals[Math.floor(vals.length * 0.95)];
    });
    ctx.beginPath();
    ctx.strokeStyle = "#00d4aa";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    for (let i = 0; i < p95Path.length; i++) {
      const x = xScale(i);
      const y = yScale(p95Path[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 5th percentile line
    const p5Path = paths[0].map((_, i) => {
      const vals = paths.map((p) => p[i]).sort((a, b) => a - b);
      return vals[Math.floor(vals.length * 0.05)];
    });
    ctx.beginPath();
    ctx.strokeStyle = "#ff4466";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < p5Path.length; i++) {
      const x = xScale(i);
      const y = yScale(p5Path[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend
    const legend = [
      { color: "#f1c40f", label: "Median" },
      { color: "#00d4aa", label: "95th %ile" },
      { color: "#ff4466", label: "5th %ile" },
    ];
    legend.forEach(({ color, label }, idx) => {
      const lx = pad.l + idx * 110;
      const ly = H - 8;
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly - 8, 18, 2);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 22, ly - 1);
    });
  }, [paths, p5, p95]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: 380 }}
      className="rounded-xl"
    />
  );
}
