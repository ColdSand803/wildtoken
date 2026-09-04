/* 梅枝背景层。移植自 antfu.me 的 ArtPlum.vue —— Canvas 2D 上一个递归的分形生长。
   原件是 Vue 组件，靠 @vueuse 的 useRafFn / useWindowSize 驱动；控制台是无构建的
   传统 script，那套依赖引不进来，所以改写成原生。

   照搬的部分：步长 random()*6、分枝偏转 ±random()*π/12、头 30 段分枝概率 0.8 之
   后 0.5、越界剪枝的 100px 宽容、40fps 的帧节流、"每步有一半概率留到下一帧"这个
   让枝条节奏参差的手法，以及从四边中间地带（0.2–0.8）各朝内起一枝、窄窗口只留
   两枝。这些数字决定了长出来的形状，动一个就不是同一棵了。

   三处有意的偏离，都在各自的位置注明：DPI 只认 devicePixelRatio、改窗口会重画、
   以及 prefers-reduced-motion 下一次画完不动。 */

const PLUM_THEMES = new Set(["co1dsand-light", "co1dsand-dark"]);
const PLUM_MIN_BRANCH = 30;
const PLUM_STEP_LEN = 6;
const PLUM_R15 = Math.PI / 12;
const PLUM_R90 = Math.PI / 2;
const PLUM_R180 = Math.PI;
const PLUM_FRAME_MS = 1000 / 40;
/* 纯兜底，正常不该碰到。生长是自限的但尾巴很重：过 30 段后分枝概率 0.5，两枝的
   期望分枝因子正好是 1，这是个临界分枝过程 —— 以概率 1 终止，可总规模的期望是无
   穷，真正拉住它的是越界剪枝。1440×900 上实测 400 次：中位 15028 段、p90 75465、
   p99 240525、最大 465357。所以上限只能定在尾巴之外，定低了就是在经常把枝条硬切
   断（20000 会截掉 43% 的生长）。留着它是因为"以概率 1 终止"不等于有上界，而
   reduced-motion 那条路要在一个同步循环里把队列抽干。 */
const PLUM_MAX_SEGMENTS = 500000;

let plumLayer = null;
let plumCanvas = null;
let plumCtx = null;
let plumFrameId = null;
let plumRestartTimer = null;
let plumSteps = [];
let plumDrawn = 0;
let plumWidth = 0;
let plumHeight = 0;
let plumLastFrame = 0;

function plumReduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* 墨色留给样式表：两套凉砂共用一个值，主题包想换只改 CSS。取不到就退回 antfu 的
   原色 #88888825（灰 136、透明度 0x25≈14.5%）——凉砂的 --line 也是这个 136，不是
   巧合，这个包本来就是从那边改编来的。 */
function plumInk() {
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue("--plum-ink").trim();
  return declared || "rgb(136 136 136 / 15%)";
}

function plumPolarToCart(x, y, radius, theta) {
  return [x + radius * Math.cos(theta), y + radius * Math.sin(theta)];
}

/* 一步 = 画一段短线，然后按概率分出左右两枝。counter 沿整棵子树共享并累加，所以
   "头 30 段"数的是这一根的深度，不是全画布的总数。 */
function plumStep(x, y, rad, counter) {
  if (plumDrawn >= PLUM_MAX_SEGMENTS) return;
  const length = Math.random() * PLUM_STEP_LEN;
  counter.value += 1;
  plumDrawn += 1;

  const [nx, ny] = plumPolarToCart(x, y, length, rad);
  plumCtx.beginPath();
  plumCtx.moveTo(x, y);
  plumCtx.lineTo(nx, ny);
  plumCtx.stroke();

  /* 越界就停，但留 100px 宽容：贴边的枝还能拐回来，一出界就剪会把边缘剃平。 */
  if (nx < -100 || nx > plumWidth + 100 || ny < -100 || ny > plumHeight + 100) return;

  const rate = counter.value <= PLUM_MIN_BRANCH ? 0.8 : 0.5;
  const rad1 = rad + Math.random() * PLUM_R15;
  const rad2 = rad - Math.random() * PLUM_R15;
  if (Math.random() < rate) plumSteps.push(() => plumStep(nx, ny, rad1, counter));
  if (Math.random() < rate) plumSteps.push(() => plumStep(nx, ny, rad2, counter));
}

/* 一帧推进一"圈"：把上一帧攒下的那批统一执行，而不是一条枝走到底。其中一半随机
   留到下一帧再走，枝与枝的节奏因此参差，不齐步。 */
