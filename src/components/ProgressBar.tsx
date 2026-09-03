export interface ProgressBarProps {
  label: string;
  max: number;
  value: number;
  detail?: string;
}

export function ProgressBar({ label, max, value, detail }: ProgressBarProps) {
  return (
    <div className="progress-block">
      <div className="progress-label">
        <span>{label}</span>
        {detail ? <span className="progress-detail">{detail}</span> : null}
      </div>
      <progress aria-label={label} max={max} value={value} />
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"] as const;
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1000)),
    units.length - 1,
  );
  const value = bytes / 1000 ** unitIndex;
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unitIndex]}`;
}
