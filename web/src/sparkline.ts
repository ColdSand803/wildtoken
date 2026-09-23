export interface SparkCoord {
  x: number;
  y: number;
}

/**
 * 轻度数值平滑：两遍 [1, 2, 1] / 4 对称移动平均，压制逐桶抖动，让曲线圆滑但不过度削峰。
 * 端点保持原值，边界不被拉平。
 */
export function smoothSeries(values: number[], passes = 2): number[] {
  if (values.length <= 2) return values.slice();
  let current = values.slice();
  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice();
    for (let i = 1; i < current.length - 1; i++) {
      next[i] = (current[i - 1] + current[i] * 2 + current[i + 1]) / 4;
    }
    current = next;
  }
  return current;
}

/**
 * Catmull-Rom 转三次贝塞尔的平滑折线。
 * coords 是已经换算到 SVG 坐标系的 {x, y} 数组；返回描边路径和向 baselineY 封口的面积路径。
 * 控制点的 y 会被夹在 [minY, maxY] 里，防止拐点过冲。
 */
export function buildSmoothSparkPaths(
  coords: SparkCoord[],
  {
    baselineY,
    minY = -Infinity,
    maxY = Infinity,
  }: {
    baselineY: number;
    minY?: number;
    maxY?: number;
  },
): { line: string; area: string } {
  if (!coords.length) return { line: "", area: "" };
  const fmt = (value: number) => value.toFixed(2);
  if (coords.length === 1) {
    const only = coords[0];
    const line = `M ${fmt(only.x)} ${fmt(only.y)}`;
    return { line, area: `${line} L ${fmt(only.x)} ${fmt(baselineY)} Z` };
  }
  const clampY = (value: number) => Math.min(Math.max(value, minY), maxY);
  let line = `M ${fmt(coords[0].x)} ${fmt(coords[0].y)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] || coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    line += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${line} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
  return { line, area };
}
