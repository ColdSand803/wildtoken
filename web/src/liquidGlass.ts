/* 液态玻璃折射引擎。
 *
 * 主题包只能是 CSS，而折射贴图必须和元素的像素尺寸一一对应，静态样式表给不出来。
 * 所以分工是：主题用 CSS 变量声明"哪些表面要折射、参数多少"，这里量尺寸、算贴图、
 * 注入 SVG 滤镜，再把 `--lg-refraction: url(#…)` 写回元素。引擎不写，主题就停在
 * 原来的模糊玻璃上——折射是增强，不是依赖。
 *
 * 折射曲线与高光贴图移植自 https://github.com/archisvaze/liquid-glass ：
 *
 *   MIT License
 *
 *   Copyright (c) 2026 Archis Vaze
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * 超椭圆角部几何与磨砂通道是这里新增的。 */

import { APPEARANCE_EVENT } from "./theme";

export interface EdgeField {
  /** 到最近边缘的距离（px），最大为圆角半径。 */
  depth: number;
  /** 指向玻璃外侧的单位法线；离所有边都超过一个半径时为零向量。 */
  nx: number;
  ny: number;
}

export interface ProfileOptions {
  thickness: number;
  bezel: number;
  ior: number;
  samples?: number;
}

export interface MapOptions {
  width: number;
  height: number;
  radius: number;
  /** 角部超椭圆指数：2 是圆弧，4 是 squircle。 */
  exponent: number;
  bezel: number;
  thickness: number;
  ior: number;
  /** 最外沿底色不透明度占中心的比例。 */
  frostEdge: number;
}

export interface GlassMaps {
  /** R、G 是 x、y 位移（128 为中性），B 是磨砂量，A 恒为 255。 */
  displacement: Uint8ClampedArray;
  /** 白色细边，alpha 是强度。 */
  specular: Uint8ClampedArray;
  /** 交给 feDisplacementMap 的 scale。 */
  scale: number;
}

/** 位移只在这么小的量级以上才算数；折射率为 1 时浮点误差会留下 1e-17 级的残差。 */
const NEGLIGIBLE_BEND = 1e-6;
/** 形状外沿多算这么宽：抗锯齿的边缘像素中心落在形状外，留成中性值会出一圈不折射的毛边。 */
const EDGE_BLEED = 1.5;
/** 磨砂在弯折带的前 80% 内回到全量：再窄清晰带只剩一条线，再宽贴边的文字就落不到实底上。 */
const FROST_REACH = 0.8;
/** 高光方向，60°，y 轴朝上。 */
const LIGHT_X = Math.cos(Math.PI / 3);
const LIGHT_Y = Math.sin(Math.PI / 3);

/**
 * 把 corner-shape 的计算值换成超椭圆指数。
 *
 * superellipse(k) 对应曲线 |x|^(2^k) + |y|^(2^k) = 1，round 是 k=1，squircle 是 k=2。
 * 斜切、内凹和直角没有可供折射的凸边，返回 null 表示这个元素不做折射。
 */
export function cornerExponent(value: string): number | null {
  const shape = value.trim().toLowerCase();
  if (shape === "" || shape === "round") return 2;
  if (shape === "squircle") return 4;
  const match = /^superellipse\(\s*(-?\d*\.?\d+)\s*\)$/.exec(shape);
  if (!match) return null;
  const k = Number(match[1]);
  return Number.isFinite(k) && k >= 1 ? 2 ** k : null;
}

/**
 * 弯折带由外到内每个采样点的横向位移（px）。
 *
 * 玻璃边缘的截面是凸超椭圆 y = (1 − (1 − x)^4)^(1/4)：最外沿近乎竖直，往里逐渐放平。
 * 垂直入射的光在表面按斯涅尔定律偏折，再穿过"该处的玻璃高度 + 厚度"落到背景上。
 */
