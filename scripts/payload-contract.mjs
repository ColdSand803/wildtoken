#!/usr/bin/env node
/**
 * 请求体字段契约检查。
 *
 * 后端多处用 decodeStrictJSON：多一个字段、少一个必填、名字拼错，整个请求
 * 直接 400，而界面上只会看到一句「保存失败」。本会话已经踩过三次——保存设置
 * 多发 updated_at、导出漏发 include_api_keys、令牌限额发成 limit_tokens。
 *
 * 这里把 React 实际发出去的键和 Go 结构体的 json tag 逐个对上，防第四次。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(`${ROOT}${file}`, "utf8");

/** 取出 Go 结构体的所有 json tag，忽略 `-` 和 omitempty 后缀。 */
function goFields(source, typeName) {
  const start = source.indexOf(`type ${typeName} struct {`);
  if (start === -1) throw new Error(`找不到结构体 ${typeName}`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);

  const fields = new Set();
  for (const match of body.matchAll(/`json:"([^"]+)"`/g)) {
    const name = match[1].split(",")[0];
    if (name && name !== "-") fields.add(name);
  }
  return fields;
}

/**
 * 取出一个 TS 对象字面量里的顶层键。
 *
 * 只扫大括号深度为 1 的 `key:`，嵌套对象里的键不算——它们属于别的层。
 */
function tsKeys(source, marker, { after = "{" } = {}) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`找不到标记 ${marker}`);

  /* after 定位到真正的请求体。从函数签名的第一个 { 开始切的话，取到的是
     参数解构，不是发出去的键。 */
  const anchor = source.indexOf(after, start);
  if (anchor === -1) throw new Error(`${marker} 里找不到 ${after}`);
  const open = source.indexOf("{", anchor + after.length - 1);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  /* 按字符扫而不是按行：类型签名常写成单行（payload: { name: string;
     description: string }），按行只能取到第一个键。 */
  const body = source.slice(open + 1, end);
  const keys = new Set();
  let level = 0;
  let atKeyPosition = true;
  let token = "";

  for (const char of body) {
    if (char === "{" || char === "[" || char === "(") level += 1;
    else if (char === "}" || char === "]" || char === ")") level -= 1;

    if (level === 0 && char === ":" && atKeyPosition) {
      const name = token.trim();
      if (/^[a-z_][a-z0-9_]*$/i.test(name)) keys.add(name);
      atKeyPosition = false;
      token = "";
      continue;
    }
    // 逗号和分号都是一项的结束：对象字面量用逗号，类型签名用分号。
    if (level === 0 && (char === "," || char === ";" || char === "\n")) {
      atKeyPosition = true;
      token = "";
      continue;
    }
    if (atKeyPosition) token += char;
  }
  return keys;
}

const api = read("web/src/api.ts");
const upstreamDialog = read("web/src/components/UpstreamDialog.tsx");
const tokenDialog = read("web/src/components/TokenDialog.tsx");

const models = {
  upstream: read("internal/models/upstream.go"),
  token: read("internal/models/token.go"),
  group: read("internal/models/group.go"),
  settings: read("internal/models/settings.go"),
  requestlog: read("internal/models/requestlog.go"),
};

/* 每条：前端实际发的键集合，对上后端结构体。
   allowMissing 是后端有、前端可以不发的可选字段。 */
const contracts = [
  {
    name: "渠道创建/更新 UpstreamIn",
    keys: tsKeys(upstreamDialog, "function payloadFromForm", { after: "return {" }),
    fields: goFields(models.upstream, "UpstreamIn"),
    // clear_api_key 在 UpstreamUpdateIn 上，创建时后端也收。
    extraAllowed: new Set(["clear_api_key"]),
  },
  {
    name: "令牌创建 APITokenIn",
    keys: tsKeys(tokenDialog, "export interface TokenPayload"),
    fields: goFields(models.token, "APITokenIn"),
    allowMissing: new Set(["token"]),
  },
  {
    name: "分组 GroupIn",
    // 请求体是直接透传的参数对象，键在类型签名里。
    keys: tsKeys(api, "export function createGroup", { after: "payload: {" }),
    fields: goFields(models.group, "GroupIn"),
  },
  {
    name: "运行时设置 RuntimeSettingsIn",
    keys: tsKeys(api, "export function saveSettings", { after: "JSON.stringify({" }),
    fields: goFields(models.settings, "RuntimeSettingsIn"),
  },
  {
    name: "模型预览 ModelFetchIn",
    keys: tsKeys(api, "export function fetchModelsPreview", { after: "JSON.stringify({" }),
    fields: goFields(models.requestlog, "ModelFetchIn"),
  },
  {
    name: "渠道导出 ExportUpstreamsRequest",
    keys: tsKeys(api, "export function exportUpstreams", { after: "JSON.stringify({" }),
    fields: goFields(models.upstream, "ExportUpstreamsRequest"),
    allowMissing: new Set(["ids"]),
  },
  {
    name: "模型测试 ModelTestRequest",
    // 请求体是直接透传的 body 参数，键在类型签名里。
    keys: tsKeys(api, "export function testUpstreamModel", { after: "body: {" }),
    fields: goFields(models.settings, "ModelTestRequest"),
  },
];

let failed = 0;
for (const contract of contracts) {
  const extraAllowed = contract.extraAllowed ?? new Set();
  const allowMissing = contract.allowMissing ?? new Set();

  const unknown = [...contract.keys].filter(
    (key) => !contract.fields.has(key) && !extraAllowed.has(key),
  );
  const missing = [...contract.fields].filter(
    (field) => !contract.keys.has(field) && !allowMissing.has(field),
  );

  if (unknown.length === 0 && missing.length === 0) {
    console.log(`  ✔ ${contract.name}`);
    continue;
  }
  failed += 1;
  console.log(`  ✘ ${contract.name}`);
  // 多发的字段最危险：严格解码会直接 400 掉整个请求。
  if (unknown.length > 0) console.log(`      后端不认识：${unknown.join(", ")}`);
  if (missing.length > 0) console.log(`      前端没发：${missing.join(", ")}`);
}

console.log(`\n${contracts.length - failed}/${contracts.length} 条契约对上`);
if (failed > 0) process.exitCode = 1;
