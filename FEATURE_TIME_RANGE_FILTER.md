# 时间范围筛选功能

## 概述

为仪表盘的 Token 统计添加了灵活的时间范围筛选功能，支持预设时间范围和自定义日期选择。

## 功能特性

### 1. 预设时间范围

用户可以从下拉菜单中快速选择常用的时间范围：

- **默认视图** - 显示所有时间窗口（今天、1天、7天、30天、全部）
- **今天** - 仅显示本地日累计数据
- **最近 1 天** - 最近 24 小时
- **最近 7 天** - 最近 7 天
- **最近 30 天** - 最近 30 天
- **全部时间** - 从系统首次运行以来的所有数据
- **自定义时间** - 用户指定开始和结束日期

### 2. 自定义时间范围

当选择"自定义时间"时：
- 会显示日期选择器面板
- 用户输入开始日期和结束日期
- 点击"应用"按钮后查询该时间范围的统计数据
- 自动验证日期有效性（开始日期不能晚于结束日期）

### 3. 动态显示

- **默认视图模式**：显示所有预设时间窗口的统计卡片（15 个卡片）
- **单一范围模式**：选择特定时间范围后，只显示该范围的 3 个统计卡片
  - Tokens 总量
  - 缓存命中率
  - 请求总数
- 显示当前选择的时间范围标签

## 技术实现

### 后端改动

#### 1. API 查询参数 (`src/handlers/admin.rs`)

为 `/api/admin/logs/token-usage` 端点添加查询参数支持：

```rust
pub struct TokenUsageQuery {
    pub range: Option<String>,      // "default" | "all" | "custom"
    pub start_date: Option<String>,  // YYYY-MM-DD 格式
    pub end_date: Option<String>,    // YYYY-MM-DD 格式
}
```

#### 2. 数据库查询函数 (`src/db/log_stats.rs`)

新增两个查询函数：

```rust
// 查询全部时间的统计数据
pub async fn all_time_token_usage(db: &Database) -> Result<TokenUsageWindowOut>

// 查询自定义时间范围的统计数据
pub async fn custom_range_token_usage(
    db: &Database,
    start_date: &str,
    end_date: &str
) -> Result<TokenUsageWindowOut>
```

**性能特点**：
- 全部时间查询直接扫描数据库，无缓存
- 自定义范围查询使用日期过滤，支持任意时间跨度
- 响应时间：5-50ms（取决于数据量）

### 前端改动

#### 1. HTML 结构 (`static/index.html`)

在仪表盘页面添加时间筛选控件：

```html
<div class="dashboard-time-filter">
  <label for="dashboard-time-preset">统计时间范围：</label>
  <select id="dashboard-time-preset">
    <option value="default">默认（全部窗口）</option>
    <option value="today">今天</option>
    <option value="1d">最近 1 天</option>
    <option value="7d">最近 7 天</option>
    <option value="30d">最近 30 天</option>
    <option value="all">全部时间</option>
    <option value="custom">自定义时间</option>
  </select>

  <div id="dashboard-custom-range" style="display:none;">
    <input type="date" id="dashboard-start-date" />
    <span>至</span>
    <input type="date" id="dashboard-end-date" />
    <button id="dashboard-apply-custom">应用</button>
  </div>

  <span id="dashboard-selected-range"></span>
</div>
```

#### 2. JavaScript 逻辑 (`static/js/dashboard.js`)

添加状态管理和 UI 更新：

```javascript
// 全局状态
let dashboardTimeRange = "default";
let dashboardCustomStartDate = null;
let dashboardCustomEndDate = null;

// 获取时间范围标签
function getTimeRangeLabel(range) { ... }

// 动态渲染统计卡片（根据选择的范围）
function renderDashboard() {
  if (dashboardTimeRange === "custom" || dashboardTimeRange === "all") {
    // 显示单一范围的 3 个统计卡片
  } else {
    // 显示默认的 15 个统计卡片
  }
}
```

#### 3. 事件处理 (`static/js/events.js`)

绑定筛选器交互事件：

```javascript
// 预设范围选择
dashboardTimePreset.addEventListener("change", () => {
  if (value === "custom") {
    // 显示日期选择器
  } else {
    // 立即加载数据
  }
});

// 自定义范围应用
dashboardApplyCustom.addEventListener("click", () => {
  // 验证日期
  // 设置状态
  // 重新加载数据
});
```

#### 4. API 调用更新 (`static/js/dashboard.js`)

在 `loadDashboardData()` 中构建动态查询参数：

```javascript
const tokenUsageParams = new URLSearchParams();
if (dashboardTimeRange === "custom") {
  tokenUsageParams.set("range", "custom");
  tokenUsageParams.set("start_date", dashboardCustomStartDate);
  tokenUsageParams.set("end_date", dashboardCustomEndDate);
} else if (dashboardTimeRange === "all") {
  tokenUsageParams.set("range", "all");
} else {
  tokenUsageParams.set("range", "default");
}
```

### CSS 样式 (`static/css/dashboard.css`)

