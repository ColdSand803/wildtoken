// 在途请求：控制台怎么显示，服务端怎么登记与释放。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const ADMIN_SOURCE = "internal/handlers/admin.go";
const LOGS_SOURCE = "web/src/pages/LogsPage.tsx";

/** 日志表头声明的列。 */
function logTableColumns() {
  const source = read(LOGS_SOURCE);
  const head = source.slice(source.indexOf("<thead>"), source.indexOf("</thead>"));
  const columns = [...head.matchAll(/data-col="([a-z-]+)"/g)].map((match) => match[1]);
  assert.notEqual(columns.length, 0, "表头必须声明列");
  return columns;
}

/** 在途行逐个单元格的 data-col。 */
function activeRowColumns() {
  const source = read(LOGS_SOURCE);
  const start = source.indexOf("active.map((request) =>");
  assert.notEqual(start, -1, "在途行必须有渲染分支");
  const body = source.slice(start, source.indexOf("</tr>", start));
  return [...body.matchAll(/data-col="([a-z-]+)"/g)].map((match) => match[1]);
}

test("进行中的行与日志表头逐列对齐", () => {
  // 列数或顺序错位不会报错，只会让某一列的内容整体串到隔壁。
  assert.deepEqual(activeRowColumns(), logTableColumns());
});

test("进行中的行与日志行共用同一套单元格渲染", () => {
  /* 思考强度这一列最初被写死成 "-"，因为登记表没带这两个字段。共用同一个
     渲染组件就不会再出现某一列在两种行之间各写一套、然后悄悄分叉。 */
  const source = read(LOGS_SOURCE);
  const start = source.indexOf("active.map((request) =>");
  const activeRow = source.slice(start, source.indexOf("</tr>", start));

  for (const renderer of ["ReasoningCell", "ModelCell", "TokenCell", "ChannelStack"]) {
    assert.match(activeRow, new RegExp(`<${renderer}\\b`), `应复用 ${renderer}`);
  }
  // 写死的占位符意味着某一列又被放弃了。
  assert.doesNotMatch(
    activeRow,
    /data-col="reasoning">\s*<span className="muted">-<\/span>/,
    "思考强度列不该退回写死的占位符",
  );
});

test("在途登记与 abort 日志从同一处取走 prepared 的全部字段", () => {
  // 两者同源；分开取就是上一次漏掉思考强度的原因。
  const handler = read("internal/handlers/proxy.go");
  const setter = handler.slice(
    handler.indexOf("func (g *abortLogGuard) setPreparedRequest("),
    handler.indexOf("// disarm gives up ownership"),
  );
  assert.match(setter, /g\.active\.SetReasoningEffort\(/);
  assert.match(setter, /g\.entry\.ReasoningEffort = prepared\.ReasoningEffort/);
  assert.match(setter, /g\.entry\.UpstreamReasoningEffort = prepared\.UpstreamReasoningEffort/);
});

test("并发胶囊读总数，不是被截断的列表长度", () => {
  /* 列表封顶 ActiveSnapshotLimit，计数不封顶。读长度的话，并发超过上限后
     胶囊会死在上限值上。 */
  assert.match(read(LOGS_SOURCE), /active_total/);

  // 服务端两条路径都得带上总数。
  const handler = read(ADMIN_SOURCE);
  assert.match(handler, /"total":\s+snapshot\.Total/);
  assert.match(handler, /ActiveTotal: activeTotal/);
});

/* 空态和加载态都要横跨整表。写死的数字漏改一处就会差一列——加 IP 列时正是
   这样漏的。 */
test("占位行的 colspan 等于表头列数", () => {
  const source = read(LOGS_SOURCE);
  const declared = Number(/LOG_TABLE_COLUMN_COUNT = (\d+)/.exec(source)?.[1]);
  assert.equal(declared, logTableColumns().length, "列数常量与表头脱节");

  const spans = [...source.matchAll(/colSpan=\{([^}]+)\}/g)].map((match) => match[1]);
  assert.notEqual(spans.length, 0, "占位行必须存在");
  for (const span of spans) {
    assert.equal(span, "LOG_TABLE_COLUMN_COUNT", "占位行应使用列数常量而非字面量");
  }
});

test("计时刷新率跟得上显示精度", () => {
  const ticker = read("web/src/useTicker.ts");

  const tickMs = Number(/TICK_MS = (\d+)/.exec(ticker)?.[1]);
  assert.ok(Number.isFinite(tickMs), "刷新间隔必须是常量");

  const digits = Number(/toFixed\((\d+)\)/.exec(ticker)?.[1]);
  assert.ok(Number.isFinite(digits), "耗时格式必须声明小数位");

  /* 两个数字各写各的就会悄悄分叉：曾经是每秒刷一次配 0.1s 精度，小数位
     永远停在同一个数字上。刷新间隔不得大于最小可见刷新单位。 */
  const smallestVisibleStepMs = 1000 / 10 ** digits;
  assert.ok(
    tickMs <= smallestVisibleStepMs,
    `显示到 ${digits} 位小数（步长 ${smallestVisibleStepMs}ms），刷新间隔 ${tickMs}ms 太慢`,
  );
});

test("服务端发的事件名就是控制台监听的那个", () => {
  // 两边各写一次字符串，对不上就是静默失效：连接正常，行永远不出现。
  assert.match(read(ADMIN_SOURCE), /"event: active\\ndata: %s\\n\\n"/);
  assert.match(read("web/src/useLogStream.ts"), /"active"/);
});

test("在途请求只在最新一页出现", () => {
  const handler = read(ADMIN_SOURCE);
  // 游标页和偏移页都没有在途请求的位置：它们不属于任何一段历史。
  assert.match(
    handler,
    /if cursor == nil && offset == 0 \{\n\t\t\tsnapshot := state\.ActiveRequests\.Snapshot\(\)/,
  );
});

test("登记项在响应送完之后才释放", () => {
  // 放在 disarm 里就会让流式回答在推送途中从列表上消失——而那正是最该看见它的时候。
  const handler = read("internal/handlers/proxy.go");
  const finish = handler.slice(handler.indexOf("func (g *abortLogGuard) finish("));
  assert.match(finish.slice(0, 400), /g\.active\.Release\(\)/);
  // disarm 只放弃日志所有权，不能顺手把登记项也摆了。
  const disarm = handler.slice(handler.indexOf("func (g *abortLogGuard) disarm("));
  assert.doesNotMatch(disarm.slice(0, 300), /g\.active\.Release\(\)/);
});
