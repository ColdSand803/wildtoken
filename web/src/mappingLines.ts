/**
 * 「每行一条」映射的解析与回填。
 *
 * 模型映射和思考强度映射共用这一套写法，抽出来是为了能被直接测到。
 */

/**
 * 每行一条 `键 => 值`，也收 `=` 和 `:`。
 *
 * 三种分隔符都要认：控制台显示成 `a => b`，从别处复制过来的内容必须能原样
 * 吃下。只找第一个 `=` 的写法会把 `a => b` 切成 `a` 和 `> b`，而且不报错
 * ——这种错法在界面上完全看不出来。
 *
 * 键的大小写原样保留：需要抹平的那部分由后端统一处理，两边都折的话，哪天
 * 后端改了规则前端还在按老规则折，就会对不上。
 */
export function parseMappingLines(value: string, label: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(.+?)(?:=>|=|:)(.+)$/);
    if (!match) throw new Error(`${label}格式错误：${trimmed}`);

    const key = match[1].trim();
    const mapped = match[2].trim();
    if (key && mapped) result[key] = mapped;
  }

  return result;
}

/** 回填成可编辑的每行一条。分隔符固定用 `=>`，读起来方向明确。 */
export function joinMappingLines(mappings: Record<string, string>): string {
  return Object.entries(mappings)
    .map(([key, value]) => `${key} => ${value}`)
    .join("\n");
}
