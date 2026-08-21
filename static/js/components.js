/* ── 公共分段条与悬浮卡 ────────────────────────────────────────────────
   看板的「状态分布」「错误时间分布」和请求详情里的「耗时瀑布」原本是三份各写
   一遍的 `<span style="width:N%">`：几何一样、悬浮时该说的话也一样，只有配色和
   语义不同。这里抽的是结构与行为，配色仍留在各自原来的 class 上——那些 class
   还挂着主题定制（themes/gojo 改了 .ops-bar-track），换名字等于把主题一起拖下水。

   悬浮卡是从延迟趋势的 .dashboard-chart-tooltip 里搬出来的同一套：右边空间不够
   就翻到左边、上下夹在容器内。四处共用一份，是为了让"鼠标放上去弹出来的那个
   框"在整个控制台里长得一样，而不是每处各自漂移。 */

/* 一段。width 传字符串就原样用——各处的小数位数是有断言的（4.8% 不是 4.80%），
   由调用方决定；传数字才按两位小数格式化。 */
function wtSegment(seg) {
  if (!seg) return "";
  const classes = ["wt-segbar-seg"];
  if (seg.className) classes.push(seg.className);
  if (seg.interactive) classes.push("is-hoverable");

  const styles = [];
  if (seg.width != null && seg.width !== "") {
    styles.push(`width:${typeof seg.width === "number" ? seg.width.toFixed(2) : seg.width}%`);
  }
  if (seg.opacity != null && seg.opacity !== "") {
    styles.push(`opacity:${seg.opacity}`);
  }

  const attrs = [`class="${classes.join(" ")}"`];
  if (styles.length) attrs.push(`style="${styles.join(";")}"`);
  for (const [key, value] of Object.entries(seg.data || {})) {
    if (value == null || value === "") continue;
    attrs.push(`data-${key}="${escapeHtml(value)}"`);
  }
  const tip = wtTipAttribute(seg.tip);
  if (tip) attrs.push(tip);
  /* 有悬浮卡时不出原生 title：两者确实会打架。指针停住不动的时候悬浮卡还在显示，
     浏览器的 title 一秒后照样弹出来，同一句话叠成两层。

     原先留着 title 的理由是"触屏和禁用 JS 时它是唯一的说明"，但这个理由不成立：
     触屏不触发 hover，原生 title 在触屏上一样不显示；界面整体由 JS 渲染，没有 JS
     时这些段根本不存在。段上另有 aria-label，读屏也不靠 title。
     没有悬浮卡的段仍然保留 title——那时它是唯一的说明，这才是真的兜底。 */
  if (seg.title && !tip) attrs.push(`title="${escapeHtml(seg.title)}"`);
  if (seg.ariaLabel) attrs.push(`aria-label="${escapeHtml(seg.ariaLabel)}"`);
  if (seg.interactive) {
    attrs.push(`role="${seg.role || "button"}"`, 'tabindex="0"');
  }
  return `<span ${attrs.join(" ")}></span>`;
}

/* 悬浮卡的内容随元素走，用一个 data 属性装完整的 {title, lines}。
   JSON 而不是分隔符拼接：桶标签里本来就可能出现 · 和 |，选哪个分隔符都得再挑一次
   转义规则，不如让 JSON 负责。 */
function wtTipAttribute(tip) {
  if (!tip || !tip.title) return "";
  const payload = {
    title: String(tip.title),
    lines: (Array.isArray(tip.lines) ? tip.lines : []).filter(Boolean).map(String),
  };
  return `data-wt-tip="${escapeHtml(JSON.stringify(payload))}"`;
}

/* 一整条。trackClass 是调用方原有的皮肤 class，公共的几何在 .wt-segbar 上。 */
function wtSegmentBar(options) {
  const config = options || {};
  const segments = Array.isArray(config.segments) ? config.segments : [];
  const body = segments.map(wtSegment).filter(Boolean).join("");
  const classes = ["wt-segbar", config.trackClass].filter(Boolean).join(" ");
  /* 轨道的 title 也得一起让位。原生 title 会由祖先代弹：段上撤掉 title 之后，
     指针停在段上时浏览器会往上找到轨道的 title 弹出来，双弹层原样复现。
     所以只要任何一段带悬浮卡，整条轨道就不出 title——轨道另有 aria-label。 */
  const hasTip = segments.some((seg) => seg && seg.tip && seg.tip.title);

  const attrs = [`class="${classes}"`];
  if (config.role !== null) attrs.push(`role="${config.role || "img"}"`);
  if (config.ariaLabel) attrs.push(`aria-label="${escapeHtml(config.ariaLabel)}"`);
  if (config.title && !hasTip) attrs.push(`title="${escapeHtml(config.title)}"`);
  return `<div ${attrs.join(" ")}>${body}</div>`;
}

