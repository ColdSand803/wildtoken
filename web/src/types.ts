/* API 类型。字段名对着 internal/models 里的 json tag 抄，不是猜的——
   改后端时这里的编译错误就是提示。 */

export interface Upstream {
  id: number;
  name: string;
  base_url: string;
  api_key_set: boolean;
  model_names: string[];
  model_prefixes: string[];
  model_mappings: Record<string, string>;
  effort_mappings: Record<string, string>;
  priority: number;
  weight: number;
  auto_weight_enabled: boolean;
  enabled: boolean;
  /** 归档渠道同时读作停用：归档会把 enabled 置 0。 */
  archived: boolean;
  extra_headers: Record<string, string>;
  timeout_seconds: number;
  rate_limit: string | null;
  created_at: string;
  updated_at: string;
  runtime_health_score: number;
  effective_weight: number;
  health_recovery_remaining_seconds?: number;
  group_ids: number[];
}

/** 卡片视图的每渠道统计。一次请求拿全部，按 id 开。 */
export interface UpstreamStats {
  sparkline: Array<{ bucket: string; count: number }>;
  totalRequests: number;
  cacheHitRate: number;
  /** 每百万请求的平均 Token 消耗——本项目不存单价，这是成本的代理指标。 */
  avgTokensPer1M: number;
}

/* 日志行。指针字段在 Go 那边是 *T，这里就是 T | null——不要写成
   可选属性，否则分不清「字段缺失」和「值为空」。 */
export interface RequestLog {
  id: number;
  created_at: string;
  method: string;
  path: string;
  downstream_token_id: number | null;
  downstream_token_name: string | null;
  client_type: string;
  upstream_id: number | null;
  upstream_name: string | null;
  model: string | null;
  request_model: string | null;
  upstream_model: string | null;
  reasoning_effort: string | null;
  upstream_reasoning_effort: string | null;
  response_reasoning_effort: string | null;
  stream: number;
  status_code: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cached_tokens: number | null;
  cache_creation_tokens: number | null;
  completion_reasoning_tokens: number | null;
  duration_ms: number | null;
  first_token_ms: number | null;
  error: string | null;
}

/** 在途请求。没有游标位置，所以只随最新一页和 SSE 快照来。 */
export interface ActiveRequest {
  id: number;
  started_at: string;
  elapsed_ms: number;
  method: string;
  path: string;
  downstream_token_id: number | null;
  downstream_token_name: string | null;
  client_type: string;
  upstream_id: number | null;
  upstream_name: string | null;
  model: string | null;
  request_model: string | null;
  upstream_model: string | null;
  reasoning_effort: string | null;
  upstream_reasoning_effort: string | null;
  /** 路由换过几个渠道。没选中渠道前是 0。 */
  attempt: number;
}

export interface RequestLogPage {
  items: RequestLog[];
  has_more: boolean;
  /** 只在最新一页填。 */
  active?: ActiveRequest[];
  /** 并发数读这个而不是 active.length——后者有上限截断。 */
  active_total: number;
  recent_rpm: number;
  recent_tpm: number;
}

/** 导出文档里的一条渠道。字段和 Go 的 ChannelExportItem 对齐。 */
export interface ChannelExportItem {
  name: string;
  base_url: string;
  api_key?: string | null;
  model_names: string[];
  model_prefixes: string[];
  model_mappings: Record<string, string>;
  effort_mappings?: Record<string, string>;
  priority: number;
  weight: number;
  auto_weight_enabled: boolean;
  enabled: boolean;
  extra_headers: Record<string, string>;
  timeout_seconds: number;
  rate_limit?: string | null;
  group_ids: number[];
}

/** 导出/导入的文档包装。kind 和 version 用于拒掉不相干的 JSON。 */
export interface ChannelExportDocument {
  kind: string;
  version: number;
  channels: ChannelExportItem[];
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  items: Array<{ name: string; action: string; message?: string }>;
}
