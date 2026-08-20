import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notEqual(start, -1, name + " 不在源码里");
  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;

  let paramDepth = 0;
  let paramEnd = -1;
  for (let i = start + ("function " + name).length; i < source.length; i += 1) {
    if (source[i] === "(") paramDepth += 1;
    else if (source[i] === ")") {
      paramDepth -= 1;
      if (paramDepth === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", paramEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(declarationStart, index + 1);
      }
    }
  }
  throw new Error(name + " 的函数体没有闭合");
}

/* 极简的勾选框替身：只需要 dataset / checked / closest 三样。 */
function fakeCheck(id, checked, card) {
  return {
    dataset: { upstreamCheck: String(id) },
    checked,
    closest: (selector) => (selector === ".channel-card" ? card || null : null),
  };
}

function fakeScope(checks) {
  return { querySelectorAll: () => checks };
}

function fakeCard() {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
  };
}

function selectionContext(overrides) {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({
    selectedUpstreamIds: new Set(),
    rows: fakeScope([]),
    upstreamCardsContainer: null,
    batchActionsEl: null,
    batchEnableBtn: null,
    batchDisableBtn: null,
    upstreamSelectAll: null,
    upstreamSelectionCountEl: null,
    upstreamSelectVisibleBtn: null,
    upstreamClearSelectionBtn: null,
    getFilteredUpstreams: () => [],
    ...overrides,
  });
  for (const name of [
    "syncUpstreamCheckboxes",
    "updateBatchToolbar",
    "toggleUpstreamSelection",
    "setUpstreamSelectionForFiltered",
  ]) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return context;
}

test("batch toolbar is always visible so grid view has somewhere to select from", () => {
  const markup = read("static/admin.html");
  const start = markup.indexOf('id="upstream-batch-actions"');
  assert.notEqual(start, -1, "批量工具栏还在");

  const openTag = markup.slice(markup.lastIndexOf("<div", start), markup.indexOf(">", start) + 1);
  // 表头的全选框在卡片视图下是 display:none 的，工具栏再藏起来就无从下手了。
  assert.ok(!openTag.includes("hidden"), "工具栏不再默认隐藏：" + openTag);

  assert.ok(markup.includes('id="upstream-selection-count"'), "有已选计数");
  assert.ok(markup.includes('id="upstream-select-visible"'), "有全选按钮");
  assert.ok(markup.includes('id="upstream-clear-selection"'), "有清空按钮");
  // 零选中时按钮先置灰，而不是点了没反应。
  assert.ok(/id="batch-enable"[^>]*disabled/.test(markup), "批量启用初始禁用");
  assert.ok(/id="batch-disable"[^>]*disabled/.test(markup), "批量停用初始禁用");
});

test("channel cards carry the same data-upstream-check contract as table rows", () => {
  const source = read("static/js/upstreams.js");
  const card = source.slice(
    source.indexOf("function createChannelCard("),
    source.indexOf("async function hydrateVisibleCardStats("),
  );

  // 两个视图共用一个属性，选择逻辑才只有一份。
  assert.ok(card.includes('class="channel-card-check"'), "卡片有勾选框");
  assert.ok(card.includes('data-upstream-check="${upstream.id}"'), "复用表格那套属性");
  assert.ok(card.includes('selectedUpstreamIds.has(upstream.id) ? "checked" : ""'), "重渲染后保持勾选");
  assert.ok(card.includes("channel-card--selected"), "选中的卡片有视觉标记");
  assert.ok(card.includes("aria-label=\"选择渠道 ${escapeHtml(upstream.name)}\""), "勾选框有可读名字");

  const css = read("static/css/components.css");
  assert.ok(css.includes(".channel-card--selected"), "选中态样式");
  assert.ok(css.includes(".channel-card-check"), "勾选框样式");
});

test("card clicks on the checkbox do not fall through to the card action delegation", () => {
  const source = read("static/js/upstreams.js");
  const delegation = source.slice(source.indexOf('upstreamCardsContainer.addEventListener("click"'));
  const guard = delegation.indexOf('input[data-upstream-check]');
  const firstAction = delegation.indexOf('button[data-empty-action]');

  assert.notEqual(guard, -1, "点击代理要放过勾选框");
  assert.ok(guard < firstAction, "放行必须在任何动作分支之前");
  assert.ok(
    source.includes('upstreamCardsContainer.addEventListener("change"'),
    "卡片容器要监听 change 才能收到勾选",
  );
});

test("both views write selection through the same toggle helper", () => {
  const modelsSource = read("static/js/models.js");
  const upstreamsSource = read("static/js/upstreams.js");

  assert.ok(modelsSource.includes("toggleUpstreamSelection("), "表格走公共入口");
  assert.ok(
    upstreamsSource.includes("toggleUpstreamSelection(Number(check.dataset.upstreamCheck), check.checked)"),
    "卡片走同一个公共入口",
  );
  // 选择状态只应有一处真源。
  assert.ok(!modelsSource.includes("selectedUpstreamIds.add("), "models.js 不再自己改集合");
});

