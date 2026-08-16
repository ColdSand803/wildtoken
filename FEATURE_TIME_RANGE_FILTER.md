# 看板时间范围筛选

看板顶部有一个统一的时间范围控件，同时驱动 Tokens 统计、请求统计和 Top 排行。支持快捷区间与自定义日期区间。

## 快捷区间

| 选项 | `range` 值 | 含义 |
| --- | --- | --- |
| 今天 | `today` | 本地日 00:00 起至今 |
| 最近 24 小时 | `1d` | 滚动 24 小时 |
| 最近 3 天 | `3d` | 滚动 3 天 |
| 最近 7 天 | `7d` | 滚动 7 天 |
| 最近 30 天 | `30d` | 滚动 30 天（默认） |
| 全部时间 | `all` | 日志库全部数据 |
| 所有窗口对比 | `default` | 并排显示上述预设窗口 |
| 自定义... | `custom` | 用户指定起止日期 |

「今天」按**本地日**边界计算，其余快捷项是相对当前时刻的偏移。

## 自定义区间

选「自定义...」后展开日期选择器，填好起止日期点「应用」。

- 起止日期**都含当日**：选「8月5日 至 8月5日」得到 8月5日全天。
- 上限 366 天，避免一次查询扫过整个日志库。
- 前后端各校验一次：缺日期、起晚于止、格式非 `YYYY-MM-DD`、超跨度都会被拒并给出中文提示。

所选范围与自定义日期保存在 localStorage（`wildtoken_dashboard_range`、`wildtoken_dashboard_custom_range`），刷新后保留。旧的 `wildtoken_dashboard_top_window` 会被自动迁移。

## 数据来源

`LogStatsCache` 常驻内存维护 today / 1d / 7d / 30d 四个窗口，命中这些档位时**零查询**；其余档位查库：

| 范围 | 来源 |
| --- | --- |
| `today` / `1d` / `7d` / `30d` / `default` | 内存缓存 |
| `3d` | SQL（缓存无 3 天桶） |
| `all` / `custom` | SQL |

## API

### GET /api/admin/logs/token-usage

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `range` | 否 | 上表中的值，缺省为 `default` |
| `start_date` | `range=custom` 时必填 | `YYYY-MM-DD` |
| `end_date` | `range=custom` 时必填 | `YYYY-MM-DD` |

`range=default` 返回全部预设窗口，形状与历史版本一致：

```json
{ "today": {…}, "one_day": {…}, "seven_days": {…}, "thirty_days": {…}, "all_time": {…} }
```

其余单窗口范围把聚合结果放在 `today` 字段（保持向后兼容），并额外返回 `range` 与 `range_label` 说明这实际是哪个窗口：

```json
{
  "today": { "total_tokens": 300, "prompt_tokens": 150, "prompt_cached_tokens": 30,
             "request_count": 2, "all_request_count": 2 },
  "one_day": {…}, "seven_days": {…}, "thirty_days": {…}, "all_time": {…},
  "range": "3d",
  "range_label": "最近 3 天"
}
```

前端优先读 `range_label`，因此显示的标签总与实际返回的数据一致。

### GET /api/admin/logs/top

同一个范围也用于排行，参数名为 `window`（值同上表），`window=custom` 时同样接受 `start_date` / `end_date`。排行没有多窗口概念，`window=default` 回落到 30 天。

## 实现位置

- `src/models/request_log.rs` — `DashboardRange`：解析与校验查询参数（纯函数，含单元测试）。
- `src/handlers/admin.rs` — `admin_token_usage_stats`、`admin_top_log_stats`。
- `src/db/log_stats.rs` — `cutoff_token_usage` / `all_time_token_usage` / `custom_range_token_usage`。
- `src/db/log.rs` — `LogTopWindow`，含 `AllTime` 与 `Custom` 变体；自定义日期以 bind 参数传入，不拼接 SQL。
- `static/admin.html` / `static/js/{bootstrap,dashboard,events}.js` / `static/css/dashboard.css` — 控件与渲染。

## 注意

`request_logs.created_at` 以无偏移的 UTC 存储。「今天」必须用 `datetime('now','localtime','start of day','utc')` 三段式取本地日起点——直接按 UTC 日计算会在 +0800 等时区下偏差 8 小时。所有窗口共用这一套 cutoff 表达式，Tokens 统计和 Top 排行因此不会出现口径不一致。
