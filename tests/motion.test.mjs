import assert from "node:assert/strict";
import test from "node:test";
import { loadTS, read } from "./react-harness.mjs";

const {
  SPRING_DAMPING_RATIO,
  animatePresence,
  applyRubberBandBounds,
  createVelocityTracker,
  rubberBand,
  solveSpring,
  springLinearEasing,
} = loadTS("web/src/motion.ts");

function element() {
  const runs = [];
  return {
    runs,
    animate(frames, options) {
      let finish;
      const item = {
        frames,
        options,
        finished: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel() {
          this.cancelled = true;
        },
        finish: () => finish(),
      };
      runs.push(item);
      return item;
    },
  };
}

test("reduced motion and missing WAAPI fall back immediately", () => {
  let calls = 0;
  globalThis.matchMedia = () => ({ matches: true });
  const node = element();
  animatePresence(node, true, () => calls++);
  assert.equal(node.runs.length, 0);
  assert.equal(calls, 1);
  globalThis.matchMedia = () => ({ matches: false });
  animatePresence({}, false, () => calls++);
  assert.equal(calls, 2);
});

test("a superseded hide never closes a surface that was reopened", async () => {
  globalThis.matchMedia = () => ({ matches: false });
  const node = element();
  let hidden = false;
  animatePresence(node, false, () => {
    hidden = true;
  });
  animatePresence(node, true);
  node.runs[0].finish();
  await Promise.resolve();
  assert.equal(hidden, false);
  assert.equal(node.runs[0].cancelled, true);
  node.runs[1].finish();
  await Promise.resolve();
});

test("unmount cleanup cancels animation and its completion side effects", async () => {
  const node = element();
  let settled = false;
  const cancel = animatePresence(node, false, () => {
    settled = true;
  });
  cancel();
  node.runs[0].finish();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(node.runs[0].cancelled, true);
});

test("dialogs remain modal and inert during exit, with shared lifecycle cleanup", () => {
  const source = read("web/src/useDialog.ts");
  assert.match(source, /dialog.showModal\(\)/);
  assert.match(source, /dialog.inert = !open/);
  assert.match(source, /return animatePresence/);
  assert.match(source, /pointercancel/);
});

test("critically damped spring (dampingRatio = 1) converges monotonically with zero overshoot from rest", () => {
  assert.equal(SPRING_DAMPING_RATIO, 1);
  const spring = solveSpring({ from: 0, to: 100, velocity: 0, angularFrequency: 26 });
  assert.equal(spring.dampingRatio, 1);
  assert.ok(spring.durationMs > 0);

  let previous = 0;
  for (let ms = 0; ms <= spring.durationMs; ms += 8) {
    const { value } = spring.sample(ms / 1000);
    assert.ok(value >= previous - 1e-6, `monotonic increase violated at ${ms}ms: ${value} < ${previous}`);
    assert.ok(value <= 100 + 1e-6, `critically damped rest start must not overshoot 100, got ${value}`);
    previous = value;
  }
  assert.equal(spring.sample(spring.durationMs / 1000).value, 100);

  const easing = springLinearEasing(12, 8);
  assert.match(easing, /^linear\(0,[\s\S]*,\s*1\)$/);
});

test("spring carries initial gesture release velocity and velocity tracker drops stale pauses", () => {
  const fromRest = solveSpring({ from: 0, to: 100, velocity: 0, angularFrequency: 24 });
  const withFlick = solveSpring({ from: 0, to: 100, velocity: 900, angularFrequency: 24 });

  // 携带正向脱手速度时初速一致，且与静止起步的差值严格符合 v₀·t·e^(-ωt) = 900·0.03·e^(-0.72) ≈ 13.14
  assert.ok(Math.abs(withFlick.sample(0).velocity - 900) < 1e-6);
  const expectedBoost = 900 * 0.03 * Math.exp(-24 * 0.03);
  assert.ok(Math.abs(withFlick.sample(0.03).value - fromRest.sample(0.03).value - expectedBoost) < 1e-6);

  const tracker = createVelocityTracker(90, 3600);
  tracker.push(10, 1000);
  tracker.push(46, 1030);
  tracker.push(82, 1060);
  const releaseVelocity = tracker.velocity(1065);
  assert.ok(Math.abs(releaseVelocity - 1200) < 30, `expected ~1200px/s, got ${releaseVelocity}`);

  // 松手前按住停顿超过窗口后，速度归零，不把旧动量带出
  assert.equal(tracker.velocity(1220), 0);
});

