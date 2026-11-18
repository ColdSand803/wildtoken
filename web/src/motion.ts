/**
 * 临界阻尼弹簧动效引擎（ζ = 1）。
 *
 * 所有状态切换、手势释放与越界回弹共用同一条二阶线性常微分方程：
 *   x''(t) + 2·ζ·ω₀·x'(t) + ω₀²·x(t) = 0，其中阻尼比 ζ = 1（临界阻尼）。
 *
 * 给定初始偏移 x₀ = from - target 与初始脱手/打断速度 v₀：
 *   x(t) = (x₀ + (v₀ + ω₀·x₀)·t) · e^(-ω₀·t)
 *   v(t) = (v₀ - ω₀·(v₀ + ω₀·x₀)·t) · e^(-ω₀·t)
 *
 * 静止起步（v₀ = 0）时无过冲最快收敛；携带脱手速度或中途改向时保持位置 C⁰ 与速度 C¹ 连续；
 * 触及或越过边界时经渐近阻尼压缩并按 ζ = 1 平滑回弹至边界，不来回震荡。
 */

export const SPRING_DAMPING_RATIO = 1 as const;
export const WT_REVEAL_DURATION_MS = 240;
export const WT_HIDE_DURATION_MS = 180;

export interface SpringBounds {
  min: number;
  max: number;
  /** 冲撞或越界回弹允许的最大弹性压缩量（px）。 */
  maxOvershoot?: number;
}

export interface SpringOptions {
  from: number;
  to: number;
  /** 初始速度（单位/秒），来自手势脱手速度或上一轮动画被中断时的瞬时速度。 */
  velocity?: number;
  /** 固有角频率 ω₀（rad/s）。值越大响应越紧实。 */
  angularFrequency?: number;
  /** 阻尼比，固定按临界阻尼 1 运行。 */
  dampingRatio?: number;
  bounds?: SpringBounds;
  restDelta?: number;
  restSpeed?: number;
}

export interface SpringSample {
  value: number;
  velocity: number;
  done: boolean;
}

export interface SpringSolution {
  readonly dampingRatio: 1;
  readonly target: number;
  readonly durationMs: number;
  sample: (timeSec: number) => SpringSample;
}

export interface VelocityTracker {
  push: (position: number, timeMs?: number) => void;
  velocity: (nowMs?: number) => number;
  reset: () => void;
}

export interface SpringAnimatorOptions {
  initial?: number;
  angularFrequency?: number;
  bounds?: SpringBounds;
  restDelta?: number;
  restSpeed?: number;
}

export interface SpringToOptions {
  /** 显式传入脱手速度；省略时自动继承当前运动中的瞬时速度。 */
  velocity?: number;
  angularFrequency?: number;
  bounds?: SpringBounds;
  onRest?: () => void;
}

export interface SpringAnimator {
  get: () => number;
  velocity: () => number;
  isAnimating: () => boolean;
  set: (value: number, velocity?: number) => void;
  to: (target: number, options?: SpringToOptions) => void;
  impulse: (velocityDelta: number, bounds?: SpringBounds) => void;
  stop: () => void;
  destroy: () => void;
}

