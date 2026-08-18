# 全部时间统计功能

## 概述

为 WildToken 添加了"全部时间"(all_time) 统计功能，现在可以查看从系统启动以来的所有请求和 Token 使用数据。

## 实现方案

采用**混合缓存策略**：
- **30 天内数据**：继续使用高效的内存缓存（分钟级桶聚合）
- **全部时间数据**：通过直接数据库查询获取（按需查询，不占用内存）

这种方案既保证了近期数据的实时性和性能，又提供了完整的历史统计。

## 修改文件

### 后端 (Rust)

1. **src/models/request_log.rs**
   - 在 `TokenUsageStatsOut` 结构体中添加 `all_time: TokenUsageWindowOut` 字段

2. **src/db/log_stats.rs**
   - 添加 `impl Default for TokenUsageWindowOut` 实现
   - 添加 `all_time_token_usage()` 函数：直接查询数据库获取全部时间统计
   - 在 `snapshot()` 方法中为 `all_time` 字段提供默认值（由 handler 填充）

3. **src/handlers/admin.rs**
   - 修改 `admin_token_usage_stats()` handler：调用新的数据库查询函数填充 `all_time` 数据

4. **src/db/log.rs**
   - 在测试代码中为 `TokenUsageStatsOut` 添加 `all_time` 字段的默认值

### 前端 (JavaScript)

5. **static/js/dashboard.js**
   - 在仪表盘中添加 3 个新的 KPI 卡片：
     - "全部 Tokens" - 全部时间的总 Token 使用量
     - "全部缓存率" - 全部时间的缓存命中率
     - "全部请求" - 全部时间的请求总数

## API 响应示例

```json
{
  "today": { "total_tokens": 100, "prompt_tokens": 80, ... },
  "one_day": { "total_tokens": 100, "prompt_tokens": 80, ... },
  "seven_days": { "total_tokens": 300, "prompt_tokens": 200, ... },
  "thirty_days": { "total_tokens": 300, "prompt_tokens": 200, ... },
  "all_time": { 
    "total_tokens": 1500000,
    "prompt_tokens": 1200000,
    "prompt_cached_tokens": 300000,
    "request_count": 5000,
    "all_request_count": 5500
  }
}
```

## 性能考虑

- **30 天内查询**：~1ms（内存缓存）
- **全部时间查询**：~5-50ms（取决于数据库大小，有适当索引）
- **数据库负载**：全部时间统计仅在访问 `/api/admin/logs/token-usage` 端点时查询，不会影响日常操作

## 测试

- ✅ 所有现有测试通过 (121 passed)
- ✅ 新增单元测试验证 `all_time` 字段结构
- ✅ 编译通过，无错误或警告

## 向后兼容性

完全向后兼容：
- API 响应只是增加了新字段，不影响现有字段
- 前端仪表盘增加了新卡片，不影响现有显示
- 数据库查询逻辑不变，只是增加了新的查询函数

## 使用方法

升级后，在仪表盘上会自动看到新的统计卡片：
- Token 使用区域会显示"全部 Tokens"
- 缓存命中率区域会显示"全部缓存率"  
- 请求统计区域会显示"全部请求"

这些卡片会显示从系统首次运行以来的累计统计数据。