export function refractionProfile({ thickness, bezel, ior, samples = 128 }: ProfileOptions): Float64Array {
  const profile = new Float64Array(samples);
  const eta = 1 / ior;
  for (let index = 0; index < samples; index += 1) {
    // 取区间中点，避开 x = 0 处斜率无穷大的奇点。
    const x = (index + 0.5) / samples;
    const inner = 1 - (1 - x) ** 4;
    const surfaceHeight = inner ** 0.25;
    const slope = (1 - x) ** 3 * inner ** -0.75;
    const length = Math.hypot(slope, 1);
    const nx = -slope / length;
    const ny = -1 / length;
    const k = 1 - eta * eta * (1 - ny * ny);
    if (k < 0) continue; // 全反射，只在折射率小于 1 时出现。
    const bend = eta * ny + Math.sqrt(k);
    const rayX = -bend * nx;
    const rayY = eta - bend * ny;
    profile[index] = rayX * ((surfaceHeight * bezel + thickness) / rayY);
  }
  return profile;
}

/** 带符号的边缘场：形状外 depth 为负。 */
function signedField(x: number, y: number, width: number, height: number, radius: number, exponent: number): EdgeField {
  const dx = x < radius ? x - radius : x > width - radius ? x - (width - radius) : 0;
  const dy = y < radius ? y - radius : y > height - radius ? y - (height - radius) : 0;
  if (dx === 0 && dy === 0) return { depth: radius, nx: 0, ny: 0 };
  // 直边单独走精确解。它和角部公式在数学上等价，但少一次开方，结果与指数无关——
  // 否则圆弧和超椭圆的贴图会在直边上差出 1e-15，落在取整边界时就成了肉眼可见的差一级。
  if (dy === 0) return { depth: radius - Math.abs(dx), nx: Math.sign(dx), ny: 0 };
  if (dx === 0) return { depth: radius - Math.abs(dy), nx: 0, ny: Math.sign(dy) };

  // 角部：F = ((u/r)^n + (v/r)^n)^(1/n)，曲线是 F = 1。
  // 深度取一阶近似 (1 − F) / |∇F|，n = 2 时正好是到圆弧的精确距离。
  const u = Math.abs(dx) / radius;
  const v = Math.abs(dy) / radius;
  const level = (u ** exponent + v ** exponent) ** (1 / exponent);
  const gradientU = u ** (exponent - 1);
  const gradientV = v ** (exponent - 1);
  const gradientLength = Math.hypot(gradientU, gradientV);
  const depth = ((1 - level) * radius) / (level ** (1 - exponent) * gradientLength);
  return {
    depth: Math.min(radius, depth),
    nx: (Math.sign(dx) * gradientU) / gradientLength,
    ny: (Math.sign(dy) * gradientV) / gradientLength,
  };
}

/** 某一点到边缘的深度与外法线；点在形状外时返回 null。坐标是连续的，像素中心是 x + 0.5。 */
export function edgeField(x: number, y: number, width: number, height: number, radius: number, exponent: number): EdgeField | null {
  const field = signedField(x, y, width, height, radius, exponent);
  return field.depth < 0 ? null : field;
}

