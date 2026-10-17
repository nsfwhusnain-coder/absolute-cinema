"use client";

/**
 * A small line chart for the live dashboard: plain SVG, no library. Each
 * series is a line (an area when asked); an optional limit is a dashed line,
 * and bands shade the zones worth noticing (a temperature's busy and critical
 * lines).
 */

export interface ChartSeries {
  name: string;
  color: string;
  values: Array<number | null>;
  area?: boolean;
  /** Plotted against the right-hand scale. */
  right?: boolean;
  format?: (value: number) => string;
}

export interface ChartBand {
  from: number;
  to: number;
  color: string;
  right?: boolean;
}

const W = 600;
const H = 180;
const PAD = { left: 40, right: 40, top: 10, bottom: 22 };

function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * exp >= value) return step * exp;
  return 10 * exp;
}

export function HubChart({
  times,
  series,
  leftMax,
  rightMax,
  leftFloor = 1,
  limit,
  bands = [],
  leftFormat = (v) => String(Math.round(v)),
  rightFormat = (v) => String(Math.round(v)),
}: {
  times: number[];
  series: ChartSeries[];
  leftMax?: number;
  rightMax?: number;
  /** The left scale never shows less than this (a count of a few viewers would read 0, 1, 1). */
  leftFloor?: number;
  limit?: { value: number; label: string };
  bands?: ChartBand[];
  leftFormat?: (value: number) => string;
  rightFormat?: (value: number) => string;
}) {
  const n = times.length;
  const left = series.filter((s) => !s.right);
  const right = series.filter((s) => s.right);
  const peak = (list: ChartSeries[]) => Math.max(0, ...list.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const lMax = leftMax ?? niceMax(Math.max(peak(left), limit?.value ?? 0, leftFloor) * 1.1);
  const rMax = rightMax ?? niceMax(peak(right) * 1.1);
  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.left - PAD.right));
  const y = (v: number, onRight = false) => PAD.top + (1 - Math.min(1, Math.max(0, v / (onRight ? rMax : lMax)))) * (H - PAD.top - PAD.bottom);

  const path = (s: ChartSeries) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v, s.right).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (s: ChartSeries) => {
    const points = s.values.map((v, i) => (v === null ? null : [x(i), y(v, s.right)] as const)).filter(Boolean) as Array<readonly [number, number]>;
    if (points.length < 2) return "";
    const base = y(0, s.right);
    return `M${points[0]![0]},${base}` + points.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join("") + `L${points.at(-1)![0]},${base}Z`;
  };
  const span = n > 1 ? (times[n - 1]! - times[0]!) / 60_000 : 0;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={series.map((s) => s.name).join(", ")}>
      {bands.map((b, i) => {
        const top = y(b.to, b.right);
        const bottom = y(b.from, b.right);
        return <rect key={i} x={PAD.left} y={top} width={W - PAD.left - PAD.right} height={Math.max(0, bottom - top)} fill={b.color} />;
      })}
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + f * (H - PAD.top - PAD.bottom)} y2={PAD.top + f * (H - PAD.top - PAD.bottom)} stroke="rgba(255,255,255,0.07)" />
          <text x={PAD.left - 6} y={PAD.top + f * (H - PAD.top - PAD.bottom) + 4} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.45)">
            {leftFormat(lMax * (1 - f))}
          </text>
          {right.length > 0 && (
            <text x={W - PAD.right + 6} y={PAD.top + f * (H - PAD.top - PAD.bottom) + 4} fontSize="10" fill="rgba(255,255,255,0.45)">
              {rightFormat(rMax * (1 - f))}
            </text>
          )}
        </g>
      ))}
      {limit && (
        <g>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(limit.value)} y2={y(limit.value)} stroke="rgba(255,255,255,0.35)" strokeDasharray="4 4" />
          <text x={W - PAD.right - 4} y={y(limit.value) - 4} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.55)">
            {limit.label}
          </text>
        </g>
      )}
      {series.map((s) => (s.area ? <path key={`${s.name}-area`} d={area(s)} fill={s.color} opacity={0.15} /> : null))}
      {series.map((s) => (
        <path key={s.name} d={path(s)} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      <text x={PAD.left} y={H - 6} fontSize="10" fill="rgba(255,255,255,0.4)">
        {span ? `${Math.round(span)} min ago` : ""}
      </text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.4)">
        now
      </text>
    </svg>
  );
}

export function ChartLegend({ series }: { series: Array<Pick<ChartSeries, "name" | "color">> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/60">
      {series.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}
