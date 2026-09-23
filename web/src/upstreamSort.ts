/**
 * 渠道列表的排序规则。
 *
 * 抽成独立模块是为了能被直接测到——次因子不跟主列翻转这类规则，靠源码字符串
 * 断言锁不住。
 */

import type { Upstream } from "./types";

export type SortKey = "id" | "name" | "status" | "priority";

export type SortSpec = { key: SortKey; desc: boolean };

/** 默认排序：高优先级在前，和路由挑渠道的顺序一致。 */
export const DEFAULT_UPSTREAM_SORT: SortSpec = { key: "priority", desc: true };

/** 排序偏好落盘的键，和列显隐（wildtoken_upstream_columns）同一套命名。 */
export const UPSTREAM_SORT_KEY = "wildtoken_upstream_sort";

const SORT_KEYS: readonly SortKey[] = ["id", "name", "status", "priority"];

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
export function compareUpstreams(sort: SortSpec) {
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

/**
 * 从 localStorage 读回排序偏好，切页/刷新都不丢。
 *
 * 逐个字段校验：localStorage 可能被手改、被旧版本遗留、或者内容已经损坏，任
 * 一项不对就整体回落到默认值。按错一列的代价比丢一次偏好大。
 */
export function readStoredSort(storage: Pick<Storage, "getItem"> | undefined): SortSpec {
  try {
    const raw = storage?.getItem(UPSTREAM_SORT_KEY);
    if (!raw) return DEFAULT_UPSTREAM_SORT;

    const parsed = JSON.parse(raw) as { key?: unknown; desc?: unknown } | null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.key === "string" &&
      SORT_KEYS.includes(parsed.key as SortKey) &&
      typeof parsed.desc === "boolean"
    ) {
      return { key: parsed.key as SortKey, desc: parsed.desc };
    }
  } catch {
    // 存储被隐私模式挡住、或者 JSON 坏了：按默认排。
  }
  return DEFAULT_UPSTREAM_SORT;
}