/** 生成位移贴图与高光贴图。弯折带不会比圆角更宽：直边上离边缘超过一个半径的地方没有定义。 */
export function buildMaps(options: MapOptions): GlassMaps {
  const { width, height, exponent } = options;
  const radius = Math.min(options.radius, width / 2, height / 2);
  const bezel = Math.max(1, Math.min(options.bezel, radius));
  const profile = refractionProfile({ thickness: options.thickness, bezel, ior: options.ior });
  let peak = 0;
  for (const value of profile) peak = Math.max(peak, Math.abs(value));
  const bends = peak > NEGLIGIBLE_BEND;

  const displacement = new Uint8ClampedArray(width * height * 4);
  const specular = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < displacement.length; offset += 4) {
    displacement[offset] = 128;
    displacement[offset + 1] = 128;
    displacement[offset + 2] = 255;
    displacement[offset + 3] = 255;
  }

  // 内部整块都是中性值，只需要走四周一圈：上下各一个半径高的整行，中间只走左右两条带。
  const cornerRows = Math.ceil(radius) + 1;
  const sideColumns = Math.ceil(bezel) + 1;
  const frostDepth = bezel * FROST_REACH;

  const paint = (x: number, y: number): void => {
    const field = signedField(x + 0.5, y + 0.5, width, height, radius, exponent);
    const offset = (y * width + x) * 4;
    if (field.depth < -EDGE_BLEED) {
      displacement[offset + 2] = 0;
      return;
    }
    const depth = Math.max(0, field.depth);

    const rim = Math.sqrt(Math.max(0, 1 - (1 - depth) ** 2));
    const strength = Math.abs(field.nx * LIGHT_X - field.ny * LIGHT_Y) * rim;
    const light = Math.round(255 * strength);
    specular[offset] = light;
    specular[offset + 1] = light;
    specular[offset + 2] = light;
    specular[offset + 3] = Math.round(light * strength);

    if (depth >= bezel) return;
    const sample = Math.min(profile.length - 1, Math.floor((depth / bezel) * profile.length));
    const amount = bends ? profile[sample] / peak : 0;
    // 负的外法线：边缘像素从更靠里的位置取样，内容被向内拉，像隔着一块凸透镜。
    displacement[offset] = Math.round(128 - field.nx * amount * 127);
    displacement[offset + 1] = Math.round(128 - field.ny * amount * 127);
    const t = Math.min(1, depth / frostDepth);
    const frost = options.frostEdge + (1 - options.frostEdge) * t * t * (3 - 2 * t);
    displacement[offset + 2] = Math.round(255 * frost);
  };

  for (let y = 0; y < height; y += 1) {
    if (y < cornerRows || y >= height - cornerRows) {
      for (let x = 0; x < width; x += 1) paint(x, y);
      continue;
    }
    const leftEnd = Math.min(sideColumns, width);
    for (let x = 0; x < leftEnd; x += 1) paint(x, y);
    for (let x = Math.max(leftEnd, width - sideColumns); x < width; x += 1) paint(x, y);
  }

  // 通道值 c 对应的位移是 scale × (c/255 − 0.5)，满幅 ±127 约等于 ±scale/2。
  return { displacement, specular, scale: bends ? peak * 2 : 0 };
}

/* ── 控制器 ─────────────────────────────────────────────────────────────── */

export interface SurfaceBox {
  width: number;
  height: number;
  /** 四个角一致的圆角半径（px）。 */
  radius: number;
  /** corner-shape 的计算值；浏览器不支持时为空串。 */
  cornerShape: string;
}

/** 量尺寸和编码 PNG 都要真实浏览器，注入进来才能在 jsdom 里测其余部分。 */
export interface GlassEnvironment {
  /** 浏览器是否真的会渲染 backdrop-filter: url(#…)。 */
  supported: boolean;
  /** 量不出可用的圆角矩形（隐藏、四角不一致、椭圆角）时返回 null。 */
  measure(element: Element): SurfaceBox | null;
  /** RGBA 像素转 PNG data URL；做不到时返回 null。 */
  encode(pixels: Uint8ClampedArray, width: number, height: number): string | null;
}

export interface LiquidGlass {
  /** 重新读取主题声明并同步所有表面。幂等。 */
  refresh(): void;
  destroy(): void;
}

interface GlassConfig {
  selector: string;
  tint: string;
  bezel: number;
  thickness: number;
  ior: number;
  blur: number;
  specular: number;
  frostEdge: number;
  /** 所有会改变滤镜的参数拼成的缓存键片段。 */
  signature: string;
}

