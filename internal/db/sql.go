package db

import (
	"fmt"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// Schema statements, kept verbatim so an existing wildtoken.db opens unchanged.

const createUpstreams = `
CREATE TABLE IF NOT EXISTS upstreams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    base_url        TEXT NOT NULL,
    api_key         TEXT,
    model_names     TEXT NOT NULL DEFAULT '[]',
    model_prefixes  TEXT NOT NULL DEFAULT '[]',
    model_mappings  TEXT NOT NULL DEFAULT '{}',
    priority        INTEGER NOT NULL DEFAULT 100,
    weight          INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 0 AND 10000),
    auto_weight_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_weight_enabled IN (0, 1)),
    enabled         INTEGER NOT NULL DEFAULT 1,
    -- Archiving parks a channel out of routing without deleting it. The table
    -- keeps one column for the fact and one for what enabled was before, so
    -- unarchiving restores that rather than assuming it was on.
    archived             INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    archived_prev_enabled INTEGER,
    extra_headers   TEXT NOT NULL DEFAULT '{}',
    timeout_seconds REAL NOT NULL DEFAULT 300.0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`

// createUpstreamKeys holds each channel's API keys, used in id order. A
// channel with none signs in through its headers alone.
//
// upstreams.api_key stays as a copy of the first enabled key, NULL when there
// is none: probes read it, and so does a build from before this table, which
// a rollback may run.
const createUpstreamKeys = `
CREATE TABLE IF NOT EXISTS upstream_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '',
    api_key     TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`

const createUpstreamKeysIndex = `CREATE INDEX IF NOT EXISTS idx_upstream_keys_upstream ON upstream_keys(upstream_id, id);`

const createModelTestPromptTemplates = `
CREATE TABLE IF NOT EXISTS model_test_prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`

const seedModelTestPromptTemplates = `INSERT INTO model_test_prompt_templates (name, prompt) VALUES
    ('模型能力概览', '请用中文说明你当前使用的模型名称、两项主要能力，以及用户提交复杂任务时应提供的关键信息。使用自然段，不要使用表格、工具或外部引用。总回复不超过 120 个汉字。'),
    ('代码审查', '请审查以下需求的实现风险：一个 HTTP API 需要支持鉴权、超时、错误处理和请求日志。用三条简短建议说明优先级和原因，不要编造未提供的事实。'),
    ('问题排查', '请给出排查 API 请求失败的步骤。按网络、认证、请求格式、上游响应四个方面排序，每项一句，并说明最先应收集的证据。'),
    ('结构化摘要', '请用三条要点总结：如何把一项复杂工程任务拆分为可验证的步骤。每条不超过 30 个汉字，不要使用表格。'),
    ('中文问答', '请用中文解释为什么客户端超时不一定代表上游服务故障。给出一个简短例子，并说明日志中应重点查看哪些字段。'),
    ('工单信息抽取', '阅读下列工单摘要：用户在周一上午提交订单，支付成功后页面仍显示待付款，客服已确认未重复扣款。请提取时间、现象、已知事实和下一步核查项，按四行中文输出；不得补充未提供的原因。'),
    ('用户向改写', '将下面的产品说明改写为面向普通用户的两段中文：系统会在请求失败后按固定间隔重试三次，并记录每次状态码。要求保留事实、避免技术缩写、每段不超过45个汉字，末尾给出一个简短标题。'),
    ('指标计算', '根据以下数据计算并解释结果：某服务一分钟收到240个请求，其中12个返回5xx，18个因客户端取消，其余成功。请给出成功率和服务端错误率，保留一位小数，并用两句话说明计算口径。'),
    ('发布风险评估', '请判断以下发布方案是否存在风险：先停掉旧版本全部实例，再启动新版本，健康检查失败时由人工回滚。列出三个最重要的风险及对应改进，每条包含“风险：”和“改进：”，不要假设额外基础设施。'),
    ('JSON结构化输出', '请把零散信息整理成 JSON，字段固定为 title、priority、owner、next_step：任务是修复登录超时；优先级高；负责人小林；先收集失败请求的时间范围和状态码。只输出合法 JSON，不要使用 Markdown 代码块。')
    ON CONFLICT(name) DO NOTHING`

const createAdminCredential = `
CREATE TABLE IF NOT EXISTS admin_credential (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credential_hash TEXT NOT NULL,
    credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
    rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`

const createRequestLogs = `
CREATE TABLE IF NOT EXISTS request_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    method              TEXT NOT NULL,
    path                TEXT NOT NULL,
    downstream_token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL,
    downstream_token_name TEXT,
    -- Client address, as resolved from X-Forwarded-For / X-Real-IP with the
    -- socket peer as fallback. NULL on rows written before the column existed.
    client_ip           TEXT,
    client_type         TEXT NOT NULL DEFAULT 'unknown',
    upstream_id         INTEGER REFERENCES upstreams(id) ON DELETE SET NULL,
    upstream_name       TEXT,
    model               TEXT,
    request_model       TEXT,
    upstream_model      TEXT,
    reasoning_effort    TEXT,
    response_reasoning_effort TEXT,
    stream              INTEGER NOT NULL DEFAULT 0,
    status_code         INTEGER,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER,
    prompt_cached_tokens INTEGER,
    cache_creation_tokens INTEGER,
    completion_reasoning_tokens INTEGER,
    duration_ms         INTEGER,
    first_token_ms      INTEGER,
    -- request_uid ties together the rows written by one downstream request's
    -- successive upstream attempts. Every attempt logs its own row, and without
    -- this they were indistinguishable from unrelated requests that happened to
    -- land in the same second.
    request_uid         TEXT,
    -- attempt_index is 0 for a request's first upstream attempt. It is what
    -- tells pre_upstream_ms on a retry apart from the same field on a first
    -- attempt, where the two measure very different intervals.
    attempt_index       INTEGER,
    -- pre_upstream_ms spans from the moment the gateway accepted the request to
    -- the moment this attempt began its upstream call: reading the downstream
    -- body, routing, rate-limit admission, request preparation, and — from
    -- attempt 1 onward — every earlier attempt plus its retry backoff.
    --
    -- Deliberately not named queue_ms. Nothing here waits in a queue, and a
    -- field by that name would invite the console to report a stage that does
    -- not exist.
    pre_upstream_ms     INTEGER,
    -- upstream_headers_ms spans from this attempt's start to the arrival of the
    -- upstream response headers, measured on the same origin as first_token_ms
    -- and duration_ms. It is what separates connect/TLS/upload latency from the
    -- upstream's own thinking time; without it a slow first token could not be
    -- attributed to either.
    upstream_headers_ms INTEGER,
    -- failure_stage names where the attempt broke, because the status alone
    -- cannot: a 502 is written for a failed dial, a body that died mid-read, and
    -- a stream that closed before saying anything. NULL means the attempt
    -- succeeded.
    failure_stage       TEXT,
    -- failure_retryable is the verdict the gateway reached at the time: whether
    -- this failure class is one another channel may be given. Stored rather than
    -- recomputed on read, so editing the retry policy cannot rewrite the history
    -- of why a request stopped after one attempt.
    failure_retryable   INTEGER,
    -- Retired columns from the removed cost-estimation feature. Nothing reads or
    -- writes them: every new row leaves all three NULL.
    --
    -- Kept rather than dropped because rows written while the feature existed hold
    -- real settled amounts, and removing a column in SQLite means rebuilding the
    -- whole table — on what is normally the largest table here, to reclaim three
    -- NULL columns. Left in place so the rebuild is not run for cosmetics.
    cost_micros         INTEGER,
    cost_currency       TEXT,
    pricing_rule_id     INTEGER,
    error               TEXT
);`

// Log bodies are stored by content (see package logbody): a snapshot's
// metadata once per distinct value, its body as chunks each stored once, and
// per log row a record of which chunks make up which body.

// Snapshot metadata — method, url and headers, or status and headers. A gateway
// forwards the same few header sets on most requests: stored per row they took
// 11 MB for 208 distinct values.
const createLogMetas = `
CREATE TABLE IF NOT EXISTS log_metas (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    hash  BLOB NOT NULL UNIQUE,
    size  INTEGER NOT NULL,
    codec INTEGER NOT NULL,
    data  BLOB NOT NULL
);`

// Body chunks. No foreign key points here: a chunk is shared by many bodies,
// and CollectLogChunks removes the ones nothing lists any more. AUTOINCREMENT
// keeps an id from ever naming a second chunk, and lets the collector tell the
// chunks stored after it looked from the ones before.
const createLogChunks = `
CREATE TABLE IF NOT EXISTS log_chunks (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    hash  BLOB NOT NULL UNIQUE,
    size  INTEGER NOT NULL CHECK (size BETWEEN 1 AND 65536),
    codec INTEGER NOT NULL,
    data  BLOB NOT NULL
);`

// A log row's four snapshots by metadata id, NULL where the row has no such
// snapshot. The row lives as long as its log; bodies_cleared marks one whose
// bodies the keep-count policy dropped.
const createRequestLogSnapshots = `
CREATE TABLE IF NOT EXISTS request_log_snapshots (
    request_log_id INTEGER PRIMARY KEY
        REFERENCES request_logs(id) ON DELETE CASCADE,
    downstream_request_meta  INTEGER,
    upstream_request_meta    INTEGER,
    upstream_response_meta   INTEGER,
    downstream_response_meta INTEGER,
    bodies_cleared INTEGER NOT NULL DEFAULT 0
        CHECK (bodies_cleared IN (0, 1))
);`

// A log row's bodies, as a logbody record. Deleting the row is what clears
// the bodies and lets their chunks go; rewriting a smaller value in place, as
// before, left the pages half empty.
const createRequestLogBodies = `
CREATE TABLE IF NOT EXISTS request_log_bodies (
    request_log_id INTEGER PRIMARY KEY
        REFERENCES request_logs(id) ON DELETE CASCADE,
    record BLOB NOT NULL
);`

// Request, failure and token totals per UTC hour, kept apart from the logs so
// retention cannot empty them. hour_start is the hour's first second in unix
// time: 1762257600 is 2025-11-04 12:00:00 UTC.
const createUsageHourly = `
CREATE TABLE usage_hourly (
    hour_start   INTEGER PRIMARY KEY,
    requests     INTEGER NOT NULL DEFAULT 0,
    errors       INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0
);`

// Fills a new usage_hourly from the logs still on disk. Failure is the test
// the overview applies: no status, or one outside 2xx.
const backfillUsageHourly = `
INSERT INTO usage_hourly (hour_start, requests, errors, total_tokens)
SELECT CAST(strftime('%s', created_at) AS INTEGER) / 3600 * 3600 AS hour,
       COUNT(*),
       SUM(CASE WHEN status_code IS NULL OR status_code < 200 OR status_code >= 300
                THEN 1 ELSE 0 END),
       COALESCE(SUM(total_tokens), 0)
FROM request_logs
WHERE strftime('%s', created_at) IS NOT NULL
GROUP BY hour`

const createAPITokens = `
CREATE TABLE IF NOT EXISTS api_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    token       TEXT NOT NULL UNIQUE,
    token_hash  TEXT NOT NULL,
    token_preview TEXT NOT NULL,
    -- The token in the clear, so the console can hand an operator back a
    -- credential it already issued. Nullable and without a UNIQUE constraint
    -- because rows written before this column existed keep it NULL forever —
    -- their plaintext was never kept and cannot be recovered from the digest.
    token_plain TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    -- NULL means the token never expires. Stored in the same
    -- 'YYYY-MM-DD HH:MM:SS' UTC shape as created_at so authentication
    -- can compare it against datetime('now') in SQL.
    expires_at  TEXT,
    -- Running total of tokens this credential has consumed. Maintained here
    -- rather than aggregated from request_logs, because those are pruned by the
    -- retention policy and a quota must not refill when its usage ages out.
    used_tokens  INTEGER NOT NULL DEFAULT 0,
    -- NULL means no limit.
    limit_tokens INTEGER,
    -- A JSON array of the model ids and trailing-* prefixes this credential may
    -- call. '[]' is the one spelling of "no restriction" that writes produce;
    -- NULL means the same thing and is what rows predating the column carry, so
    -- reads fold the two together (see models.ParseAllowedModels).
    --
    -- Matching is exact and case-insensitive, or an explicit trailing wildcard.
    -- It is deliberately stricter than the model matching that picks a channel:
    -- that one also accepts prefixes and suffixes of a channel's model names,
    -- which would admit models this list does not name.
    allowed_models TEXT NOT NULL DEFAULT '[]',
    -- The reset cycle. 'none' is a lifetime total, which is how every token
    -- behaved before these columns and so is the default.
    quota_period TEXT NOT NULL DEFAULT 'none'
        CHECK (quota_period IN ('none', 'daily', 'weekly', 'monthly')),
    -- The IANA zone the period boundary falls in. UTC rather than the host's
    -- local zone: a boundary that moves when the service is redeployed to another
    -- region would reset a quota early or late with nothing to explain it.
    quota_timezone TEXT NOT NULL DEFAULT 'UTC',
    -- The cycle used_tokens was accumulated under, derived from quota_period and
    -- quota_timezone. This is what makes rollover safe without a scheduled job:
    -- usage is applied by an UPDATE that names the period it was earned in, so a
    -- log row arriving after the boundary is added to the period it belongs to or
    -- dropped, never to the new one. Empty string for quota_period = 'none'.
    quota_period_key TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`

// Groups scope which channels a downstream token may reach.
//
// The default group is seeded and protected: a token whose group was deleted
// would otherwise silently reach nothing, so the schema keeps one group that
// always exists.
const createGroups = `
CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`

// DefaultGroupName is the group every channel and token falls back to.
const DefaultGroupName = "default"

// OR IGNORE rather than a named conflict target, because either unique column
// can be the one already taken. Naming only `name` meant a database whose id 1
// belonged to some other group failed Init on the primary key instead, and the
// service could not start to let anyone fix it.
const seedDefaultGroup = `INSERT OR IGNORE INTO groups (id, name, description)
    VALUES (1, 'default', '默认分组')`

// A channel may serve several groups, so membership is a join table. A token
// belongs to exactly one group, which is a column on api_tokens instead.
const createUpstreamGroups = `
CREATE TABLE IF NOT EXISTS upstream_groups (
    upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (upstream_id, group_id)
);`

const createUpstreamGroupsIndex = `CREATE INDEX IF NOT EXISTS idx_upstream_groups_group
    ON upstream_groups(group_id, upstream_id);`

// Existing channels join the default group, so an upgraded database routes
// exactly as it did before groups existed.
const backfillUpstreamGroups = `INSERT INTO upstream_groups (upstream_id, group_id)
    SELECT id, 1 FROM upstreams
    WHERE id NOT IN (SELECT upstream_id FROM upstream_groups)`

// A token with no group would reach no channel at all, so the column is
// backfilled to the default group and kept NOT NULL by the application.
const backfillTokenGroups = `UPDATE api_tokens SET group_id = 1 WHERE group_id IS NULL`

// The cost-estimation feature was removed, and this drops the table it owned.
//
// Unconditional rather than gated on a version marker: DROP TABLE IF EXISTS is
// already idempotent, and an instance that never had the table is the same case
// as one that has already dropped it. Unlike the three retired request_logs
// columns, this is a whole table nothing else references, so removing it costs
// no rebuild.
const dropModelPrices = `DROP TABLE IF EXISTS model_prices`

const dropModelPricesIndex = `DROP INDEX IF EXISTS idx_model_prices_lookup`

// keepCountCheck and maxBytesCheck are the two log limits as their CHECK
// constraints read, shared by the table definition and by the test that tells
// a table still carrying the old, narrower limits.
var (
	keepCountCheck = fmt.Sprintf("log_body_keep_count BETWEEN 1 AND %d", models.MaxLogBodyKeepCount)
	maxBytesCheck  = fmt.Sprintf("log_body_max_bytes BETWEEN 0 AND %d", models.MaxLogBodyMaxBytes)
)

// runtimeSettingsTable defines the settings table under the name it is given:
// Init creates it, and widenRuntimeSettingsLimits builds it under another name
// to replace a table whose constraints SQLite cannot alter in place. It lists
// every column, including those older databases gained through ensureColumn.
func runtimeSettingsTable(name string) string {
	return `
CREATE TABLE IF NOT EXISTS ` + name + ` (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    log_body_keep_count INTEGER NOT NULL CHECK (` + keepCountCheck + `),
    log_retention_days INTEGER NOT NULL CHECK (log_retention_days BETWEEN 1 AND 3650),
    log_body_max_bytes INTEGER NOT NULL CHECK (` + maxBytesCheck + `),
    max_retries INTEGER NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 5),
    same_upstream_retry_interval_ms INTEGER NOT NULL DEFAULT 1000 CHECK (same_upstream_retry_interval_ms BETWEEN 0 AND 60000),
    auto_weight_failure_penalty INTEGER NOT NULL DEFAULT 20 CHECK (auto_weight_failure_penalty BETWEEN 0 AND 100),
    auto_weight_success_increment INTEGER NOT NULL DEFAULT 5 CHECK (auto_weight_success_increment BETWEEN 0 AND 100),
    auto_weight_recovery_increment INTEGER NOT NULL DEFAULT 10 CHECK (auto_weight_recovery_increment BETWEEN 0 AND 100),
    auto_weight_recovery_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (auto_weight_recovery_interval_seconds BETWEEN 1 AND 3600),
    proxy_enabled INTEGER NOT NULL DEFAULT 0 CHECK (proxy_enabled IN (0, 1)),
    proxy_url TEXT NOT NULL DEFAULT '',
    -- The default is weighted because that is what every database written before
    -- this column behaved as. The CHECK is what keeps routing from having to
    -- decide what an unknown strategy means on the hot path.
    load_balance_strategy TEXT NOT NULL DEFAULT 'weighted'
        CHECK (load_balance_strategy IN ('weighted', 'least_latency')),
    default_upstream_timeout_seconds INTEGER NOT NULL DEFAULT 0 CHECK (default_upstream_timeout_seconds BETWEEN 0 AND 3600),
    image_storage_max_mb INTEGER NOT NULL DEFAULT 10240 CHECK (image_storage_max_mb BETWEEN 0 AND 1048576),
    dashboard_multiplier REAL NOT NULL DEFAULT 1 CHECK (dashboard_multiplier > 0 AND dashboard_multiplier <= 1000),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`
}

const seedRuntimeSettings = `INSERT INTO runtime_settings (id, log_body_keep_count, log_retention_days, log_body_max_bytes, revision) VALUES (1, 100, 30, 200000, 1) ON CONFLICT(id) DO NOTHING`
