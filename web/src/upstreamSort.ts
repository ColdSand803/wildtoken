/**
 * 渠道列表的排序规则。
 *
 * 抽成独立模块是为了能被直接测到——次因子不跟主列翻转这类规则，靠源码字符串
 * 断言锁不住。
 */

import type { Upstream } from "./types";

export type SortKey = "id" | "name" | "status" | "priority";

/** 状态档：可用 → 权重归零 → 停用。排序时小的在前。 */
export function statusRank(upstream: Pick<Upstream, "enabled" | "effective_weight">): number {
  if (!upstream.enabled) return 2;
  return upstream.effective_weight <= 0 ? 1 : 0;
}

/**
 * 生成比较器。
 *
 * 次因子**不跟主列翻转**：按状态排时，同一状态内部永远高优先级在前，和路由
 * 实际挑渠道的顺序一致。翻转了的话，把状态列点成倒序就会让最不可能被选中的
 * 渠道排在组内最前面。
 */
export function compareUpstreams(sort: { key: SortKey; desc: boolean }) {
  return (a: Upstream, b: Upstream): number => {
    let delta: number;
    switch (sort.key) {
      case "id":
        delta = a.id - b.id;
        break;
      case "name":
        delta = a.name.localeCompare(b.name, "zh-CN");
        break;
      case "status":
        delta = statusRank(a) - statusRank(b);
        break;
      default:
        delta = a.priority - b.priority;
    }

    if (delta !== 0) return sort.desc ? -delta : delta;
    if (sort.key === "status" && a.priority !== b.priority) return b.priority - a.priority;

    // id 兜底，保证顺序稳定。
    return a.id - b.id;
  };
}
