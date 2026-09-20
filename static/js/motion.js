/* ── 显隐过渡 ──────────────────────────────────────────────────────────
   控制台里有几十处 `el.hidden = true/false`：悬浮卡、列菜单、批量操作条、
   日志详情块、筛选徽标。`hidden` 是 display 开关，display 不可插值，CSS
   对这类面完全无能为力——它们一律瞬间出现、瞬间消失。

   这里补上进出场，用的是和 logs.js 速率强调同一套 Web Animations API
   （element.animate），不引第三方动画库。

   三条边界，接入调用方时要一并守住：

   - 显隐语义不变。显示是同步的（先落 hidden = false，再起动画），隐藏是
     异步的（动画跑完才落 hidden）。调用方不需要 await，也不会看到反态。
   - 退场只写 opacity / transform，结束后 cancel 掉自身，不留残余
     transform。base.css 的 panel-in 就是被常驻 transform 坑过：它建出
     层叠上下文，把弹层的 z-index 关在面板内部，rail 反而压在上面。
   - 用户要求减少动效、或环境没有 WAAPI 时直接落最终态。测试跑在裸 vm
     里，没有 WAAPI，走的就是这条路，所以对调用方是透明的。

   三个动画的时长都短，是为了让"过渡"读起来像"响应快"而不是"在等"。 */

const WT_REVEAL_DURATION_MS = 160;
const WT_HIDE_DURATION_MS = 120;
const WT_MOTION_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const WT_MOTION_OFFSET_PX = 4;

/* 每个元素只允许一段显隐动画在跑。连点菜单时后一次调用会取消前一次，
   否则两段动画会抢同一个元素，最终态取决于谁的 finish 先到。 */
const wtMotionAnimations = new WeakMap();

function wtMotionReduced() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* 能不能动。判据集中在两处：用户的减少动效偏好、以及有没有 WAAPI。 */
function wtMotionEnabled(element) {
  return !wtMotionReduced() && typeof element?.animate === "function";
}

/* 接管这个元素：取消上一段（如果还在跑），换来"最后调用者说了算"。 */
function wtMotionTakeOver(element, animation) {
  const previous = wtMotionAnimations.get(element);
  if (previous && previous !== animation) previous.cancel();
  wtMotionAnimations.set(element, animation);
  return animation;
}

/* 显示。先同步落 hidden = false，调用方和测试看到的可用性不变，只是视觉上
   多了几十毫秒的淡入。offsetY 默认让面从略上方落下来。
   不传 duration 时用 WT_REVEAL_DURATION_MS。 */
function wtReveal(element, options) {
  if (!element) return null;
  const config = options || {};
  /* 已经显示、且没有动画在跑：不重放淡入。列表里每次切换详情都闪一下，
     比没有过渡更烦人。但如果正有一段退场在跑（用户又把它打开了），必须接管，
     否则它照旧会把自己藏起来。 */
  if (!element.hidden && !wtMotionAnimations.get(element)) return null;
  element.hidden = false;
  if (!wtMotionEnabled(element)) return null;

  const offsetY = config.offsetY ?? -WT_MOTION_OFFSET_PX;
  const animation = element.animate(
    [
      { opacity: 0, transform: `translateY(${offsetY}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    {
      duration: config.duration ?? WT_REVEAL_DURATION_MS,
      easing: WT_MOTION_EASING,
      /* 起手第一帧就要压在 opacity: 0 上，否则元素会先以全不透明闪一下
         再开始淡入。 */
      fill: "backwards",
    },
  );
  /* 跑完就把记录撤掉：留着的话，下一次 wtReveal 会以为"还有一段在跑"，
     于是对已经显示的面重放淡入——正好是这个守卫要避免的事。 */
  const settle = () => {
    if (wtMotionAnimations.get(element) === animation) wtMotionAnimations.delete(element);
  };
  animation.addEventListener("finish", settle, { once: true });
  return wtMotionTakeOver(element, animation);
}

/* 隐藏。动画跑完才落 hidden = true；期间 fill: "forwards" 替它顶着
   opacity: 0，收尾时连同填充一起撤掉，不给下一次显示留残余样式。
   onSettled 在落下 hidden（或降级为立即隐藏）之后调用，给"收起后才能做的
   清理"用——比如清掉菜单的左/右内联位，清早了它会在淡出途中先跳回默认位。 */
function wtHide(element, options) {
  if (!element) return null;
  const config = options || {};
  const onSettled = typeof config.onSettled === "function" ? config.onSettled : null;
  /* 已经是隐藏态：没有动画可放，但收尾清理必须照跑，否则调用方会连
     "顺手把内容清空"这种事一起丢掉。 */
  if (element.hidden) {
    if (onSettled) onSettled();
    return null;
  }
  if (!wtMotionEnabled(element)) {
    element.hidden = true;
    if (onSettled) onSettled();
    return null;
  }

  const offsetY = config.offsetY ?? -WT_MOTION_OFFSET_PX;
  const animation = element.animate(
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: `translateY(${offsetY}px)` },
    ],
    {
      duration: config.duration ?? WT_HIDE_DURATION_MS,
      easing: WT_MOTION_EASING,
      fill: "forwards",
    },
  );

  const settle = () => {
    /* 动画期间这个面可能已经被重新显示（重新打开的菜单、重新展开的详情）。
       那时 WeakMap 里挂的已经不是这一段，就不该再把元素藏起来。 */
    if (wtMotionAnimations.get(element) !== animation) return;
    element.hidden = true;
    wtMotionAnimations.delete(element);
    animation.cancel();
    if (onSettled) onSettled();
  };
  animation.addEventListener("finish", settle, { once: true });
  return wtMotionTakeOver(element, animation);
}