test("boundary rubber-band resists over-drag and rebounds smoothly via dampingRatio = 1 without ringing", () => {
  assert.equal(applyRubberBandBounds(50, 0, 100, 40, 0.5), 50, "1:1 inside bounds");
  const overRight = applyRubberBandBounds(180, 0, 100, 40, 0.5);
  assert.ok(overRight > 100 && overRight < 140, `rubber-band caps excursion below 100 + 40: ${overRight}`);
  assert.equal(rubberBand(-80, 40, 0.5), -rubberBand(80, 40, 0.5), "symmetric resistance");

  // 1) 拖出右边界后松手：从当前阻尼位置连续起步，平滑回弹到右边界且不反向穿过 100
  const releaseFromOverdrag = solveSpring({
    from: 128,
    to: 140,
    velocity: 180,
    angularFrequency: 28,
    bounds: { min: 0, max: 100, maxOvershoot: 24 },
  });
  assert.equal(releaseFromOverdrag.target, 100);
  assert.ok(Math.abs(releaseFromOverdrag.sample(0).value - 128) < 1e-6, "C0 continuous at release");
  assert.ok(releaseFromOverdrag.sample(0.006).value > 128, "outward release momentum carries to a smooth peak");
  for (let ms = 0; ms <= releaseFromOverdrag.durationMs; ms += 8) {
    const { value } = releaseFromOverdrag.sample(ms / 1000);
    assert.ok(value >= 100 - 1e-6, `critical rebound must not ring below boundary 100, got ${value}`);
  }
  assert.equal(releaseFromOverdrag.sample(releaseFromOverdrag.durationMs / 1000).value, 100);

  // 2) 在区间内部高速冲向边界：穿过 100 产生有界弹性压缩并回弹收敛到 100
  const collideBoundary = solveSpring({
    from: 85,
    to: 100,
    velocity: 1400,
    angularFrequency: 26,
    bounds: { min: 0, max: 100, maxOvershoot: 20 },
  });
  let peak = 100;
  for (let ms = 0; ms <= collideBoundary.durationMs; ms += 8) {
    const { value } = collideBoundary.sample(ms / 1000);
    if (value > peak) peak = value;
  }
  assert.ok(peak > 102 && peak < 120, `expected bounded boundary bounce in (102, 120), got ${peak}`);
  assert.equal(collideBoundary.sample(collideBoundary.durationMs / 1000).value, 100);

  // 3) 停在边界上受到外推滚轮冲量（x0 = 0, v0 != 0）：伸出后再回弹归零
  const boundaryImpulse = solveSpring({
    from: 0,
    to: 0,
    velocity: -600,
    angularFrequency: 28,
    bounds: { min: 0, max: 0, maxOvershoot: 28 },
  });
  assert.ok(boundaryImpulse.durationMs > 0);
  assert.ok(boundaryImpulse.sample(0.03).value < -4, "impulse stretches past top boundary");
  assert.equal(boundaryImpulse.sample(boundaryImpulse.durationMs / 1000).value, 0);
});

test("navigation menu indicator and view switching wire critically damped spring, drag velocity, and boundary bounce", () => {
  const topbar = read("web/src/components/Topbar.tsx");
  const app = read("web/src/App.tsx");
  const navCss = read("static/css/nav-motion.css");
  const stylesEntry = read("static/styles.css");

  assert.match(stylesEntry, /@import url\("\.\/css\/nav-motion\.css"\);/);
  assert.match(topbar, /className="nav-active-thumb"/);
  assert.match(topbar, /createSpringAnimator/);
  assert.match(topbar, /applyRubberBandBounds/);
  assert.match(topbar, /createVelocityTracker/);
  assert.match(topbar, /dataset\.navSpring/);

  // 视图切换按导航方向走弹簧入场，兼容桌面纵向侧栏与手机横向底栏及懒加载挂载
  assert.match(app, /nextIndex >= prevIndex \? 1 : -1/);
  assert.match(app, /dataset\.viewSpring/);
  assert.match(app, /animatePresence\(target,\s*true/);
  assert.match(app, /new MutationObserver/);

  // 滑块自身遵循圆角主题连续曲率，同时保留 ark / endfield / minegrub 的 0 圆角
  assert.match(navCss, /\.nav-active-thumb\s*\{/);
  for (const sharp of ["ark", "endfield", "minegrub"]) {
    assert.match(navCss, new RegExp(`html\\[data-theme="${sharp}"\\] \\.nav-active-thumb\\s*\\{[\\s\\S]*?border-radius:\\s*0;`));
  }
});
