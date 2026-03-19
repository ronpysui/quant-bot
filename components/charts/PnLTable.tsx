"use client";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Props {
  data: Record<number, Record<number, number>>; // year → month(1-12) → return%
}

function cellColor(v: number | undefined): string {
  if (v === undefined) return "bg-transparent text-muted";
  if (v > 10) return "bg-accent/40 text-white";
  if (v > 5) return "bg-accent/25 text-white";
  if (v > 0) return "bg-accent/12 text-accent";
  if (v > -5) return "bg-danger/15 text-danger";
  if (v > -10) return "bg-danger/30 text-danger";
  return "bg-danger/50 text-white";
}

export default function PnLTable({ data }: Props) {
  const years = Object.keys(data).map(Number).sort();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-left text-muted p-2 pr-4">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="text-center text-muted p-2 min-w-[52px]">{m}</th>
            ))}
            <th className="text-center text-muted p-2 min-w-[60px]">Annual</th>
          </tr>
        </thead>
        <tbody>
          {years.map((yr) => {
            const row = data[yr];
            const monthlyVals = Object.values(row);
            const annual =
              monthlyVals.reduce((acc, r) => acc * (1 + r / 100), 1) * 100 - 100;

            return (
              <tr key={yr} className="border-t border-border">
                <td className="text-muted p-2 pr-4">{yr}</td>
                {MONTHS.map((_, idx) => {
                  const val = row[idx + 1];
                  return (
                    <td
                      key={idx}
                      className={`text-center p-1 rounded ${cellColor(val)}`}
                    >
                      {val !== undefined ? `${val > 0 ? "+" : ""}${val.toFixed(1)}%` : "—"}
                    </td>
                  );
                })}
                <td className={`text-center p-1 font-bold rounded ${cellColor(annual)}`}>
                  {`${annual > 0 ? "+" : ""}${annual.toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
