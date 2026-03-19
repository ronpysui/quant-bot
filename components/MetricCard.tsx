"use client";

interface Props {
  label: string;
  value: string;
  positive?: boolean | null; // null = neutral
  sub?: string;
}

export default function MetricCard({ label, value, positive, sub }: Props) {
  const valueColor =
    positive === null || positive === undefined
      ? "text-white"
      : positive
      ? "text-accent"
      : "text-danger";

  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
      <span className="text-muted text-xs uppercase tracking-widest font-mono">
        {label}
      </span>
      <span className={`text-2xl font-bold font-mono ${valueColor}`}>{value}</span>
      {sub && <span className="text-muted text-xs">{sub}</span>}
    </div>
  );
}
