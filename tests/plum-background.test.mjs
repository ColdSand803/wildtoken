import { readFileSync, readdirSync, existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const repo = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(repo(path), "utf8").replace(/\r\n/g, "\n");
const themePacks = () => readdirSync(repo("themes"))
  .filter((name) => existsSync(repo(`themes/${name}/theme.css`)));

const plum = read("static/js/plum.js");
const html = read("static/admin.html");

/* 这些数字决定了长出来的形状，动一个就不是 antfu 那棵梅了。移植的价值全在照搬，
   所以逐个钉住。 */
test("生长参数与 ArtPlum 原件一致", () => {
  const expected = {
    "PLUM_MIN_BRANCH": "30",
    "PLUM_STEP_LEN": "6",
    "PLUM_R15": "Math.PI / 12",
    "PLUM_FRAME_MS": "1000 / 40",
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.match(plum, new RegExp(`const ${name} = ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`),
      `${name} 应当是 ${value}`);
  }
  // 头 30 段 0.8、之后 0.5；每步一半概率留到下一帧。
  assert.match(plum, /counter\.value <= PLUM_MIN_BRANCH \? 0\.8 : 0\.5/);
  assert.match(plum, /Math\.random\(\) < 0\.5\) plumSteps\.push\(run\)/);
  // 越界的 100px 宽容，四个方向都要有。
  assert.equal((plum.match(/[-+ ]100/g) || []).length >= 4, true,
    "越界判断应当四个方向都留 100px 宽容");
  // 起点落在边的中段 0.2–0.8，窄窗口只留两枝。
  assert.match(plum, /Math\.random\(\) \* 0\.6 \+ 0\.2/);
  assert.match(plum, /plumWidth < 500 \? seeds\.slice\(0, 2\) : seeds/);
});

test("图层在 HTML 里默认关着，脚本排在 events.js 之前", () => {
  assert.match(html, /<div class="plum" aria-hidden="true" hidden><canvas><\/canvas><\/div>/,
    "图层应当默认 hidden 且对读屏隐藏");
  const plumAt = html.indexOf('src="/static/js/plum.js"');
  const eventsAt = html.indexOf('src="/static/js/events.js"');
  assert.ok(plumAt > 0 && eventsAt > 0, "两个脚本都该在 HTML 里");
  assert.ok(plumAt < eventsAt,
    "plum.js 要先加载：applyTheme 调 syncPlumLayer 时它得已经定义");
});

test("applyTheme 会同步图层", () => {
  const events = read("static/js/events.js");
  const body = /function applyTheme\(theme\) \{([\s\S]*?)\n\}/.exec(events)?.[1];
  assert.ok(body, "找不到 applyTheme");
  assert.match(body, /syncPlumLayer\(next\)/);
});

/* 只有凉砂两包用这个底。别的包不给 --plum-ink，图层在那边始终 hidden；
   两包的值必须一样，日夜切换时枝条不该换颜色。 */
test("只有凉砂两包定义 --plum-ink，且两包同值", () => {
  const inks = new Map();
  for (const pack of themePacks()) {
    const match = /--plum-ink:\s*([^;]+);/.exec(read(`themes/${pack}/theme.css`));
    if (match) inks.set(pack, match[1].trim());
  }
  assert.deepEqual([...inks.keys()].sort(), ["co1dsand-dark", "co1dsand-light"]);
  assert.equal(inks.get("co1dsand-dark"), inks.get("co1dsand-light"),
    `日夜墨色不一致：${inks.get("co1dsand-light")} / ${inks.get("co1dsand-dark")}`);
  // 空格分隔的现代写法，与包里其它颜色一致，不用 rgba()。
  assert.match(inks.get("co1dsand-dark"), /^rgb\(136 136 136 \/ 15%\)$/);

  // plum.js 兜底的默认值要和主题给的一致，取不到 token 时观感不该变。
  assert.match(plum, /return declared \|\| "rgb\(136 136 136 \/ 15%\)"/);
});

