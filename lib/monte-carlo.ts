export interface MCResult {
  paths: number[][];   // [simulation][trade index] → cumulative equity
  median: number;
  p5: number;
  p95: number;
  pctProfitable: number;
  medianReturn: number;
}

const INITIAL_CAPITAL = 10_000;

export function runMonteCarlo(
  tradePnls: number[],
  nSimulations = 500
): MCResult | null {
  if (tradePnls.length < 2) return null;

  const n = tradePnls.length;
  const paths: number[][] = [];

  for (let s = 0; s < nSimulations; s++) {
    const path = [INITIAL_CAPITAL];
    let equity = INITIAL_CAPITAL;
    for (let t = 0; t < n; t++) {
      // bootstrap resample
      const pnl = tradePnls[Math.floor(Math.random() * n)];
      equity = Math.max(0, equity + pnl);
      path.push(equity);
    }
    paths.push(path);
  }

  const finals = paths.map((p) => p[p.length - 1]);
  finals.sort((a, b) => a - b);

  const median = finals[Math.floor(finals.length / 2)];
  const p5 = finals[Math.floor(finals.length * 0.05)];
  const p95 = finals[Math.floor(finals.length * 0.95)];
  const pctProfitable = (finals.filter((v) => v > INITIAL_CAPITAL).length / finals.length) * 100;

  return {
    paths,
    median,
    p5,
    p95,
    pctProfitable,
    medianReturn: ((median - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100,
  };
}
