import assert from "node:assert/strict";
import test from "node:test";
import { read, loadTS } from "./react-harness.mjs";
const page = read("web/src/pages/UpstreamsPage.tsx");
test("cards and table use the same filtered, sorted channel collection", () => { assert.match(page, /view === "grid"/); assert.equal((page.match(/filtered.map\(\(upstream\)/g) ?? []).length, 2); assert.match(page, /\.sort\(compareUpstreams\(sort\)\)/); });
test("archive stays separate and searchable without joining active routing", () => { assert.match(page, /const active = upstreams.filter\(\(u\) => !u.archived\)/); assert.match(page, /u.archived && matchesQuery\(u\)/); assert.match(page, /hidden=\{!archivedOpen\}/); });
test("channel URLs reject executable schemes", () => { const { httpUrlOrNull } = loadTS("web/src/pages/UpstreamsPage.tsx", { expose: ["httpUrlOrNull"] }); assert.equal(httpUrlOrNull("javascript:alert(1)"), null); assert.equal(httpUrlOrNull("https://example.test/v1"), "https://example.test/v1"); });
test("diagnostics do not hide selection or the channel action toolbar", () => { for (const text of ["<ChannelDiagnostics", "toolbar-actions", "toolbar-batch", "upstream-select-visible"]) assert.ok(page.includes(text)); assert.match(read("web/src/components/ChannelCard.tsx"), /<ActionMenu/); });
