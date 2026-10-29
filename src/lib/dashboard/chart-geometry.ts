/** Shared plot box for the activity line and its x-axis labels. */
export const CHART_BOX = {
  width: 640,
  height: 112,
  padX: 44,
  padTop: 8,
  axis: 20,
} as const;

export function bucketX(index: number, count: number) {
  if (count <= 1) return CHART_BOX.width / 2;
  const span = CHART_BOX.width - CHART_BOX.padX * 2;
  return CHART_BOX.padX + (index / (count - 1)) * span;
}

export function bucketY(count: number, max: number) {
  const baseline = CHART_BOX.height - CHART_BOX.axis;
  const plot = baseline - CHART_BOX.padTop;
  return baseline - (count / Math.max(1, max)) * plot;
}

export function chartBaseline() {
  return CHART_BOX.height - CHART_BOX.axis;
}