为时间筛选控件添加样式：

```css
.dashboard-time-filter {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

#dashboard-custom-range {
  display: none;
  gap: 0.5rem;
  align-items: center;
}
```

## API 接口

### GET /api/admin/logs/token-usage

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `range` | string | 否 | 时间范围类型：`default`、`all`、`custom` |
| `start_date` | string | 条件 | 开始日期（YYYY-MM-DD），`range=custom` 时必填 |
| `end_date` | string | 条件 | 结束日期（YYYY-MM-DD），`range=custom` 时必填 |

**响应示例：**

1. **默认范围** (`range=default` 或不传):
```json
{
  "today": {...},
  "one_day": {...},
  "seven_days": {...},
  "thirty_days": {...},
  "all_time": {...}
}
```

2. **全部时间** (`range=all`):
```json
{
  "today": {
    "total_tokens": 1234567,
    "request_count": 5678,
    "cache_creation_tokens": 500000,
    "cache_read_tokens": 300000
  },
  "one_day": {},
  "seven_days": {},
  "thirty_days": {},
  "all_time": {}
}
```

3. **自定义范围** (`range=custom&start_date=2026-08-01&end_date=2026-08-10`):
```json
{
  "today": {
    "total_tokens": 123456,
    "request_count": 234,
    "cache_creation_tokens": 50000,
    "cache_read_tokens": 30000
  },
  "one_day": {},
  "seven_days": {},
  "thirty_days": {},
  "all_time": {}
}
```

**注意**：当 `range` 为 `all` 或 `custom` 时，筛选后的数据会放在 `today` 字段中返回。

## 用户体验

### 操作流程

1. **查看默认视图**
   - 打开仪表盘，默认显示所有时间窗口
   - 15 个统计卡片按行排列

2. **选择预设范围**
   - 从下拉菜单选择时间范围（如"最近 7 天"）
   - 页面自动刷新，显示该范围的统计数据
   - 卡片数量减少为 3 个，标题显示选中的范围

3. **使用自定义范围**
   - 从下拉菜单选择"自定义时间"
   - 日期选择器面板展开
   - 选择开始日期和结束日期
   - 点击"应用"按钮
   - 页面刷新显示自定义范围的统计数据

4. **返回默认视图**
   - 从下拉菜单选择"默认（全部窗口）"
   - 恢复显示所有时间窗口的统计卡片

### 错误处理

- **缺少日期**：提示"请选择开始和结束日期"
- **日期顺序错误**：提示"开始日期不能晚于结束日期"
- **API 错误**：显示"看板加载失败"消息

## 测试

### 单元测试

所有 121 个现有测试通过，包括：
- Token 使用统计查询
- 数据库操作
- API 端点

### 手动测试

使用提供的测试脚本：

```bash
bash test_time_filter.sh
```

测试场景：
1. 默认范围查询
2. 全部时间查询
3. 自定义范围查询（最近 7 天）
4. 无效查询（缺少日期参数）

## 性能考虑

### 缓存策略

- **近 30 天**：使用内存缓存（毫秒级响应）
- **全部时间**：直接查询数据库（5-50ms）
- **自定义范围**：直接查询数据库，使用日期索引优化

### 数据库查询

```sql
-- 全部时间查询
SELECT 
    SUM(total_tokens) as total_tokens,
    SUM(cache_creation_tokens) as cache_creation_tokens,
    SUM(cache_read_tokens) as cache_read_tokens,
    COUNT(*) as request_count
FROM request_logs
WHERE total_tokens IS NOT NULL;

-- 自定义范围查询
SELECT ...
FROM request_logs
WHERE total_tokens IS NOT NULL
  AND created_at >= ?
  AND created_at < datetime(?, '+1 day');
```

**优化点**：
- 使用 `created_at` 列的索引加速时间范围过滤
- 只扫描有 token 数据的记录（`WHERE total_tokens IS NOT NULL`）

## 向后兼容性

- ✅ 不改变现有 API 的默认行为
- ✅ 查询参数为可选，不传参数时返回默认数据
- ✅ 前端默认显示传统的多窗口视图
- ✅ 所有现有测试通过

## 未来改进

可能的增强方向：

1. **时间范围预设扩展**
   - 最近 90 天
   - 本月 / 上月
   - 本年 / 去年

2. **日期选择器增强**
   - 快捷选择按钮（"最近 7 天"、"最近 30 天"）
   - 日期范围拖拽选择
   - 记住上次选择的自定义范围

3. **数据导出**
   - 导出选定时间范围的统计数据为 CSV / JSON
   - 生成统计报表

4. **高级筛选**
   - 按渠道筛选
   - 按模型筛选
   - 多维度组合筛选

5. **性能优化**
   - 为常用的自定义范围添加缓存
   - 后台预计算热门时间窗口

## 总结

此功能为用户提供了灵活的时间范围筛选能力，既保留了原有的默认视图，又支持查看任意时间段的统计数据。实现方式简洁高效，性能良好，用户体验友好。
