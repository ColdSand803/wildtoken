package db

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
    extra_headers   TEXT NOT NULL DEFAULT '{}',
    timeout_seconds REAL NOT NULL DEFAULT 300.0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`

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
    -- The cost snapshot. All three are NULL together when no price rule covered
    -- the model, which means "cost unknown" and is distinct from a rule pricing it
    -- at zero. They are a snapshot rather than a reference on purpose: the amount
    -- is fixed at settlement so a later price edit cannot change what an already
    -- served request cost.
    --
    -- cost_micros is an integer count of micro-units of cost_currency. There is no
    -- floating point anywhere in this path.
    cost_micros         INTEGER,
    cost_currency       TEXT,
    -- The model_prices row this amount came from, so the figure can be explained
    -- months later. Not a foreign key: deleting a price version must not erase the
    -- record of what a past request was charged.
    pricing_rule_id     INTEGER,
    error               TEXT
);`

const createRequestLogPayloads = `
CREATE TABLE IF NOT EXISTS request_log_payloads (
    request_log_id INTEGER PRIMARY KEY
        REFERENCES request_logs(id) ON DELETE CASCADE,
    request_snapshot TEXT,
    upstream_request_override TEXT,
    upstream_request_is_override INTEGER NOT NULL DEFAULT 0
        CHECK (upstream_request_is_override IN (0, 1)),
    response_snapshot TEXT,
    downstream_response_override TEXT,
    downstream_response_is_override INTEGER NOT NULL DEFAULT 0
        CHECK (downstream_response_is_override IN (0, 1)),
    bodies_cleared INTEGER NOT NULL DEFAULT 0
        CHECK (bodies_cleared IN (0, 1))
);`

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

// Versioned model prices. A row is never edited: changing a price inserts a new
// version with a later effective_from, and a settled request keeps naming the
// version it was charged under. That is what stops a price edit from rewriting
// bills that were already issued.
//
// Prices are integers — micro-units of the currency per million tokens — because
// a binary float cannot hold 0.1 exactly and a bill accumulated in float64 stops
// equalling the sum of its rows. See internal/models/pricing.go.
const createModelPrices = `
CREATE TABLE IF NOT EXISTS model_prices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Matched exactly and case-insensitively, or by a trailing '*'. Deliberately
    -- stricter than the model matching that picks a channel: that one also
    -- accepts prefixes and suffixes, which would price gpt-4o-mini at gpt-4o's
    -- rate.
    model_pattern   TEXT NOT NULL,
    currency        TEXT NOT NULL CHECK (currency IN ('USD', 'CNY')),
    -- Micro-units per 1,000,000 tokens. Zero is a real price (a free tier or a
    -- dimension the provider does not bill) and is distinct from having no rule,
    -- which means the cost is unknown.
    prompt_micros        INTEGER NOT NULL CHECK (prompt_micros >= 0),
    completion_micros    INTEGER NOT NULL CHECK (completion_micros >= 0),
    cache_read_micros    INTEGER NOT NULL CHECK (cache_read_micros >= 0),
    cache_create_micros  INTEGER NOT NULL CHECK (cache_create_micros >= 0),
    -- 'YYYY-MM-DD HH:MM:SS' UTC, the same fixed-width shape as created_at, so
    -- lexical comparison is chronological comparison.
    effective_from  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`

// Selection reads by pattern and effective_from, which is what the index covers.
const createModelPricesIndex = `CREATE INDEX IF NOT EXISTS idx_model_prices_lookup
    ON model_prices(model_pattern, effective_from);`

const createRuntimeSettings = `
CREATE TABLE IF NOT EXISTS runtime_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    log_body_keep_count INTEGER NOT NULL CHECK (log_body_keep_count BETWEEN 1 AND 10000),
    log_retention_days INTEGER NOT NULL CHECK (log_retention_days BETWEEN 1 AND 3650),
    log_body_max_bytes INTEGER NOT NULL CHECK (log_body_max_bytes BETWEEN 0 AND 1048576),
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
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`

const seedRuntimeSettings = `INSERT INTO runtime_settings (id, log_body_keep_count, log_retention_days, log_body_max_bytes, revision) VALUES (1, 100, 30, 200000, 1) ON CONFLICT(id) DO NOTHING`