export interface PresenceSpringOptions {
  axis?: "x" | "y";
  /** 进出场位移基准（px）；默认 y 轴 -6px、x 轴 28px。 */
  offsetPx?: number;
  /** 拖拽释放时当前已偏离的像素位移。 */
  fromOffsetPx?: number;
  /** 脱手速度（px/s，正方向与位移轴一致）。 */
  velocityPxPerSec?: number;
  scaleFrom?: number;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

export function motionReduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 拖拽越界时的橡皮筋阻尼：越往外拉阻力越大，永不超过 dimension。
 *   f(d) = sign(d) · (|d| · D · c) / (D + c · |d|)
 */
export function rubberBand(offset: number, dimension: number, resistance = 0.55): number {
  if (!Number.isFinite(offset) || offset === 0 || dimension <= 0 || resistance <= 0) return 0;
  const abs = Math.abs(offset);
  const damped = (abs * dimension * resistance) / (dimension + resistance * abs);
  return offset < 0 ? -damped : damped;
}

/** 在 [min, max] 内 1:1 跟随，超出边界时平滑进入橡皮筋阻尼。 */
export function applyRubberBandBounds(
  value: number,
  min: number,
  max: number,
  dimension = 64,
  resistance = 0.55,
): number {
  if (min > max) return value;
  if (value < min) return min + rubberBand(value - min, dimension, resistance);
  if (value > max) return max + rubberBand(value - max, dimension, resistance);
  return value;
}

/**
 * 边界弹性缓冲器：g(d) = d·D / (D + |d|)。
 * 在 d = 0 处 g(0) = 0 且 g'(0) = 1，使元素带着速度撞上边界的瞬间位置与速度同时连续，
 * 随后被渐近限制在 D 以内，再由临界阻尼弹簧平滑拉回边界。
 */
function compressExcursion(excursion: number, rawVelocity: number, maxOvershoot: number): { delta: number; velocity: number } {
  if (maxOvershoot <= 0 || excursion === 0) return { delta: 0, velocity: 0 };
  const abs = Math.abs(excursion);
  const denom = maxOvershoot + abs;
  const delta = (excursion * maxOvershoot) / denom;
  const derivative = (maxOvershoot * maxOvershoot) / (denom * denom);
  return { delta, velocity: rawVelocity * derivative };
}

/**
 * 滑动时间窗速度采样器，计算手势松手瞬间的脱手速度（单位/秒）。
 * 若手指停顿超过 windowMs 再抬起，速度归零，避免把停顿前的旧速度带进释放动画。
 */
export function createVelocityTracker(windowMs = 90, maxVelocity = 3600): VelocityTracker {
  const samples: Array<{ position: number; time: number }> = [];

  const prune = (cutoff: number) => {
    while (samples.length > 0 && samples[0].time < cutoff) {
      samples.shift();
    }
  };

  return {
    push(position: number, time = nowMs()) {
      if (!Number.isFinite(position) || !Number.isFinite(time)) return;
      // 同一时间戳合并到最新采样点
      if (samples.length > 0 && time <= samples[samples.length - 1].time) {
        samples[samples.length - 1] = { position, time };
      } else {
        samples.push({ position, time });
      }
      prune(time - windowMs * 1.5);
    },
    velocity(current = nowMs()) {
      if (samples.length < 2) return 0;
      const last = samples[samples.length - 1];
      if (current - last.time > windowMs) return 0;
      let anchor = samples[0];
      for (let i = samples.length - 2; i >= 0; i -= 1) {
        anchor = samples[i];
        if (last.time - anchor.time >= windowMs * 0.65) break;
      }
      const dtSec = (last.time - anchor.time) / 1000;
      if (dtSec <= 0.0005) return 0;
      const raw = (last.position - anchor.position) / dtSec;
      return clamp(raw, -maxVelocity, maxVelocity);
    },
    reset() {
      samples.length = 0;
    },
  };
}

/**
 * 求解 ζ = 1 临界阻尼弹簧轨迹，支持初始速度 v₀ 与边界碰撞回弹。
 */
export function solveSpring(options: SpringOptions): SpringSolution {
  const omega = Math.max(4, options.angularFrequency ?? 26);
  const restDelta = Math.max(1e-5, options.restDelta ?? 0.25);
  const restSpeed = Math.max(1e-4, options.restSpeed ?? 2);
  const bounds = options.bounds && options.bounds.min <= options.bounds.max ? options.bounds : undefined;
  const maxOvershoot = Math.max(2, bounds?.maxOvershoot ?? 24);

  const from = options.from;
  const target = bounds ? clamp(options.to, bounds.min, bounds.max) : options.to;
  const v0 = Number.isFinite(options.velocity) ? (options.velocity as number) : 0;
  const x0 = from - target;

  const startedBelowMin = Boolean(bounds && from < bounds.min);
  const startedAboveMax = Boolean(bounds && from > bounds.max);

  const sample = (timeSec: number): SpringSample => {
    const t = Math.max(0, timeSec);
    const exp = Math.exp(-omega * t);
    const c2 = v0 + omega * x0;
    const rawX = (x0 + c2 * t) * exp;
    const rawVel = (v0 - omega * c2 * t) * exp;
    let value = target + rawX;
    let velocity = rawVel;

    if (bounds) {
      if (startedAboveMax && value > from) {
        // 已在右边界外释放但仍有向外残余速度：仅对超出释放点的额外外冲做渐近压缩，保证 t=0 处位置与速度连续
        const compressed = compressExcursion(value - from, rawVel, maxOvershoot * 0.65);
        value = from + compressed.delta;
        velocity = compressed.velocity;
      } else if (startedBelowMin && value < from) {
        const compressed = compressExcursion(value - from, rawVel, maxOvershoot * 0.65);
        value = from + compressed.delta;
        velocity = compressed.velocity;
      } else if (!startedAboveMax && value > bounds.max) {
        const compressed = compressExcursion(value - bounds.max, rawVel, maxOvershoot);
        value = bounds.max + compressed.delta;
        velocity = compressed.velocity;
      } else if (!startedBelowMin && value < bounds.min) {
        const compressed = compressExcursion(value - bounds.min, rawVel, maxOvershoot);
        value = bounds.min + compressed.delta;
        velocity = compressed.velocity;
      }
    }

    const done = Math.abs(value - target) <= restDelta && Math.abs(velocity) <= restSpeed;
    if (done && t > 0) {
      return { value: target, velocity: 0, done: true };
    }
    return { value, velocity, done };
  };

  let durationMs = 0;
  if (!sample(0).done) {
    const stepMs = 8;
    const maxMs = 720;
    durationMs = maxMs;
    // 注意：冲击边界（x₀=0, v₀≠0）在峰值处速度短暂过零但位移尚未归零，sample 内部同时检查位移与速度
    for (let ms = stepMs; ms <= maxMs; ms += stepMs) {
      if (sample(ms / 1000).done) {
        durationMs = ms;
        break;
      }
    }
    durationMs = Math.max(96, durationMs);
  }

  return {
    dampingRatio: SPRING_DAMPING_RATIO,
    target,
    durationMs,
    sample,
  };
}

/** 生成与 ζ = 1 临界阻尼弹簧（v₀ = 0）一致的 CSS linear(...) 缓动函数。 */
export function springLinearEasing(samples = 16, omegaT = 8): string {
  const count = Math.max(4, samples);
  const norm = 1 - (1 + omegaT) * Math.exp(-omegaT);
  const stops: string[] = [];
  for (let i = 0; i <= count; i += 1) {
    const s = i / count;
    if (i === 0) {
      stops.push("0");
    } else if (i === count) {
      stops.push("1");
    } else {
      const y = (1 - (1 + omegaT * s) * Math.exp(-omegaT * s)) / norm;
      const pct = Math.round(s * 1000) / 10;
      stops.push(`${Number(y.toFixed(4))} ${pct}%`);
    }
  }
  return `linear(${stops.join(", ")})`;
}

/**
 * 有状态的 1D 弹簧动画控制器：
 * - 中途改目标时自动继承当前瞬时速度；
 * - 手势松手时可显式注入脱手速度；
 * - 配置 bounds 时自动在边界处做弹性压缩与 ζ = 1 回弹。
 */
export function createSpringAnimator(
  onUpdate: (value: number, velocity: number) => void,
  config: SpringAnimatorOptions = {},
): SpringAnimator {
  let currentValue = config.initial ?? 0;
  let currentVelocity = 0;
  let targetValue = currentValue;
  let activeBounds = config.bounds;
  let frameId = 0;
  let destroyed = false;
  let activeSolution: SpringSolution | null = null;
  let startTime = 0;
  let onRestCallback: (() => void) | undefined;

  const cancelFrame = () => {
    if (frameId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
    }
    frameId = 0;
  };

  const syncLiveState = () => {
    if (!activeSolution) return;
    const elapsedSec = Math.max(0, (nowMs() - startTime) / 1000);
    const state = activeSolution.sample(elapsedSec);
    currentValue = state.value;
    currentVelocity = state.velocity;
  };

  const stop = () => {
    syncLiveState();
    cancelFrame();
    activeSolution = null;
    onRestCallback = undefined;
  };

  const runSpring = (nextTarget: number, options: SpringToOptions = {}) => {
    if (destroyed) return;
    syncLiveState();
    cancelFrame();

    const bounds = options.bounds ?? activeBounds;
    activeBounds = bounds;
    const clampedTarget = bounds ? clamp(nextTarget, bounds.min, bounds.max) : nextTarget;
    targetValue = clampedTarget;
    const initialVelocity = options.velocity !== undefined ? options.velocity : currentVelocity;

    if (motionReduced() || typeof requestAnimationFrame !== "function") {
      activeSolution = null;
      currentValue = clampedTarget;
      currentVelocity = 0;
      onUpdate(currentValue, 0);
      options.onRest?.();
      return;
    }

    const solution = solveSpring({
      from: currentValue,
      to: clampedTarget,
      velocity: initialVelocity,
      angularFrequency: options.angularFrequency ?? config.angularFrequency ?? 26,
      bounds,
      restDelta: config.restDelta ?? 0.25,
      restSpeed: config.restSpeed ?? 2,
    });

    if (solution.durationMs === 0) {
      activeSolution = null;
      currentValue = solution.target;
      currentVelocity = 0;
      onUpdate(currentValue, 0);
      options.onRest?.();
      return;
    }

    activeSolution = solution;
    startTime = nowMs();
    onRestCallback = options.onRest;

    const tick = () => {
      if (destroyed || activeSolution !== solution) return;
      const elapsedSec = Math.max(0, (nowMs() - startTime) / 1000);
      const state = solution.sample(elapsedSec);
      currentValue = state.value;
      currentVelocity = state.velocity;

      if (state.done || elapsedSec * 1000 >= solution.durationMs) {
        activeSolution = null;
        frameId = 0;
        currentValue = solution.target;
        currentVelocity = 0;
        onUpdate(currentValue, 0);
        const rest = onRestCallback;
        onRestCallback = undefined;
        rest?.();
        return;
      }

      onUpdate(currentValue, currentVelocity);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
  };

  return {
    get: () => {
      syncLiveState();
      return currentValue;
    },
    velocity: () => {
      syncLiveState();
      return currentVelocity;
    },
    isAnimating: () => activeSolution !== null,
    set(value: number, velocity = 0) {
      if (destroyed) return;
      cancelFrame();
      activeSolution = null;
      onRestCallback = undefined;
      currentValue = value;
      targetValue = value;
      currentVelocity = velocity;
      onUpdate(currentValue, currentVelocity);
    },
    to(target: number, options?: SpringToOptions) {
      runSpring(target, options);
    },
    impulse(velocityDelta: number, bounds?: SpringBounds) {
      if (destroyed || !Number.isFinite(velocityDelta) || velocityDelta === 0) return;
      syncLiveState();
      runSpring(targetValue, {
        velocity: currentVelocity + velocityDelta,
        bounds: bounds ?? activeBounds,
      });
    },
    stop,
    destroy() {
      stop();
      destroyed = true;
    },
  };
}

/* ── WAAPI 进出场弹簧（Last caller wins + 打断速度连续） ──────────────── */

interface ActivePresence {
  animation: Animation;
  startTime: number;
  progressSpring: SpringSolution;
}

const animations = new WeakMap<HTMLElement, ActivePresence>();

/** Last caller wins. A cancelled exit must never close a subsequently reopened surface. */
export function animatePresence(
  element: HTMLElement,
  visible: boolean,
  settled?: () => void,
  options: PresenceSpringOptions = {},
): () => void {
  const previous = animations.get(element);
  let startProgress = visible ? 0 : 1;
  let startProgressVelocity = 0;

  if (previous) {
    const elapsedSec = Math.max(0, (nowMs() - previous.startTime) / 1000);
    const sampled = previous.progressSpring.sample(elapsedSec);
    startProgress = clamp(sampled.value, 0, 1);
    startProgressVelocity = sampled.velocity;
    previous.animation.cancel();
    animations.delete(element);
  }

  if (motionReduced() || typeof element?.animate !== "function") {
    settled?.();
    return () => {};
  }

  const axis = options.axis ?? "y";
  const defaultOffset = axis === "x" ? 28 : -6;
  const baseOffsetPx = options.offsetPx ?? defaultOffset;
  const scaleFrom = options.scaleFrom ?? (axis === "x" ? 1 : 0.985);
  const targetProgress = visible ? 1 : 0;

  // 若来自手势释放，将像素偏移与脱手像素速度折算进归一化弹簧
  let travelOffsetPx = baseOffsetPx;
  if (options.fromOffsetPx !== undefined && !visible) {
    travelOffsetPx = Math.max(Math.abs(baseOffsetPx), Math.abs(options.fromOffsetPx) + 48) * Math.sign(baseOffsetPx || 1);
    startProgress = 1 - clamp(Math.abs(options.fromOffsetPx) / Math.max(1, Math.abs(travelOffsetPx)), 0, 0.95);
  } else if (options.fromOffsetPx !== undefined && visible && Math.abs(baseOffsetPx) > 0) {
    travelOffsetPx = options.fromOffsetPx;
    startProgress = 0;
  }

  if (options.velocityPxPerSec && Math.abs(travelOffsetPx) > 1) {
    // 位移 offset(p) = (1 - p) * travelOffsetPx ⇒ dp/dt = -(v_px / travelOffsetPx)
    startProgressVelocity += -options.velocityPxPerSec / travelOffsetPx;
  }

  const progressSpring = solveSpring({
    from: startProgress,
    to: targetProgress,
    velocity: startProgressVelocity,
    angularFrequency: visible ? 28 : 34,
    restDelta: 0.0025,
    restSpeed: 0.025,
  });

  const duration = Math.max(
    96,
    Math.min(480, progressSpring.durationMs || (visible ? WT_REVEAL_DURATION_MS : WT_HIDE_DURATION_MS)),
  );
  const frameCount = 20;
  const frames: Keyframe[] = [];

  for (let i = 0; i <= frameCount; i += 1) {
    const p = i === frameCount ? targetProgress : clamp(progressSpring.sample(((i / frameCount) * duration) / 1000).value, -0.08, 1.08);
    const opacity = clamp(p, 0, 1);
    const shift = (1 - p) * travelOffsetPx;
    const scale = scaleFrom + (1 - scaleFrom) * p;
    const translate = axis === "x" ? `translateX(${shift.toFixed(2)}px)` : `translateY(${shift.toFixed(2)}px)`;
    const transform = scaleFrom === 1 ? translate : `${translate} scale(${scale.toFixed(4)})`;
    frames.push({ opacity, transform });
  }

  const animation = element.animate(frames, {
    duration,
    easing: "linear",
    fill: visible ? "backwards" : "forwards",
  });

  const entry: ActivePresence = {
    animation,
    startTime: nowMs(),
    progressSpring,
  };
  animations.set(element, entry);

  void animation.finished
    .then(() => {
      if (animations.get(element) === entry) {
        animations.delete(element);
        animation.cancel();
        settled?.();
      }
    })
    .catch(() => {});

  return () => {
    if (animations.get(element) === entry) animations.delete(element);
    animation.cancel();
  };
}

/* ── 滚动容器触顶 / 触底弹性回弹（滚轮动量 + 触屏拖拽） ───────────────── */

const SCROLL_BOUNCE_CONTAINERS = ".content, .command-palette-list, .select-panel, .mc-list";

function resolveBounceTarget(scroller: HTMLElement): HTMLElement {
  if (scroller.classList.contains("content")) {
    const activeView = scroller.querySelector<HTMLElement>(":scope > .view:not([hidden])");
    if (activeView) return activeView;
  }
  return scroller;
}

function findBounceScroller(start: EventTarget | null): HTMLElement | null {
  if (!(start instanceof HTMLElement)) return null;
  const candidate = start.closest<HTMLElement>(SCROLL_BOUNCE_CONTAINERS);
  if (!candidate) return null;
  const style = getComputedStyle(candidate);
  if (style.overflowY !== "auto" && style.overflowY !== "scroll") {
    // 移动端 .content 退回文档流，滚动在根文档上
    if (candidate.classList.contains("content")) {
      return (document.scrollingElement as HTMLElement | null) ?? null;
    }
    return null;
  }
  return candidate;
}

function resolveVisualTarget(scroller: HTMLElement): HTMLElement | null {
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    return document.querySelector<HTMLElement>(".content > .view:not([hidden])");
  }
  // 自身带裁剪边框的浮层列表不做外框平移，只对内部视图舞台做越界回弹，保证边框与粘性头稳固
  if (scroller.classList.contains("content")) {
    return resolveBounceTarget(scroller);
  }
  return null;
}

let bounceInitialized = false;

/**
 * 在页面滚动舞台触顶或触底时，把继续输入的滚轮动量与触屏拖拽速度交给 ζ = 1 临界阻尼弹簧，
 * 产生克制的边界阻尼拉伸并平滑回弹归零；静止后立即清空行内 transform，不留包含块副作用。
 */
export function initScrollBoundaryBounce(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined" || bounceInitialized) {
    return () => {};
  }
  bounceInitialized = true;

