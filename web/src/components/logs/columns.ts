import type { ColumnDef } from "../../useColumns";

export type ColumnKey =
  | "time" | "channel" | "token" | "client" | "model" | "reasoning" | "status" | "duration" | "tokens" | "ip" | "detail";

export const COLUMNS: ReadonlyArray<ColumnDef<ColumnKey> & { className?: string }> = [
  { key: "time", label: "时间" },
  { key: "channel", label: "渠道" },
  { key: "token", label: "令牌" },
  { key: "client", label: "客户端" },
  { key: "model", label: "模型" },
  { key: "reasoning", label: "思考强度", className: "col-reasoning" },
  { key: "status", label: "状态码" },
  { key: "duration", label: "响应性能" },
  { key: "tokens", label: "Tokens" },
  { key: "ip", label: "IP" },
  { key: "detail", label: "详情" },
];
