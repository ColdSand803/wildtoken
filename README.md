# WildToken

WildToken 是一个 Rust 版 OpenAI 兼容 LLM API 中转服务，监听 `3100` 端口。它向下游暴露 `/v1/*` API，并按渠道配置把请求转发到不同上游服务。

## 启动

本地开发：

```bash
cargo run
```

Docker：

```bash
docker compose up -d --build
```

管理界面：

```text
http://127.0.0.1:3100/admin
```

管理界面和管理接口（`/api/admin/*`）需要 Admin Token。可以从 `.env.example` 复制一份 `.env`，设置 `ADMIN_TOKEN`。下游 API 令牌在管理界面的「令牌」页创建和管理。

## 配置

默认配置在 `config/default.toml`：

```toml
[server]
host = "0.0.0.0"
port = 3100

[database]
url = "sqlite:wildtoken.db?mode=rwc"
```

也可以用环境变量覆盖，例如：

```bash
APP__SERVER__PORT=3100 DATABASE_URL='sqlite:wildtoken.db?mode=rwc' cargo run
```

为兼容旧配置，`.env` 里的 `ADMIN_TOKEN`、`DATABASE_URL` 也会被读取。

## 路由规则

请求会按以下顺序选择渠道：

1. `X-WildToken-Upstream` 请求头或 `?upstream=` 查询参数指定渠道名称/ID。
2. JSON 请求体里的 `model` 优先匹配渠道的模型映射。
3. 其次匹配模型前缀、模型名前缀、模型名后缀。
4. 使用已启用渠道中 `priority` 最大的一组，同优先级随机选择。

如果渠道配置了 API Key，WildToken 会把转发请求的 `Authorization` 改为该渠道的 Key。请求体、路径、查询参数和方法会按原样转发；如果配置了模型映射，转发时会重写请求体中的 `model`。

调用 `/v1/*` 需要携带令牌管理页中启用的下游令牌。

## 下游调用示例

```bash
curl http://127.0.0.1:3100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

强制指定渠道：

```bash
curl http://127.0.0.1:3100/v1/models \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>' \
  -H 'X-WildToken-Upstream: openai'
```