  const springs = new WeakMap<HTMLElement, SpringAnimator>();
  const bounds: SpringBounds = { min: 0, max: 0, maxOvershoot: 28 };

  const animatorFor = (visual: HTMLElement): SpringAnimator => {
    let anim = springs.get(visual);
    if (!anim) {
      anim = createSpringAnimator(
        (offset) => {
          if (Math.abs(offset) < 0.2) {
            visual.style.transform = "";
          } else {
            visual.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
          }
        },
        {
          initial: 0,
          angularFrequency: 28,
          bounds,
          restDelta: 0.2,
          restSpeed: 2,
        },
      );
      springs.set(visual, anim);
    }
    return anim;
  };

  const onWheel = (event: WheelEvent) => {
    if (motionReduced() || event.ctrlKey || event.deltaY === 0) return;
    if (document.querySelector("dialog[open]")) return;
    const scroller = findBounceScroller(event.target);
    if (!scroller) return;
    const visual = resolveVisualTarget(scroller);
    if (!visual) return;

    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const atTop = scroller.scrollTop <= 0.5 && event.deltaY < 0;
    const atBottom = scroller.scrollTop >= maxScroll - 0.5 && event.deltaY > 0;
    if (!atTop && !atBottom) return;

    const deltaPx = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 240 : event.deltaY;
    const impulseVelocity = clamp(-deltaPx * 7.5, -900, 900);
    animatorFor(visual).impulse(impulseVelocity, bounds);
  };

