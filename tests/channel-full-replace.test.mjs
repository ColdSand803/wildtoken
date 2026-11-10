/* 渠道更新是整体替换：后端按 PUT 全量覆盖，请求体里漏掉的字段会被清空。
   所以任何只想改一两项的操作，都必须把其余配置原样回填。

   只改模型的「拉取模型」已并进编辑抽屉，走完整表单保存，不再手拼请求体；
   这里留下的是另一处手拼的地方：删除后的撤销。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("web/src/pages/UpstreamsPage.tsx");

test("删除撤销的重建 payload 覆盖整张渠道配置", () => {
  const start = source.indexOf("snapshot = await getUpstream");
  assert.notEqual(start, -1, "删除前必须先取快照");
  const block = source.slice(start, source.indexOf("} catch (err)", start));

  assert.match(
    block,
    /const \{ id: _id, api_key_set: _set, \.\.\.rest \} = snapshot/,
    "撤销应整份解构快照，而不是逐字段挑",
  );
  // 快照来自详情接口，整份交给重建；归档的渠道带上归档前的启用状态。
  assert.match(block, /createUpstream\(\{\s*\.\.\.rest,/);
  assert.match(block, /snapshot\.enabled_before_archive/);
  // 详情不带 key 的值：删之前逐把取回，重建时作为新 key 带上。
  assert.match(block, /snapshotKeys = await revealAllKeys\(snapshot\)/);
  assert.match(block, /keys: snapshotKeys\.map\(\(key\) => \(\{ id: 0, \.\.\.key \}\)\)/);
});