/* 默认的取词方式：读 data-wt-tip。调用方需要动态内容时可以传自己的 describe。 */
function wtSegmentTip(element) {
  const raw = element?.dataset?.wtTip;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 属性被别处覆写成了非 JSON：不弹框，而不是弹一个乱码框。
    return null;
  }
}

function wtHoverCardElement(container) {
  let card = null;
  for (const child of container.children) {
    if (child.classList && child.classList.contains("wt-hovercard")) {
      card = child;
      break;
    }
  }
  if (!card) {
    card = document.createElement("div");
    card.className = "wt-hovercard";
    card.setAttribute("role", "status");
    card.hidden = true;
    container.appendChild(card);
  }
  return card;
}

function wtRenderHoverCard(card, tip) {
  if (!tip || !tip.title) return false;
  const lines = Array.isArray(tip.lines) ? tip.lines : [];
  card.innerHTML = `<strong>${escapeHtml(tip.title)}</strong>`
    + lines.filter(Boolean).map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  return true;
}

/* 把卡片摆在锚点旁边。anchor 是容器内坐标。
   右侧过了 62% 就翻到左边——再靠右弹出去就贴着容器边缘被裁；上下同样夹紧，
   顶部那一行的卡片不至于跑到面板外面去。 */
function wtPositionHoverCard(container, card, anchor) {
  const bounds = container.getBoundingClientRect();
  const gap = 12;
  const preferLeft = anchor.x > bounds.width * 0.62;
  const left = preferLeft ? anchor.x - card.offsetWidth - gap : anchor.x + gap;
  const top = Math.min(
    Math.max(gap, anchor.y - card.offsetHeight - gap),
    Math.max(gap, bounds.height - card.offsetHeight - gap),
  );
  card.style.left = `${Math.max(gap, Math.min(left, bounds.width - card.offsetWidth - gap))}px`;
  card.style.top = `${top}px`;
}

/* 每个容器只允许一个绑定。这些容器都是 innerHTML 整体重刷的（看板每次轮询、
   日志详情每次打开），重刷后必须重绑；不先解绑就会一次次叠加监听器。 */
const wtHoverCardBindings = new WeakMap();

function wtBindHoverCard(container, options) {
  if (!container) return null;
  const previous = wtHoverCardBindings.get(container);
  if (previous) previous();

  const config = options || {};
  const target = config.target || ".wt-segbar-seg";
  const describe = typeof config.describe === "function" ? config.describe : wtSegmentTip;

  container.classList.add("wt-hovercard-host");
  const card = wtHoverCardElement(container);
  let frameId = null;
  let pending = null;

  const hide = () => {
    pending = null;
    if (frameId != null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    card.hidden = true;
  };

  const paint = () => {
    frameId = null;
    if (!pending) return;
    const { element, clientX } = pending;
    // 重绘之间容器可能已经被重新渲染，这个元素就不在树上了。
    if (!container.contains(element)) {
      card.hidden = true;
      return;
    }
    if (!wtRenderHoverCard(card, describe(element))) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const bounds = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    /* 横向跟着指针走但夹在这一段之内，纵向锚在这一段的上沿：宽段（2xx 常常占
       整条）里卡片跟手，窄格里也不会飘到别的格子头上。 */
    const x = (clientX == null
      ? rect.left + rect.width / 2
      : Math.min(Math.max(clientX, rect.left), rect.right)) - bounds.left;
    wtPositionHoverCard(container, card, { x, y: rect.top - bounds.top });
  };

  const track = (event) => {
    const element = typeof event.target?.closest === "function"
      ? event.target.closest(target)
      : null;
    if (!element || !container.contains(element)) {
      hide();
      return;
    }
    pending = { element, clientX: event.clientX };
    if (frameId == null) frameId = window.requestAnimationFrame(paint);
  };

  /* 键盘可达：这些段本来就是 role="button" tabindex="0"，Tab 过去也该看得到
     悬浮卡说的是什么，否则只有鼠标用户拿得到这份信息。 */
  const focusIn = (event) => {
    const element = typeof event.target?.closest === "function"
      ? event.target.closest(target)
      : null;
    if (!element) return;
    pending = { element, clientX: null };
    if (frameId == null) frameId = window.requestAnimationFrame(paint);
  };
  const keydown = (event) => {
    if (event.key === "Escape") hide();
  };

  container.addEventListener("pointermove", track);
  container.addEventListener("pointerleave", hide);
  container.addEventListener("focusin", focusIn);
  container.addEventListener("focusout", hide);
  container.addEventListener("keydown", keydown);

  const detach = () => {
    hide();
    container.removeEventListener("pointermove", track);
    container.removeEventListener("pointerleave", hide);
    container.removeEventListener("focusin", focusIn);
    container.removeEventListener("focusout", hide);
    container.removeEventListener("keydown", keydown);
    wtHoverCardBindings.delete(container);
  };
  wtHoverCardBindings.set(container, detach);
  return detach;
}