interface SurfacePlan {
  key: string;
  width: number;
  height: number;
  radius: number;
  exponent: number;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** 圆角小于这个值时弯折带只有几个像素，看不出效果，不值得一个滤镜。 */
const MIN_RADIUS = 6;
/** 约 1500×1000。再大的表面贴图要好几百 KB，退回模糊玻璃。 */
const MAX_AREA = 1_500_000;
/** 高光那一圈的饱和度增强，让折射进来的颜色在边缘更艳。 */
const RIM_SATURATION = 3;
/** 把位移贴图的 B 通道搬到 alpha，RGB 清零——底色由 feFlood 提供。 */
const FROST_TO_ALPHA = "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0";
/** 折射前的极轻模糊：只为抹掉位移后的锯齿，弯折带里的内容要保持清晰可辨。 */
const CRISP_BLUR = 0.4;
/** 雾化比底色晚这么多才开始（占底色爬升段的比例），给弯折带留出一圈清晰的内容。 */
const HAZE_DELAY = 0.4;
/** 会让表面出现、消失或换样式的属性。不看 style：引擎自己往上面写变量。 */
const WATCHED_ATTRIBUTES = ["class", "hidden", "open"];

function unquote(value: string): string {
  const text = value.trim();
  const quote = text[0];
  return (quote === '"' || quote === "'") && text.endsWith(quote) && text.length > 1 ? text.slice(1, -1).trim() : text;
}

function readConfig(): GlassConfig | null {
  const style = getComputedStyle(document.documentElement);
  const selector = unquote(style.getPropertyValue("--lg-refraction-surfaces"));
  if (!selector || selector === "none") return null;
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const tint = style.getPropertyValue("--lg-refraction-tint").trim() || "transparent";
  const bezel = number("--lg-refraction-bezel", 18, 1, 80);
  const thickness = number("--lg-refraction-thickness", 14, 0, 200);
  const ior = number("--lg-refraction-ior", 1.5, 1, 3);
  const blur = number("--lg-refraction-blur", 12, 0, 24);
  const specular = number("--lg-refraction-specular", 0.5, 0, 1);
  const frostEdge = number("--lg-refraction-frost-edge", 0.4, 0, 1);
  return { selector, tint, bezel, thickness, ior, blur, specular, frostEdge, signature: [tint, bezel, thickness, ior, blur, specular, frostEdge].join("|") };
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number> = {}, children: SVGElement[] = []): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

export function createLiquidGlass(environment: GlassEnvironment): LiquidGlass {
  const assigned = new Map<HTMLElement, string>();
  const filters = new Map<string, SVGFilterElement>();
  /** 编码失败过的尺寸不再重试，否则每次刷新都白算一遍贴图。 */
  const failed = new Set<string>();
  const observed = new Set<Element>();
  let host: SVGSVGElement | null = null;
  let mutations: MutationObserver | null = null;
  let resizes: ResizeObserver | null = null;
  let frame = 0;
  let counter = 0;
  let destroyed = false;

  const schedule = (): void => {
    if (frame || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };

  function release(element: HTMLElement): void {
    element.style.removeProperty("--lg-refraction");
    element.style.removeProperty("--lg-refraction-fill");
    assigned.delete(element);
  }

  function definitions(): Element {
    if (!host) {
      host = svg("svg", { width: 0, height: 0, "aria-hidden": "true", focusable: "false", style: "position:absolute;overflow:hidden;pointer-events:none" }, [svg("defs")]);
      document.body.append(host);
    }
    return host.firstElementChild as Element;
  }

  function build(plan: SurfacePlan, config: GlassConfig): SVGFilterElement | null {
    if (failed.has(plan.key)) return null;
    const { width, height } = plan;
    const maps = buildMaps({ width, height, radius: plan.radius, exponent: plan.exponent, bezel: config.bezel, thickness: config.thickness, ior: config.ior, frostEdge: config.frostEdge });
    const bendMap = environment.encode(maps.displacement, width, height);
    const rimMap = bendMap && environment.encode(maps.specular, width, height);
    if (!bendMap || !rimMap) {
      failed.add(plan.key);
      return null;
    }
    counter += 1;
    const image = (href: string, result: string) => svg("feImage", { href, x: 0, y: 0, width, height, preserveAspectRatio: "none", result });
    // 雾化遮罩：磨砂量爬过 HAZE_DELAY 之前完全不雾，之后线性拉到 1。
    // 从最外沿就开始雾的话，清晰的弯折带只剩一条细线，折射等于白做。
    const hazeStart = config.frostEdge + (1 - config.frostEdge) * HAZE_DELAY;
    const hazeSlope = 1 / Math.max(1 - hazeStart, 0.001);
    const hazeMask = `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 ${hazeSlope.toFixed(4)} 0 ${(-hazeStart * hazeSlope).toFixed(4)}`;
    // sRGB：贴图里的 128 只有在 sRGB 下才是"不位移"，线性空间里整块玻璃都会偏。
    const filter = svg("filter", { id: `lg-refraction-${counter}`, x: "0%", y: "0%", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" }, [
      // 两层模糊。弯折带要清晰才看得出折射；中央要雾，否则背后的字会透上来和玻璃上的字打架。
      svg("feGaussianBlur", { in: "SourceGraphic", stdDeviation: CRISP_BLUR, result: "crisp" }),
      image(bendMap, "map"),
      svg("feDisplacementMap", { in: "crisp", in2: "map", scale: maps.scale, xChannelSelector: "R", yChannelSelector: "G", result: "bent" }),
      svg("feGaussianBlur", { in: "bent", stdDeviation: config.blur, result: "haze" }),
      svg("feColorMatrix", { in: "map", type: "matrix", values: hazeMask, result: "centre" }),
      svg("feComposite", { in: "haze", in2: "centre", operator: "in", result: "hazed" }),
      svg("feColorMatrix", { in: "bent", type: "saturate", values: RIM_SATURATION, result: "vivid" }),
      image(rimMap, "rim"),
      svg("feComposite", { in: "vivid", in2: "rim", operator: "in", result: "vividRim" }),
      svg("feComponentTransfer", { in: "rim", result: "shine" }, [svg("feFuncA", { type: "linear", slope: config.specular })]),
      svg("feColorMatrix", { in: "map", type: "matrix", values: FROST_TO_ALPHA, result: "frost" }),
      // 颜色交给浏览器解析，这里不拆——color-mix() 之类的写法也照样能用。
      svg("feFlood", { "flood-color": config.tint, result: "tint" }),
      svg("feComposite", { in: "tint", in2: "frost", operator: "in", result: "frosted" }),
      // 清晰的折射垫底，它是不透明的，所以上面几层边缘发虚也不会露出黑边。
      svg("feMerge", {}, ["bent", "hazed", "vividRim", "frosted", "shine"].map((input) => svg("feMergeNode", { in: input }))),
    ]);
    definitions().append(filter);
    filters.set(plan.key, filter);
    return filter;
  }

  function onMutations(records: MutationRecord[]): void {
    for (const record of records) {
      // 自己往 <defs> 里加滤镜也会触发；不挡掉就成了自激。
      if (host && host.contains(record.target)) continue;
      if (record.type === "attributes") return schedule();
      for (const nodes of [record.addedNodes, record.removedNodes]) {
        for (const node of nodes) if (node.nodeType === 1 && node !== host) return schedule();
      }
    }
  }

  function activate(): void {
    if (mutations) return;
    mutations = new MutationObserver(onMutations);
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES });
    if (typeof ResizeObserver === "function") resizes = new ResizeObserver(schedule);
  }

