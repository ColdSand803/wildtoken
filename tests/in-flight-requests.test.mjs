import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const ADMIN_SOURCE = "internal/handlers/admin.go";
const LOGS_SOURCE = "static/js/logs.js";

/** 日志表头声明的列，进行中的行必须逐列对齐。 */
function logTableColumns() {
  const markup = read("static/admin.html");
  const start = markup.indexOf('<table class="admin-table log-table" id="log-table">');
  assert.notEqual(start, -1, "日志表必须存在");
  const head = markup.slice(start, markup.indexOf("</thead>", start));
  const columns = [...head.matchAll(/<th[^>]*data-col="([a-z-]+)"/g)].map((match) => match[1]);
  assert.notEqual(columns.length, 0, "表头必须声明列");
  return columns;
}

/** createActiveLogRow 里逐个单元格的 data-col。 */
function activeRowColumns() {
  const source = read(LOGS_SOURCE);
  const start = source.indexOf("function createActiveLogRow(");
  assert.notEqual(start, -1, "进行中的行必须有构造函数");
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/<td[^>]*data-col="([a-z-]+)"/g)].map((match) => match[1]);
}

test("进行中的行与日志表头逐列对齐", () => {
  // 列数或顺序错位不会报错，只会让某一列的内容整体串到隔壁。
  assert.deepEqual(activeRowColumns(), logTableColumns());
});

test("进行中的行与日志行共用同一套单元格渲染", () => {
  /* 思考强度这一列最初被写死成 "-"，因为登记表没带这两个字段。共用同一个渲染
     函数就不会再出现某一列在两种行之间各写一套、然后悄悄分叉。 */
  const source = read(LOGS_SOURCE);
  const activeRow = source.slice(
    source.indexOf("function createActiveLogRow("),
    source.indexOf("function updateActiveElapsedCells("),
  );
  for (const renderer of [
    "renderLogReasoningEffort",
    "renderLogModel",
    "formatLogToken",
  ]) {
    assert.match(activeRow, new RegExp(`${renderer}\\(request\\)`), `应复用 ${renderer}`);
  }
  // 写死的占位符意味着某一列又被放弃了。
  assert.doesNotMatch(activeRow, /data-col="reasoning"><span class="muted">-<\/span>/);
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
  const source = read(LOGS_SOURCE);
  assert.match(source, /logActiveTotal = counted === null \? logActiveRequests\.length : counted/);
  assert.match(source, /updateLogRateValue\("concurrency", logActiveTotal\)/);

  // 服务端两条路径都得带上总数。
  const handler = read(ADMIN_SOURCE);
  assert.match(handler, /"total":\s+snapshot\.Total/);
  assert.match(handler, /ActiveTotal: activeTotal/);
  assert.match(source, /setLogActiveRequests\(page\.active \|\| \[\], page\.active_total\)/);
});

test("占位行的 colspan 等于表头列数", () => {
  const source = read(LOGS_SOURCE);
  const declared = Number(/LOG_TABLE_COLUMN_COUNT = (\d+)/.exec(source)?.[1]);
  assert.equal(declared, logTableColumns().length, "列数常量与表头脱节");

  /* 空态、无匹配、骨架行都要横跨整表；写死的数字漏改一处就会差一列。 */
  for (const helper of ["skeletonRowsMarkup", "noMatchStateCell", "emptyStateCell"]) {
    assert.match(
      source,
      new RegExp(`${helper}\\(LOG_TABLE_COLUMN_COUNT`),
      `${helper} 应使用列数常量而非字面量`,
    );
  }
});

test("计时刷新率跟得上显示精度", () => {
  const source = read(LOGS_SOURCE);

  const tickMs = Number(/LOG_ACTIVE_TICK_MS = (\d+)/.exec(source)?.[1]);
  assert.ok(Number.isFinite(tickMs), "刷新间隔必须是常量");

  const digits = Number(/toFixed\((\d+)\)\}s`/.exec(
    source.slice(source.indexOf("function formatActiveElapsed(")),
  )?.[1]);
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
  assert.match(read(LOGS_SOURCE), /event\.type === "active"/);
});

test("在途请求只在最新一页出现", () => {
  const handler = read(ADMIN_SOURCE);
  // 游标页和偏移页都没有在途请求的位置：它们不属于任何一段历史。
  assert.match(handler, /if cursor == nil && offset == 0 \{\n\t\t\tsnapshot := state\.ActiveRequests\.Snapshot\(\)/);
  assert.match(read(LOGS_SOURCE), /if \(!isOnLatestLogPage\(\)\) return \[\];/);
});

test("登记项在响应送完之后才释放", () => {
  // 放在 disarm 里就会让流式回答在推送途中从列表上消失——而那正是最该看见它的时候。
  const handler = read("internal/handlers/proxy.go");
  const finish = handler.slice(
    handler.indexOf("func (g *abortLogGuard) finish()"),
    handler.indexOf("func (g *abortLogGuard) elapsed()"),
  );
  assert.match(finish, /g\.active\.Release\(\)/);

  const disarm = handler.slice(
    handler.indexOf("func (g *abortLogGuard) disarm()"),
    handler.indexOf("// logAndDisarm"),
  );
  assert.doesNotMatch(disarm, /Release\(\)/);
});
