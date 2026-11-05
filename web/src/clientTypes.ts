/* 日志页“客户端”下拉的选项。

   清单来自服务端：库里出现过哪些类型就列哪些。导入的 faketoken 历史里有
   axonhub、evo 这些 wildtoken 自己认不出的类型，写死的清单选不到它们。 */

/** 控制台自己发的探测，不是真实客户端。和 internal/handlers/upstreams.go 的 probe* 常量对应。 */
const PROBE_CLIENT_TYPES = new Set(["channel-test", "model-list", "model-test", "balance"]);

export interface ClientTypeOptions {
  /** 真实客户端，按名称排序。 */
  clients: string[];
  /** 控制台探测，排在最后单独一组。 */
  probes: string[];
}

/**
 * 合并三处来源：服务端清单、页面上已有的行、当前选中的值。
 *
 * 后两处补的是清单之后才出现的类型：日志页常驻，清单只在打开时取一次，
 * 之后流进来的新类型要靠行补上。选中值也得在，否则下拉显示不出当前筛选。
 *
 * 例：listed ["pi", "claude"]，seen ["balance", "pi"]，selected ""
 *   → { clients: ["claude", "pi"], probes: ["balance"] }
 */
export function clientTypeOptions(
  listed: readonly string[],
  seen: Iterable<string>,
  selected: string,
): ClientTypeOptions {
  const all = new Set(listed);
  for (const type of seen) all.add(type);
  all.add(selected);
  all.delete("");

  // 按码点排，和服务端 SQLite 的默认排序一致。
  const sorted = [...all].sort();
  return {
    clients: sorted.filter((type) => !PROBE_CLIENT_TYPES.has(type)),
    probes: sorted.filter((type) => PROBE_CLIENT_TYPES.has(type)),
  };
}