  /** 主题不要折射时把一切收回去：别的主题不该为这个引擎付任何代价。 */
  function deactivate(): void {
    for (const element of [...assigned.keys()]) release(element);
    filters.clear();
    failed.clear();
    host?.remove();
    host = null;
    mutations?.disconnect();
    mutations = null;
    resizes?.disconnect();
    resizes = null;
    observed.clear();
  }

  function refresh(): void {
    if (destroyed) return;
    const config = environment.supported ? readConfig() : null;
    let elements: HTMLElement[] | null = null;
    if (config) {
      try {
        elements = Array.from(document.querySelectorAll<HTMLElement>(config.selector));
      } catch {
        // 选择器写错了：当作没声明，停在模糊玻璃上。
      }
    }
    if (!config || !elements) return deactivate();
    activate();

    // 先量完再写，避免读写交替逼着浏览器逐个重排。
    const plans = new Map<HTMLElement, SurfacePlan>();
    for (const element of elements) {
      const box = environment.measure(element);
      const exponent = box && cornerExponent(box.cornerShape);
      if (!box || !exponent) continue;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (box.radius < MIN_RADIUS || width < 2 || height < 2 || width * height > MAX_AREA) continue;
      const key = [width, height, box.radius.toFixed(2), exponent.toFixed(3), config.signature].join("|");
      plans.set(element, { key, width, height, radius: box.radius, exponent });
    }

    for (const element of [...assigned.keys()]) if (!plans.has(element)) release(element);
    for (const [element, plan] of plans) {
      if (assigned.get(element) === plan.key) continue;
      const filter = filters.get(plan.key) ?? build(plan, config);
      if (!filter) {
        release(element);
        continue;
      }
      element.style.setProperty("--lg-refraction", `url(#${filter.id})`);
      element.style.setProperty("--lg-refraction-fill", "transparent");
      assigned.set(element, plan.key);
    }

    // 回收没人用的滤镜：每个都带着两张 data URL，只增不减会一直涨。
    const live = new Set(assigned.values());
    for (const [key, filter] of filters) {
      if (live.has(key)) continue;
      filter.remove();
      filters.delete(key);
    }

    // 所有匹配的元素都要盯着，包括眼下量不出来的：隐藏的面板展开时尺寸从 0 变过来。
    if (resizes) {
      const current = new Set<Element>(elements);
      for (const element of observed) {
        if (current.has(element)) continue;
        resizes.unobserve(element);
        observed.delete(element);
      }
      for (const element of current) {
        if (observed.has(element)) continue;
        resizes.observe(element);
        observed.add(element);
      }
    }
  }

