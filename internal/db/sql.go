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
    enabled     INTEGER NOT NULL DEFAULT 1,
    -- NULL means the token never expires. Stored in the same
    -- 'YYYY-MM-DD HH:MM:SS' UTC shape as created_at so authentication
    -- can compare it against datetime('now') in SQL.
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`

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
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`

const seedRuntimeSettings = `INSERT INTO runtime_settings (id, log_body_keep_count, log_retention_days, log_body_max_bytes, revision) VALUES (1, 100, 30, 200000, 1) ON CONFLICT(id) DO NOTHING`

const createModelTestTemplatesTable = `
CREATE TABLE model_test_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    request_kind TEXT NOT NULL CHECK (request_kind IN ('responses', 'chat_completions', 'messages')),
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`

const createModelTestTemplates = `
CREATE TABLE IF NOT EXISTS model_test_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    request_kind TEXT NOT NULL CHECK (request_kind IN ('responses', 'chat_completions', 'messages')),
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`

// The original defaults are renamed before reseeding, so the INSERT below does
// not create duplicate rows alongside un-migrated 'Codex' / 'OpenCode' rows.
const renameCodexTemplate = `UPDATE model_test_templates SET name = 'codex-tui', updated_at = datetime('now') WHERE name = 'Codex'`

const renameOpenCodeTemplate = `UPDATE model_test_templates SET name = 'opencode', updated_at = datetime('now') WHERE name = 'OpenCode'`

const seedModelTestTemplates = `INSERT INTO model_test_templates (name, request_kind, prompt)
VALUES
    ('codex-tui', 'responses', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。'),
    ('opencode', 'chat_completions', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。'),
    ('claude-cli', 'messages', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。')
ON CONFLICT(name) DO NOTHING`

// Only the original short defaults are upgraded; administrator-customized
// templates remain untouched.
const upgradeShortDefaultTemplates = `UPDATE model_test_templates
SET prompt = '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。', updated_at = datetime('now')
WHERE name IN ('codex-tui', 'opencode') AND prompt IN ('Reply with exactly: WildToken test passed.', '请用中文完成一次简短的连通性测试。先说明你已收到请求，再用两句话概括：当前模型名称、你能提供的主要能力。不要使用 Markdown 表格，不要调用工具，不要编造外部信息。最后单独输出“WildToken 模型测试通过”，并确保总回复不超过 120 个汉字。')`
