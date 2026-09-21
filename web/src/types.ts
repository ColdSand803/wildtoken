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