function plumFrame(now) {
  plumFrameId = window.requestAnimationFrame(plumFrame);
  if (now - plumLastFrame < PLUM_FRAME_MS) return;
  plumLastFrame = now;

  const batch = plumSteps;
  plumSteps = [];
  if (!batch.length) {
    plumStopFrames();
    return;
  }
  for (const run of batch) {
    if (Math.random() < 0.5) plumSteps.push(run);
    else run();
  }
}

function plumStopFrames() {
  if (plumFrameId == null) return;
  window.cancelAnimationFrame(plumFrameId);
  plumFrameId = null;
}

/* 偏离之一：DPI 只认 devicePixelRatio。原件还兼容了一串 *BackingStorePixelRatio
   的厂商前缀，那些属性早就从各家引擎里删了，留着只是噪声。 */
function plumSizeCanvas() {
  plumWidth = window.innerWidth;
  plumHeight = window.innerHeight;
  const ratio = window.devicePixelRatio || 1;
  plumCanvas.style.width = `${plumWidth}px`;
  plumCanvas.style.height = `${plumHeight}px`;
  plumCanvas.width = Math.round(plumWidth * ratio);
  plumCanvas.height = Math.round(plumHeight * ratio);
  plumCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

/* 四边各起一枝，起点落在那条边的中段（0.2–0.8），朝画布里长。窄窗口只留上下两
   枝：四枝挤在手机宽度里会糊成一团。 */
function plumSeed() {
  const middle = () => Math.random() * 0.6 + 0.2;
  const seeds = [
    () => plumStep(middle() * plumWidth, -5, PLUM_R90, { value: 0 }),
    () => plumStep(middle() * plumWidth, plumHeight + 5, -PLUM_R90, { value: 0 }),
    () => plumStep(-5, middle() * plumHeight, 0, { value: 0 }),
    () => plumStep(plumWidth + 5, middle() * plumHeight, PLUM_R180, { value: 0 }),
  ];
  return plumWidth < 500 ? seeds.slice(0, 2) : seeds;
}

function plumGrow() {
  plumStopFrames();
  plumSizeCanvas();
  plumCtx.clearRect(0, 0, plumWidth, plumHeight);
  plumCtx.lineWidth = 1;
  plumCtx.strokeStyle = plumInk();
  plumDrawn = 0;
  plumSteps = plumSeed();

  /* 偏离之三：reduced-motion 下不逐帧长，一个循环把队列抽干，直接给写完的样子。
     与标记的笔顺动画同一个约定 —— 关掉动画得到的是完整的图，不是长了一半的。 */
  if (plumReduceMotion()) {
    while (plumSteps.length && plumDrawn < PLUM_MAX_SEGMENTS) {
      const batch = plumSteps;
      plumSteps = [];
      for (const run of batch) run();
    }
    plumSteps = [];
    return;
  }

  plumLastFrame = 0;
  plumFrameId = window.requestAnimationFrame(plumFrame);
}

/* 偏离之二：改窗口会重画。原件在博客文章里挂着，一进页面画一次就够；控制台是个
   可拖拽缩放的窗口，不重画的话枝条会连不到新的边上。防抖 200ms，拖拽过程中不会
   一路重算。 */
function plumScheduleRegrow() {
  window.clearTimeout(plumRestartTimer);
  plumRestartTimer = window.setTimeout(() => {
    if (plumLayer && !plumLayer.hidden) plumGrow();
  }, 200);
}

function plumEnsureElements() {
  if (plumLayer) return true;
  plumLayer = document.querySelector(".plum");
  plumCanvas = plumLayer?.querySelector("canvas") || null;
  if (!plumCanvas) {
    plumLayer = null;
    return false;
  }
  plumCtx = plumCanvas.getContext("2d");
  if (!plumCtx) {
    plumLayer = null;
    plumCanvas = null;
    return false;
  }
  window.addEventListener("resize", plumScheduleRegrow);
  return true;
}

/* 由 applyTheme 调用。离开凉砂就停帧并清掉画布 —— 停帧是为了不在别的主题下白烧
   CPU，清画布是因为图层只是 hidden，将来某个主题若把它显示出来不该看到旧的枝。 */
function syncPlumLayer(theme) {
  const wanted = PLUM_THEMES.has(theme);
  if (!plumEnsureElements()) return;
  if (!wanted) {
    plumStopFrames();
    window.clearTimeout(plumRestartTimer);
    plumSteps = [];
    plumCtx.clearRect(0, 0, plumWidth, plumHeight);
    plumLayer.hidden = true;
    return;
  }
  plumLayer.hidden = false;
  plumGrow();
}