  // 换主题后新样式表是异步到的，appearance 事件发出时声明还是旧的；load 不冒泡，只能捕获。
  const onLoad = (event: Event): void => {
    if ((event.target as Element | null)?.localName === "link") schedule();
  };
  const transparency = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-transparency: reduce)") : null;
  window.addEventListener(APPEARANCE_EVENT, schedule);
  window.addEventListener("resize", schedule);
  document.addEventListener("load", onLoad, true);
  transparency?.addEventListener?.("change", schedule);

  return {
    refresh,
    destroy(): void {
      if (destroyed) return;
      deactivate();
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener(APPEARANCE_EVENT, schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("load", onLoad, true);
      transparency?.removeEventListener?.("change", schedule);
    },
  };
}

/* ── 浏览器接入 ─────────────────────────────────────────────────────────── */

const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];

function measureSurface(element: Element): SurfaceBox | null {
  if (!(element instanceof HTMLElement)) return null;
  // offset 尺寸不受 transform 影响：对话框入场动画带缩放，用 getBoundingClientRect 会量小。
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  if (width < 2 || height < 2) return null;
  const style = getComputedStyle(element);
  const radii = CORNERS.map((corner) => style.getPropertyValue(`border-${corner}-radius`).trim());
  const shapes = CORNERS.map((corner) => style.getPropertyValue(`corner-${corner}-shape`).trim());
  if (radii.some((radius) => radius !== radii[0]) || shapes.some((shape) => shape !== shapes[0])) return null;
  // 只认单个 px 值：百分比和 "20px 10px" 这样的椭圆角，贴图的几何对不上。
  const match = /^(\d*\.?\d+)px$/.exec(radii[0]);
  if (!match) return null;
  return { width, height, radius: Math.min(Number(match[1]), width / 2, height / 2), cornerShape: shapes[0] };
}

let scratch: HTMLCanvasElement | null = null;

function encodePixels(pixels: Uint8ClampedArray, width: number, height: number): string | null {
  try {
    scratch ??= document.createElement("canvas");
    scratch.width = width;
    scratch.height = height;
    const context = scratch.getContext("2d");
    if (!context) return null;
    const image = context.createImageData(width, height);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    const url = scratch.toDataURL("image/png");
    return url.startsWith("data:image/png") ? url : null;
  } catch {
    return null;
  }
}

/**
 * 只有 Chromium 会把 SVG 滤镜画进 backdrop-filter。
 *
 * 不能靠 CSS.supports 判断：别的浏览器同样认这个语法，只是不渲染，玻璃会变成全透明。
 */
function rendersSvgBackdropFilters(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  if (brands?.some(({ brand }) => /Chromium/.test(brand))) return true;
  return /\bChrome\//.test(navigator.userAgent);
}

/**
 * 把两个输出变量注册成不继承。
 *
 * 不注册的话，玻璃里再套一层玻璃时，里面那层会继承外层的滤镜——尺寸对不上，折射整个错位。
 */
function registerOutputs(): boolean {
  try {
    for (const name of ["--lg-refraction", "--lg-refraction-fill"]) {
      try {
        CSS.registerProperty({ name, syntax: "*", inherits: false });
      } catch (error) {
        // 重复注册（开发时热更新会重跑这里）不算失败。
        if ((error as DOMException).name !== "InvalidModificationError") return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

let instance: LiquidGlass | null = null;

/** 在应用入口调用一次。之后主题声明了折射表面就自动生效，没声明就什么都不做。 */
export function initLiquidGlass(): void {
  if (instance || typeof document === "undefined") return;
  instance = createLiquidGlass({
    supported: rendersSvgBackdropFilters() && registerOutputs(),
    measure: measureSurface,
    encode: encodePixels,
  });
  instance.refresh();
}
