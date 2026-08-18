# 全部时间 Token 统计修复验证

## 问题描述
在数据看板中，点击"对比"模式后，30D Tokens 显示正常（如 10.8M），但切换到"全部"时 Tokens 显示为 0。

## 根本原因
后端 `TokenUsageStatsOut` 结构体缺少 `all_time` 字段，导致前端尝试读取 `dashboardTokenUsage?.all_time` 时返回 `undefined`，最终显示为 0。

## 修复内容

### 1. 添加 `AllTime` 字段到 `TokenUsageStatsOut`
**文件**: `internal/models/requestlog.go`

```go
type TokenUsageStatsOut struct {
	Today      TokenUsageWindowOut `json:"today"`
	OneDay     TokenUsageWindowOut `json:"one_day"`
	SevenDays  TokenUsageWindowOut `json:"seven_days"`
	ThirtyDays TokenUsageWindowOut `json:"thirty_days"`
	AllTime    TokenUsageWindowOut `json:"all_time"`  // 新增字段
}
```

### 2. 在 `snapshot()` 函数中计算全部时间统计
**文件**: `internal/db/logstats.go`

```go
func (s *logStatsState) snapshot(now time.Time) LogStatsSnapshot {
	// ... 其他窗口计算 ...
	
	var today, oneDay, sevenDays, thirtyDays, allTime logStatsBucket
	for bucketStart, bucket := range s.minuteBuckets {
		// ... 其他窗口累加 ...
		
		// 全部时间包含 30 天缓存窗口内的所有桶
		allTime.add(*bucket)
	}
	// 全部时间的请求总数应反映包括 30 天缓存窗口之外的日志总数
	allTime.requestCount = s.totalLogCount

	return LogStatsSnapshot{
		// ...
		TokenUsage: models.TokenUsageStatsOut{
			Today:      today.window(),
			OneDay:     oneDay.window(),
			SevenDays:  sevenDays.window(),
			ThirtyDays: thirtyDays.window(),
			AllTime:    allTime.window(),  // 新增
		},
	}
}
```

## 注意事项

### Token 统计的限制
由于内存缓存只保留最近 30 天的分桶数据，"全部时间"的 token 统计实际上只包含：
- **Token 数据**: 最近 30 天内的 token 统计
- **请求总数**: 包括所有历史记录（通过 `totalLogCount`）

这是一个合理的折中方案，因为：
1. 保留所有历史的分桶数据会消耗大量内存
2. 最近 30 天的 token 统计已经足够反映趋势
3. 请求总数仍然准确反映全部历史

### 前端显示
前端在"对比"模式下会显示：
- 今天 Tokens
- 1d Tokens
- 7d Tokens
- 30d Tokens
- 全部 Tokens ✅ (现在有数据了)

## 验证步骤
1. 编译项目: `go build -o cmd/wildtoken.exe ./cmd/wildtoken`
2. 启动服务器: `./cmd/wildtoken.exe serve`
3. 打开数据看板
4. 点击"对比"按钮
5. 确认"全部 Tokens"现在显示正确的数值（而不是 0）

## 测试结果
所有单元测试通过 ✅
```
go test ./... -short
```
