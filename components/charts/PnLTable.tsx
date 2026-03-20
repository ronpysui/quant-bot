"use client";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface CellData {
  pct: number;
  usd: number;
}

interface Props {
  data: Record<number, Record<number, CellData>>;
  initialCapital?: number;
}

function cellColor(pct: number | undefined): string {
  if (pct === undefined) return "bg-transparent text-muted";
  if (pct > 10)  return "bg-accent/40 text-white";
  if (pct > 5)   return "bg-accent/25 text-white";
  if (pct > 0)   return "bg-accent/12 text-accent";
  if (pct > -5)  return "bg-danger/15 text-danger";
  if (pct > -10) return "bg-danger/30 text-danger";
  return "bg-danger/50 text-white";
}

function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000)    return `${sign}$${(abs / 1_000).toFixed(0)}k`;
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtBalance(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)    return `$${(abs / 1_000).toFixed(1)}k`;
  if (abs >= 1_000)     return `$${(abs / 1_000).toFixed(2)}k`;
  return `$${abs.toFixed(0)}`;
}

export default function PnLTable({ data, initialCapital = 1000 }: Props) {
  const years = Object.keys(data).map(Number).sort();
  let runningBalance = initialCapital;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-left text-muted p-2 pr-4 whitespace-nowrap">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="text-center text-muted p-2 min-w-[60px]">{m}</th>
            ))}
            <th className="text-center text-muted p-2 min-w-[68px]">Annual</th>
            <th className="text-center text-muted p-2 min-w-[72px]">Balance</th>
          </tr>
        </thead>
        <tbody>
          {years.map((yr) => {
            const row = data[yr];
            const cells = Object.values(row);
            const annualPct = cells.reduce((acc, c) => acc * (1 + c.pct / 100), 1) * 100 - 100;
            const annualUsd = cells.reduce((acc, c) => acc + c.usd, 0);
            runningBalance += annualUsd;

            return (
              <tr key={yr} className="border-t border-border">
                <td className="text-muted p-2 pr-4">{yr}</td>

                {MONTHS.map((_, idx) => {
                  const cell = row[idx + 1];
                  return (
                    <td
                      key={idx}
                      className={`text-center p-1 rounded ${cellColor(cell?.pct)}`}
                    >
                      {cell !== undefined ? (
                        <div className="flex flex-col leading-tight">
                          <span>{fmtPct(cell.pct)}</span>
                          <span className="text-[9px] opacity-70">{fmtUsd(cell.usd)}</span>
                        </div>
                      ) : "—"}
                    </td>
                  );
                })}

                {/* Annual */}
                <td className={`text-center p-1 font-bold rounded ${cellColor(annualPct)}`}>
                  <div className="flex flex-col leading-tight">
                    <span>{fmtPct(annualPct)}</span>
                    <span className="text-[9px] opacity-70 font-normal">{fmtUsd(annualUsd)}</span>
                  </div>
                </td>

                {/* Running balance */}
                <td className="text-center p-1">
                  <span className={`font-bold ${runningBalance >= initialCapital ? "text-accent" : "text-danger"}`}>
                    {fmtBalance(runningBalance)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