test("图层压在内容之下且不吃鼠标", () => {
  const base = read("static/css/base.css");
  const body = /\.plum \{([^}]*)\}/.exec(base)?.[1];
  assert.ok(body, "base.css 里找不到 .plum");
  assert.match(body, /position:\s*fixed/);
  assert.match(body, /inset:\s*0/);
  assert.match(body, /pointer-events:\s*none/);
  assert.match(body, /z-index:\s*0/);
  assert.match(body, /mask-image:\s*radial-gradient\(circle, transparent, black\)/);

  // .app-shell 是 z-index 1，图层必须在它下面，否则会盖住整个控制台。
  const shell = /^\.app-shell \{([^}]*)\}/m.exec(base)?.[1];
  assert.match(shell, /z-index:\s*1/, "移植依赖 .app-shell 仍在 z-index 1");

  /* 收起靠的是 hidden 属性，也就是 UA 样式表那条 [hidden] { display: none }。
     .plum 自己一旦声明 display，作者样式压过 UA 样式，图层就再也收不起来——
     .live-indicator 犯过一模一样的错。 */
  assert.doesNotMatch(body, /(^|[\s;])display:/,
    ".plum 不能声明 display，否则 hidden 属性失效");
});

/* 生长是自限的（过 30 段后期望分枝因子 1，加越界剪枝），但"期望 1"有长尾。
   reduced-motion 那条路在一个同步循环里抽干队列，没有上限时运气差的一次就是卡死
   主线程。这里拿桩 canvas 真跑一遍，确认它会停、会画、且不越过上限。 */
test("同步抽干队列会终止，且不越过段数上限", async () => {
  const strokes = [];
  const ctx = {
    beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { strokes.push(1); },
    clearRect() {}, setTransform() {},
    lineWidth: 0, strokeStyle: "",
  };
  const canvas = { style: {}, width: 0, height: 0, getContext: () => ctx };
  const layer = { hidden: true, querySelector: () => canvas };

  const stubs = {
    window: {
      innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
      matchMedia: () => ({ matches: true }),   // 走 reduced-motion 那条同步路径
      addEventListener() {}, clearTimeout() {}, setTimeout() {},
      requestAnimationFrame() { throw new Error("reduced-motion 下不该起动画帧"); },
      cancelAnimationFrame() {},
    },
    document: {
      querySelector: (selector) => (selector === ".plum" ? layer : null),
      documentElement: {},
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };

  /* 源码是传统 script（无 export），拿函数体包一层把桩注进去，再把要测的函数抛出
     来。这样测的是仓库里那份真源码，不是抄本。 */
  const source = readFileSync(repo("static/js/plum.js"), "utf8");
  const factory = new Function("window", "document", "getComputedStyle",
    `${source}\nreturn { syncPlumLayer, PLUM_MAX_SEGMENTS };`);
  const api = factory(stubs.window, stubs.document, stubs.getComputedStyle);

  api.syncPlumLayer("co1dsand-dark");   // 会同步跑完
  assert.equal(layer.hidden, false, "凉砂下图层应当显示");
  assert.ok(strokes.length > 100, `只画了 ${strokes.length} 段，像是没长起来`);
  /* 上限是兜底而不是常规截断：撞上它意味着枝条被硬切断。这一次跑完就该远在
     上限之下（1440×900 的中位数约 15000 段，上限 500000）。 */
  assert.ok(strokes.length < api.PLUM_MAX_SEGMENTS,
    `画了 ${strokes.length} 段就撞上了上限 ${api.PLUM_MAX_SEGMENTS}，`
    + "上限该是兜底，不该在常规几何下触发");

  // 画布按 DPI 放大，CSS 尺寸仍是视口尺寸。
  assert.equal(canvas.width, 2880);
  assert.equal(canvas.height, 1800);
  assert.equal(canvas.style.width, "1440px");

  // 切走要收起来。
  api.syncPlumLayer("dark");
  assert.equal(layer.hidden, true, "离开凉砂后图层应当收起");
});
