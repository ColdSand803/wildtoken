import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/* motion.js 的显隐过渡契约。

   这个模块存在的理由是 `hidden` 是 display 开关——display 不可插值，CSS 对
   它完全无能为力，所以控制台里几十处弹层、悬浮卡、详情块都是一瞬间出现、
   一瞬间消失。这里钉住四件事：

   1. 显隐语义没被动画改掉：显示同步落位，隐藏才允许异步。
   2. 打断时以最后一次调用为准，迟到的 finish 不能把已经显示的面藏起来。
   3. 收尾清理（清空内容、清内联位）必须发生，但只能发生在淡出之后。
   4. 没有 WAAPI、或用户要求减少动效时，直接落最终态。 */

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  let paramDepth = 0;
  let paramEnd = -1;
  for (let i = start + `function ${name}`.length; i < source.length; i += 1) {
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
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

const motionSource = read("static/js/motion.js");

/* 模块级的常量与状态照搬源码——时长抄一份就有两个真相。函数体内的局部变量
   是缩进的，这个匹配捞不到它们。 */
function motionDeclarations(source) {
  return [...source.matchAll(/^(?:const|let) [A-Za-z_]+ = [^\n]+;$/gm)].map((match) => match[0]);
}

const MOTION_FUNCTIONS = [
  "wtMotionReduced",
  "wtMotionEnabled",
  "wtMotionTakeOver",
  "wtReveal",
  "wtHide",
];

function motionContext(options = {}) {
  const globals = {};
  if (options.withMatchMedia !== false) {
    globals.window = { matchMedia: () => ({ matches: Boolean(options.reducedMotion) }) };
  }
  const context = vm.createContext(globals);
  vm.runInContext(
    [
      motionDeclarations(motionSource).join("\n"),
      ...MOTION_FUNCTIONS.map((name) => extractFunction(motionSource, name)),
      ...MOTION_FUNCTIONS.map((name) => `this.${name} = ${name};`),
    ].join("\n"),
    context,
  );
  return context;
}

function fakeAnimation(element) {
  const listeners = new Map();
  return {
    keyframes: null,
    options: null,
    cancelled: false,
    cancel() {
      this.cancelled = true;
      element.cancelledAnimations.push(this);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    /* 手动派发 finish：真实 WAAPI 在动画跑完时派发，这里由用例决定时机。 */
    finish() {
      const handler = listeners.get("finish");
      if (handler) handler();
    },
  };
}

function fakeElement() {
  const element = {
    hidden: true,
    animations: [],
    cancelledAnimations: [],
    animate(keyframes, options) {
      const animation = fakeAnimation(element);
      animation.keyframes = keyframes;
      animation.options = options;
      element.animations.push(animation);
      return animation;
    },
  };
  return element;
}

test("wtReveal 同步落可见，并用 WAAPI 从透明淡入", () => {
  const { wtReveal } = motionContext();
  const element = fakeElement();
  const animation = wtReveal(element);

  assert.equal(element.hidden, false, "显示必须同步，调用方和测试都不该等动画");
  assert.equal(element.animations.length, 1);
  assert.equal(animation.keyframes[0].opacity, 0);
  assert.equal(animation.keyframes[1].opacity, 1);
  assert.equal(animation.options.duration, 160);
  assert.equal(
    animation.options.fill,
    "backwards",
    "起手第一帧要压在透明上，否则元素会先以全不透明闪一下",
  );
});

test("已经显示且没有动画在跑时，wtReveal 不重放淡入", () => {
  const { wtReveal } = motionContext();
  const element = fakeElement();
  element.hidden = false;

  assert.equal(wtReveal(element), null);
  assert.equal(
    element.animations.length,
    0,
    "切换重试步骤这类重复渲染每次都闪一下，比没有过渡更烦人",
  );
});

test("淡入跑完之后再显示同一个面，不再重放", () => {
  const { wtReveal } = motionContext();
  const element = fakeElement();
  wtReveal(element).finish();

  assert.equal(wtReveal(element), null, "动画记录没撤掉的话，这里会又放一遍淡入");
  assert.equal(element.animations.length, 1);
});

test("wtHide 等动画跑完才落 hidden，并撤掉自身填充", () => {
  const { wtReveal, wtHide } = motionContext();
  const element = fakeElement();
  wtReveal(element);
  const hide = wtHide(element);

  assert.equal(element.hidden, false, "淡出期间元素还在，只是透明度在降");
  assert.equal(hide.options.fill, "forwards");
  assert.equal(hide.keyframes[1].opacity, 0);

  hide.finish();
  assert.equal(element.hidden, true);
  assert.equal(hide.cancelled, true, "落位后要撤掉 forwards 填充，不留残余 transform");
});

test("收尾清理必须在淡出之后才执行", () => {
  const { wtReveal, wtHide } = motionContext();
  const element = fakeElement();
  wtReveal(element);
  let settled = 0;
  const hide = wtHide(element, { onSettled: () => { settled += 1; } });

  assert.equal(settled, 0, "清内联位不能早于淡出，否则菜单会在淡出途中先跳位");
  hide.finish();
  assert.equal(settled, 1);
});

test("淡出途中被重新显示时，迟到的 finish 不能又把面藏起来", () => {
  const { wtReveal, wtHide } = motionContext();
  const element = fakeElement();
  wtReveal(element);
  const hide = wtHide(element);

  wtReveal(element);
  assert.equal(hide.cancelled, true, "上一段退场必须被撤掉");

  hide.finish();
  assert.equal(element.hidden, false, "最后一次调用说了算");
});

test("对已隐藏的元素调用 wtHide 仍会执行收尾清理", () => {
  const { wtHide } = motionContext();
  const element = fakeElement();
  element.hidden = true;
  let settled = 0;

  assert.equal(wtHide(element, { onSettled: () => { settled += 1; } }), null);
  assert.equal(settled, 1, "没有动画可放，但\"顺手清空内容\"这类事必须照做");
  assert.equal(element.animations.length, 0);
});

test("用户要求减少动效时只落最终态", () => {
  const { wtReveal, wtHide } = motionContext({ reducedMotion: true });
  const element = fakeElement();

  assert.equal(wtReveal(element), null);
  assert.equal(element.hidden, false);
  assert.equal(wtHide(element), null);
  assert.equal(element.hidden, true);
  assert.equal(element.animations.length, 0, "偏好减少动效就不该再有动画");
});

test("没有 WAAPI 时直接落最终态", () => {
  const { wtReveal, wtHide } = motionContext();
  const element = { hidden: true };

  assert.equal(wtReveal(element), null);
  assert.equal(element.hidden, false);
  assert.equal(wtHide(element), null);
  assert.equal(element.hidden, true);
});

test("环境没有 matchMedia 时按可动处理，不抛错", () => {
  const { wtReveal } = motionContext({ withMatchMedia: false });
  const element = fakeElement();

  assert.equal(wtReveal(element).keyframes[1].opacity, 1);
});

test("motion.js 排在所有用到显隐过渡的模块之前", () => {
  const markup = read("static/admin.html");
  const at = (file) => markup.indexOf(`js/${file}`);

  assert.ok(at("motion.js") > -1, "motion.js 挂在 admin.html 上");
  for (const consumer of ["bootstrap.js", "logs.js", "events.js", "upstreams.js", "shell.js"]) {
    assert.ok(
      at("motion.js") < at(consumer),
      `motion.js 必须先于 ${consumer} 加载，否则 wtReveal / wtHide 还没定义`,
    );
  }
});
