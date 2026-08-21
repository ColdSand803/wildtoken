import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`)
    : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  // 从签名末尾的 `) {` 起算，否则 `options = {}` 这样的默认参数会先把括号配平。
  const bodyStart = source.indexOf(") {", start);
  assert.notEqual(bodyStart, -1, `${name} must have a body`);
  let depth = 0;
  let seenBody = false;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      seenBody = true;
    } else if (source[i] === "}") {
      depth--;
      if (seenBody && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`could not extract ${name}`);
}

// 首次打开不带 hash 的地址时，switchView 会补写 location.hash，浏览器随后派发
// hashchange。处理器如果无条件再切一次视图，看板就被加载两遍，第二遍的
// loadDashboardData 会 abort 掉第一遍尚在飞的请求。
test("hashchange ignores the hash switchView writes itself", () => {
  const shell = read("static/js/shell.js");
  const models = read("static/js/models.js");

  assert.match(shell, /let activeViewName = null;/, "shell tracks the active view");
  assert.match(shell, /function switchView\(name\) \{\s*\n\s*activeViewName = name;/, "switchView records the view it switched to");
  assert.match(models, /if \(next === activeViewName\) return;/, "hashchange skips a hash that names the current view");

  // 导航链接仍然直接调 switchView，点当前页刷新的行为不能被这次去重顺手改掉。
  assert.match(models, /link\.addEventListener\("click", \(\) => switchView\(link\.dataset\.view\)\)/);
});

test("a bare URL loads the dashboard once instead of twice", () => {
  const shell = read("static/js/shell.js");
  const context = vm.createContext({
    activeViewName: null,
    views: [{ dataset: { view: "dashboard" }, hidden: false }, { dataset: { view: "logs" }, hidden: true }],
    navLinks: [],
    // 真实的 Location 会把赋进来的值规范化成带 # 的形式，switchView 的
    // `location.hash !== \`#${name}\`` 判断依赖这一点。
    location: {
      _hash: "",
      get hash() { return this._hash; },
      set hash(value) {
        this._hash = value && !value.startsWith("#") ? `#${value}` : value;
      },
    },
    document: { documentElement: { dataset: {} }, querySelector: () => null },
    window: { matchMedia: () => ({ matches: false }) },
    dashboardLoads: 0,
    loadDashboardData: () => { context.dashboardLoads++; },
    startDashboardRefresh: () => {},
    stopDashboardRefresh: () => {},
    loadLogs: () => {},
    startLogRefresh: () => {},
    startLogStream: () => {},
    stopLogRefresh: () => {},
    stopLogStream: () => {},
    loadUpstreams: () => {},
    startUpstreamRefresh: () => {},
    startEffectiveWeightTick: () => {},
    stopUpstreamRefresh: () => {},
    stopEffectiveWeightTick: () => {},
    loadTokens: () => {},
    startTokenRefresh: () => {},
    stopTokenRefresh: () => {},
    loadGroups: () => {},
    loadSettingsPage: () => {},
    startSystemUptimeTicker: () => {},
    stopSystemUptimeTicker: () => {},
    currentViewFromHash: () => (context.location.hash.replace("#", "") || "dashboard"),
  });

  vm.runInContext(`${extractFunction(shell, "switchView")}; this.switchView = switchView;`, context);
  // hashchange 处理器的去重条件，和 models.js 里那一处保持一致。
  vm.runInContext(
    "this.onHashChange = function () { const next = currentViewFromHash(); if (next === activeViewName) return; switchView(next); };",
    context,
  );

  // 启动：hash 为空，initApp 走 switchView(currentViewFromHash())。
  context.switchView("dashboard");
  assert.equal(context.location.hash, "#dashboard", "switchView backfills the hash");
  assert.equal(context.dashboardLoads, 1);

  // 那次改写派发的 hashchange 不该再加载一遍。
  context.onHashChange();
  assert.equal(context.dashboardLoads, 1, "the self-written hash does not reload the dashboard");

  // 换到别的视图再回来，仍然要各加载一次。
  context.location.hash = "#logs";
  context.onHashChange();
  context.location.hash = "#dashboard";
  context.onHashChange();
  assert.equal(context.dashboardLoads, 2, "a real navigation still loads the dashboard");
});

// 看板把自己的 signal 透传给 loadUpstreams，下一轮加载会取消上一轮。那条
// AbortError 的 message 是浏览器的默认文案，不该当成加载失败弹给用户。
test("loadUpstreams stays quiet when the dashboard aborts its request", async () => {
  const source = read("static/js/upstreams.js");
  assert.match(source, /if \(error\?\.name === "AbortError"\)/, "loadUpstreams filters AbortError");

  const toasts = [];
  const context = vm.createContext({
    upstreams: [],
    upstreamsLoadedOnce: false,
    upstreamsLoading: false,
    lastUpstreamLoadError: "",
    Date,
    priorityEditorIsOpen: () => false,
    renderRows: () => {},
    renderUpstreamSummary: () => {},
    renderLogFilterOptions: () => {},
    setStatus: (message, tone) => { toasts.push({ message, tone }); },
    api: async () => {
      const error = new Error("signal is aborted without reason");
      error.name = "AbortError";
      throw error;
    },
  });

  vm.runInContext(`${extractFunction(source, "loadUpstreams")}; this.loadUpstreams = loadUpstreams;`, context);
  await context.loadUpstreams({ signal: {} });

  assert.deepEqual(toasts, [], "an aborted request raises no error toast");
  assert.equal(context.upstreamsLoading, false, "the loading flag is still cleared");

  // 真正的失败仍然要报出来。
  vm.runInContext("this.api = async () => { throw new Error('500 Internal Server Error'); };", context);
  await context.loadUpstreams();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].tone, "error");
  assert.match(toasts[0].message, /加载失败：500 Internal Server Error/);
});