test("toggleUpstreamSelection adds, removes and ignores non-numeric ids", () => {
  const context = selectionContext({});

  context.toggleUpstreamSelection(3, true);
  assert.deepEqual([...context.selectedUpstreamIds], [3]);

  context.toggleUpstreamSelection(3, false);
  assert.equal(context.selectedUpstreamIds.size, 0);

  // data-upstream-check 缺失时 Number("") 是 0、Number(undefined) 是 NaN。
  context.toggleUpstreamSelection(Number.NaN, true);
  assert.equal(context.selectedUpstreamIds.size, 0, "NaN 不该进集合");
});

test("setUpstreamSelectionForFiltered only touches the current filter result", () => {
  const context = selectionContext({
    getFilteredUpstreams: () => [{ id: 1 }, { id: 2 }],
  });
  context.selectedUpstreamIds.add(9);

  context.setUpstreamSelectionForFiltered(true);
  assert.deepEqual([...context.selectedUpstreamIds].sort(), [1, 2, 9]);

  context.setUpstreamSelectionForFiltered(false);
  assert.deepEqual([...context.selectedUpstreamIds], [9], "筛选之外的选择不受影响");
});

test("updateBatchToolbar reports the count and gates the buttons on it", () => {
  const countEl = { textContent: "" };
  const enableBtn = { disabled: false };
  const disableBtn = { disabled: false };
  const clearBtn = { disabled: false };
  const selectVisibleBtn = { disabled: false };
  const toolbar = { hidden: true };
  const selectAll = { checked: false, indeterminate: false };

  const context = selectionContext({
    batchActionsEl: toolbar,
    batchEnableBtn: enableBtn,
    batchDisableBtn: disableBtn,
    upstreamSelectAll: selectAll,
    upstreamSelectionCountEl: countEl,
    upstreamSelectVisibleBtn: selectVisibleBtn,
    upstreamClearSelectionBtn: clearBtn,
    getFilteredUpstreams: () => [{ id: 1 }, { id: 2 }],
  });

  context.updateBatchToolbar();
  assert.equal(toolbar.hidden, false, "工具栏常驻");
  assert.equal(countEl.textContent, "未选择渠道");
  assert.equal(enableBtn.disabled, true);
  assert.equal(disableBtn.disabled, true);
  assert.equal(clearBtn.disabled, true);
  assert.equal(selectVisibleBtn.disabled, false, "还有没选的，全选可用");
  assert.equal(selectAll.checked, false);
  assert.equal(selectAll.indeterminate, false);

  context.selectedUpstreamIds.add(1);
  context.updateBatchToolbar();
  assert.equal(countEl.textContent, "已选 1 个");
  assert.equal(enableBtn.disabled, false);
  assert.equal(clearBtn.disabled, false);
  assert.equal(selectAll.indeterminate, true, "选了一部分是半选态");

  context.selectedUpstreamIds.add(2);
  context.updateBatchToolbar();
  assert.equal(countEl.textContent, "已选 2 个");
  assert.equal(selectAll.checked, true);
  assert.equal(selectAll.indeterminate, false);
  assert.equal(selectVisibleBtn.disabled, true, "全选完就没得选了");
});

test("syncUpstreamCheckboxes drives table rows and cards from one set", () => {
  const card1 = fakeCard();
  const card2 = fakeCard();
  const rowCheck = fakeCheck(1, false, null);
  const cardCheck1 = fakeCheck(1, false, card1);
  const cardCheck2 = fakeCheck(2, true, card2);

  const context = selectionContext({
    rows: fakeScope([rowCheck]),
    upstreamCardsContainer: fakeScope([cardCheck1, cardCheck2]),
    getFilteredUpstreams: () => [{ id: 1 }, { id: 2 }],
  });
  context.selectedUpstreamIds.add(1);

  context.syncUpstreamCheckboxes();

  assert.equal(rowCheck.checked, true, "表格行跟上集合");
  assert.equal(cardCheck1.checked, true, "卡片跟上集合");
  assert.equal(card1.classList.contains("channel-card--selected"), true);
  assert.equal(cardCheck2.checked, false, "没在集合里的卡片被取消勾选");
  assert.equal(card2.classList.contains("channel-card--selected"), false);
});

test("export scope copy tells the user both views can select", () => {
  const source = read("static/js/upstreams.js");
  assert.ok(
    source.includes("勾选渠道（列表或卡片模式均可）"),
    "导出提示不能再只提表格行",
  );
  assert.ok(!source.includes("勾选表格行"), "旧文案已替换");
});