  let touchScroller: HTMLElement | null = null;
  let touchVisual: HTMLElement | null = null;
  let touchStartY = 0;
  let touchDraggingBoundary = false;
  const touchVelocity = createVelocityTracker(90, 2400);

  const onTouchStart = (event: TouchEvent) => {
    if (motionReduced() || event.touches.length !== 1 || document.querySelector("dialog[open]")) {
      touchScroller = null;
      touchVisual = null;
      return;
    }
    const scroller = findBounceScroller(event.target);
    const visual = scroller ? resolveVisualTarget(scroller) : null;
    if (!scroller || !visual) {
      touchScroller = null;
      touchVisual = null;
      return;
    }
    touchScroller = scroller;
    touchVisual = visual;
    touchStartY = event.touches[0].clientY;
    touchDraggingBoundary = false;
    touchVelocity.reset();
    touchVelocity.push(0);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!touchScroller || !touchVisual || event.touches.length !== 1) return;
    const currentY = event.touches[0].clientY;
    const dy = currentY - touchStartY;
    const maxScroll = Math.max(0, touchScroller.scrollHeight - touchScroller.clientHeight);
    const pullingTop = touchScroller.scrollTop <= 0.5 && dy > 4;
    const pullingBottom = touchScroller.scrollTop >= maxScroll - 0.5 && dy < -4;

    if (!pullingTop && !pullingBottom) {
      if (touchDraggingBoundary) {
        touchDraggingBoundary = false;
        animatorFor(touchVisual).to(0, { velocity: 0 });
      }
      touchStartY = currentY;
      return;
    }

    touchDraggingBoundary = true;
    const damped = rubberBand(dy, 52, 0.48);
    touchVelocity.push(damped);
    animatorFor(touchVisual).set(damped, touchVelocity.velocity());
  };

  const finishTouch = () => {
    if (touchDraggingBoundary && touchVisual) {
      const releaseVelocity = touchVelocity.velocity();
      animatorFor(touchVisual).to(0, { velocity: releaseVelocity, bounds });
    }
    touchScroller = null;
    touchVisual = null;
    touchDraggingBoundary = false;
    touchVelocity.reset();
  };

  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", finishTouch, { passive: true });
  window.addEventListener("touchcancel", finishTouch, { passive: true });

  return () => {
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", finishTouch);
    window.removeEventListener("touchcancel", finishTouch);
    bounceInitialized = false;
  };
}
