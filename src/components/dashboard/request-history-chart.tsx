import {
  bucketX,
  bucketY,
  CHART_BOX,
  chartBaseline,
} from "@/lib/dashboard/chart-geometry";
export function BucketChart({
  points,
  label,
  plotClass = "h-44",
}: {
  points: Array<{ label: string; axis: string; count: number }>;
  label: string;
  plotClass?: string;
}) {
  const max = Math.max(1, ...points.map((point) => point.count));
  const baseline = chartBaseline();
  const coords = points.map(
    (point, index) =>
      `${bucketX(index, points.length)},${bucketY(point.count, max)}`,
  );
  const line = coords
    .map((coord, index) => `${index === 0 ? "M" : "L"}${coord}`)
    .join(" ");
  const firstX = bucketX(0, points.length);
  const lastX = bucketX(points.length - 1, points.length);
  const area =
    points.length === 0
      ? ""
      : `${line} L${lastX},${baseline} L${firstX},${baseline} Z`;
  const dense = points.length > 14;

  return (
    <div>
      <svg
        viewBox={`0 0 ${CHART_BOX.width} ${chartBaseline() + 2}`}
        preserveAspectRatio="none"
        className={`block w-full ${plotClass}`}
        role="img"
        aria-label={label}
      >
        <line
          x1={CHART_BOX.padX}
          x2={CHART_BOX.width - CHART_BOX.padX}
          y1={baseline}
          y2={baseline}
          stroke="var(--color-base-300)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {area ? <path d={area} fill="var(--st-series)" opacity="0.18" /> : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke="var(--st-series)"
            strokeWidth="1.75"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {points.map((point, index) => {
          const x = bucketX(index, points.length);
          const y = bucketY(point.count, max);
          return (
            <g key={`${point.label}-${index}`}>
              <title>{`${point.label}: ${point.count} captured`}</title>
              <circle cx={x} cy={y} r="8" fill="transparent" />
              {point.count === 0 ? (
                <line
                  x1={x}
                  x2={x}
                  y1={baseline - 4}
                  y2={baseline}
                  stroke="var(--color-base-300)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <circle cx={x} cy={y} r="2.5" fill="var(--st-series)" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="relative h-4">
        {points.map((point, index) =>
          point.axis ? (
            <span
              key={`${point.label}-axis-${index}`}
              className={`absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono text-xs leading-4 text-st-muted ${dense && index !== 0 && index !== points.length - 1 && index % 4 !== 0 ? "max-sm:hidden" : ""}`}
              style={{
                left: `${(bucketX(index, points.length) / CHART_BOX.width) * 100}%`,
              }}
            >
              {point.axis}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
