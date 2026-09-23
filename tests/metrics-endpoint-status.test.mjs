import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./react-harness.mjs";
test("monitoring is read-only, not a fake editable switch", () => { const source = read("web/src/pages/SettingsPage.tsx"); const card = source.slice(source.indexOf('className="settings-card metrics-endpoint-card"'), source.indexOf("<h3>运行信息")); assert.match(card, /只读/); for (const field of ["enabled", "path", "token_required"]) assert.ok(card.includes(`metrics_endpoint.${field}`)); assert.doesNotMatch(card, /type="password"|metrics_endpoint.token[},<]/); assert.match(card, /端点状态暂不可用/); });
test("status type contains access policy, not the scrape secret", () => { const shape = /metrics_endpoint: \{([^}]+)\}/.exec(read("web/src/types.ts"))[1]; assert.match(shape, /token_required/); assert.doesNotMatch(shape, /\btoken:/); });
