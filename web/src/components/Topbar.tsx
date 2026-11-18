import { Co1dsandLogo } from "./Co1dsandLogo";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ViewId } from "../App";
import { setAdminToken } from "../api";
import {
  animatePresence,
  applyRubberBandBounds,
  createSpringAnimator,
  createVelocityTracker,
  motionReduced,
} from "../motion";
import type { SpringAnimator } from "../motion";
import {
  APPEARANCE_EVENT,
  BUILTIN_THEMES,
  THEME_LABELS,
  THEME_PACKS,
  THEME_SWATCHES,
  applyDensity,
  applyTheme,
  currentDensity,
  currentTheme,
} from "../theme";

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: "dashboard", label: "看板" },
  { id: "upstreams", label: "渠道" },
  { id: "logs", label: "日志" },
  { id: "tokens", label: "令牌" },
  { id: "groups", label: "分组" },
  { id: "debug", label: "调试" },
  { id: "images", label: "生图" },
  { id: "settings", label: "设置" },
];

const NAV_IDS = new Set<string>(NAV.map((item) => item.id));

/**
 * 顶栏与侧栏/底栏主导航。类名照抄旧控制台——主题 CSS 里 138 个类选择器，靠的就是这些名字。
 * 组件内部通过 .nav-active-thumb 驱动 ζ = 1 临界阻尼弹簧指示器，支持点击中途打断、
 * 沿菜单轴向按住拖拽、脱手速度投影与首尾边界橡皮筋回弹。
 */
export function Topbar({
  view,
  onNavigate,
}: {
  view: ViewId;
  onNavigate: (view: ViewId, releaseVelocity?: number) => void;
}) {
  const THEME_IDS = [...BUILTIN_THEMES, ...Object.keys(THEME_PACKS)];
  const [theme, setTheme] = useState(currentTheme);
  const [density, setDensity] = useState(currentDensity);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeWrapRef = useRef<HTMLDivElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  const navRef = useRef<HTMLDivElement>(null);
  const navThumbRef = useRef<HTMLSpanElement>(null);
  const navMountedRef = useRef(false);
  const navVerticalRef = useRef<boolean | null>(null);
  const navReleaseVelRef = useRef<number | undefined>(undefined);
  const navSpringsRef = useRef<{
    x: SpringAnimator;
    y: SpringAnimator;
    w: SpringAnimator;
    h: SpringAnimator;
  } | null>(null);

  const navStateRef = useRef({ view, onNavigate });
  navStateRef.current = { view, onNavigate };

  useLayoutEffect(() => {
    if (!themeMenuOpen || !themeMenuRef.current) return;
    return animatePresence(themeMenuRef.current, true);
  }, [themeMenuOpen]);

  const syncNavIndicator = useCallback((immediate = false) => {
    const nav = navRef.current;
    const thumb = navThumbRef.current;
    if (!nav || !thumb) return;

    const buttons = [...nav.querySelectorAll<HTMLElement>(".nav-link[data-view]")];
    const active =
      nav.querySelector<HTMLElement>(`.nav-link[data-view="${navStateRef.current.view}"]`) ??
      nav.querySelector<HTMLElement>(".nav-link.active");

    if (motionReduced() || !active || !buttons.length || (active.offsetWidth === 0 && active.offsetHeight === 0)) {
      delete nav.dataset.navSpring;
      thumb.style.opacity = "0";
      return;
    }

    const applyThumb = () => {
      const springs = navSpringsRef.current;
      const node = navThumbRef.current;
      if (!springs || !node) return;
      node.style.width = `${springs.w.get().toFixed(2)}px`;
      node.style.height = `${springs.h.get().toFixed(2)}px`;
      node.style.transform = `translate3d(${springs.x.get().toFixed(2)}px, ${springs.y.get().toFixed(2)}px, 0)`;
    };

    if (!navSpringsRef.current) {
      navSpringsRef.current = {
        x: createSpringAnimator(() => applyThumb(), { initial: active.offsetLeft, angularFrequency: 28 }),
        y: createSpringAnimator(() => applyThumb(), { initial: active.offsetTop, angularFrequency: 28 }),
        w: createSpringAnimator(() => applyThumb(), { initial: active.offsetWidth, angularFrequency: 30 }),
        h: createSpringAnimator(() => applyThumb(), { initial: active.offsetHeight, angularFrequency: 30 }),
      };
    }

    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const vertical = Math.abs(last.offsetTop - first.offsetTop) > Math.abs(last.offsetLeft - first.offsetLeft);
    const axisSwitched = navVerticalRef.current !== null && navVerticalRef.current !== vertical;
    navVerticalRef.current = vertical;

    nav.dataset.navSpring = "true";
    thumb.style.opacity = "1";

    if (!navMountedRef.current || immediate || axisSwitched) {
      navMountedRef.current = true;
      navReleaseVelRef.current = undefined;
      navSpringsRef.current.x.set(active.offsetLeft);
      navSpringsRef.current.y.set(active.offsetTop);
      navSpringsRef.current.w.set(active.offsetWidth);
      navSpringsRef.current.h.set(active.offsetHeight);
      return;
    }

    const releaseVel = navReleaseVelRef.current;
    navReleaseVelRef.current = undefined;

    if (vertical) {
      const tops = buttons.map((btn) => btn.offsetTop);
      navSpringsRef.current.y.to(active.offsetTop, {
        velocity: releaseVel,
        bounds: { min: Math.min(...tops), max: Math.max(...tops), maxOvershoot: 14 },
      });
      navSpringsRef.current.x.to(active.offsetLeft);
    } else {
      const lefts = buttons.map((btn) => btn.offsetLeft);
      navSpringsRef.current.x.to(active.offsetLeft, {
        velocity: releaseVel,
        bounds: { min: Math.min(...lefts), max: Math.max(...lefts), maxOvershoot: 14 },
      });
      navSpringsRef.current.y.to(active.offsetTop);
    }
    navSpringsRef.current.w.to(active.offsetWidth);
    navSpringsRef.current.h.to(active.offsetHeight);
  }, []);

  useLayoutEffect(() => {
    syncNavIndicator(false);
  }, [view, theme, density, syncNavIndicator]);

  // 监听窗口断点切换、主题包异步加载完成，保证侧栏与底栏切换时滑块几何即时贴合
  useEffect(() => {
    const onResize = () => syncNavIndicator(true);
    const onStylesheetLoad = (event: Event) => {
      if ((event.target as Element | null)?.localName === "link") {
        window.requestAnimationFrame(() => syncNavIndicator(true));
      }
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("load", onStylesheetLoad, true);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("load", onStylesheetLoad, true);
    };
  }, [syncNavIndicator]);

  // 主导航按住拖拽手势：自动适配桌面纵向侧栏与手机横向底栏，带脱手速度与首尾边界回弹
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startPos = 0;
    let vertical = true;
    let dragging = false;
    let suppressClick = false;
    const tracker = createVelocityTracker(90, 3200);

    const onPointerDown = (event: PointerEvent) => {
      if (motionReduced() || event.button !== 0 || !navSpringsRef.current) return;
      const buttons = [...nav.querySelectorAll<HTMLElement>(".nav-link[data-view]")];
      if (buttons.length < 2 || (buttons[0].offsetWidth === 0 && buttons[0].offsetHeight === 0)) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      vertical = Math.abs(last.offsetTop - first.offsetTop) > Math.abs(last.offsetLeft - first.offsetLeft);
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startPos = vertical ? navSpringsRef.current.y.get() : navSpringsRef.current.x.get();
      dragging = false;
      tracker.reset();
      tracker.push(startPos);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || !navSpringsRef.current) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const primaryDelta = vertical ? dy : dx;
      const crossDelta = vertical ? dx : dy;

      if (!dragging) {
        if (Math.abs(crossDelta) > 10 && Math.abs(crossDelta) > Math.abs(primaryDelta)) {
          pointerId = null;
          return;
        }
        if (Math.abs(primaryDelta) < 5) return;
        dragging = true;
        suppressClick = true;
        try {
          nav.setPointerCapture?.(event.pointerId);
        } catch {}
      }

      const buttons = [...nav.querySelectorAll<HTMLElement>(".nav-link[data-view]")];
      if (!buttons.length) return;
      const positions = buttons.map((btn) => (vertical ? btn.offsetTop : btn.offsetLeft));
      const minPos = Math.min(...positions);
      const maxPos = Math.max(...positions);
      const dampedPos = applyRubberBandBounds(startPos + primaryDelta, minPos, maxPos, 28, 0.45);

      tracker.push(dampedPos);
      const primarySpring = vertical ? navSpringsRef.current.y : navSpringsRef.current.x;
      primarySpring.set(dampedPos, tracker.velocity());

      const thumbSpan = vertical ? navSpringsRef.current.h.get() : navSpringsRef.current.w.get();
      const center = dampedPos + thumbSpan / 2;
      let nearest = buttons[0];
      let bestDist = Infinity;
      for (const btn of buttons) {
        const btnCenter = (vertical ? btn.offsetTop : btn.offsetLeft) + (vertical ? btn.offsetHeight : btn.offsetWidth) / 2;
        const dist = Math.abs(btnCenter - center);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = btn;
        }
      }
      navSpringsRef.current.w.to(nearest.offsetWidth, { angularFrequency: 34 });
      navSpringsRef.current.h.to(nearest.offsetHeight, { angularFrequency: 34 });
    };

    const finishDrag = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!dragging || !navSpringsRef.current) return;
      dragging = false;

      const releaseVel = cancelled ? 0 : tracker.velocity();
      const buttons = [...nav.querySelectorAll<HTMLElement>(".nav-link[data-view]")];
      if (!buttons.length) return;
      const positions = buttons.map((btn) => (vertical ? btn.offsetTop : btn.offsetLeft));
      const minPos = Math.min(...positions);
      const maxPos = Math.max(...positions);

      const primarySpring = vertical ? navSpringsRef.current.y : navSpringsRef.current.x;
      const thumbSpan = vertical ? navSpringsRef.current.h.get() : navSpringsRef.current.w.get();
      const projectedCenter = primarySpring.get() + thumbSpan / 2 + releaseVel * 0.055;

      let targetBtn = buttons[0];
      let bestDist = Infinity;
      for (const btn of buttons) {
        const btnCenter = (vertical ? btn.offsetTop : btn.offsetLeft) + (vertical ? btn.offsetHeight : btn.offsetWidth) / 2;
        const dist = Math.abs(btnCenter - projectedCenter);
        if (dist < bestDist) {
          bestDist = dist;
          targetBtn = btn;
        }
      }

      const nextView = targetBtn.dataset.view;
      const { view: currentView, onNavigate: navigate } = navStateRef.current;
      if (!cancelled && nextView && nextView !== currentView && NAV_IDS.has(nextView)) {
        navReleaseVelRef.current = releaseVel;
        navigate(nextView as ViewId, releaseVel);
      } else {
        const active =
          nav.querySelector<HTMLElement>(`.nav-link[data-view="${currentView}"]`) ?? targetBtn;
        const targetPos = vertical ? active.offsetTop : active.offsetLeft;
        primarySpring.to(targetPos, {
          velocity: releaseVel,
          bounds: { min: minPos, max: maxPos, maxOvershoot: 14 },
        });
        navSpringsRef.current.w.to(active.offsetWidth);
        navSpringsRef.current.h.to(active.offsetHeight);
      }
    };

    const onPointerUp = (event: PointerEvent) => finishDrag(event, false);
    const onPointerCancel = (event: PointerEvent) => finishDrag(event, true);
    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    nav.addEventListener("pointerdown", onPointerDown);
    nav.addEventListener("pointermove", onPointerMove);
    nav.addEventListener("pointerup", onPointerUp);
    nav.addEventListener("pointercancel", onPointerCancel);
    nav.addEventListener("click", onClickCapture, true);
    return () => {
      nav.removeEventListener("pointerdown", onPointerDown);
      nav.removeEventListener("pointermove", onPointerMove);
      nav.removeEventListener("pointerup", onPointerUp);
      nav.removeEventListener("pointercancel", onPointerCancel);
      nav.removeEventListener("click", onClickCapture, true);
      if (navSpringsRef.current) {
        navSpringsRef.current.x.destroy();
        navSpringsRef.current.y.destroy();
        navSpringsRef.current.w.destroy();
        navSpringsRef.current.h.destroy();
        navSpringsRef.current = null;
      }
    };
  }, []);

  /* 设置页也能改外观。不跟着重读的话，这里会拿着旧值，下一次点切换
     看上去没反应。 */
  useEffect(() => {
    const sync = () => {
      setTheme(currentTheme());
      setDensity(currentDensity());
    };
    window.addEventListener(APPEARANCE_EVENT, sync);
    return () => window.removeEventListener(APPEARANCE_EVENT, sync);
  }, []);

  // 点菜单外面或按 Esc 收起，和旧版行为一致。
  useEffect(() => {
    if (!themeMenuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!themeWrapRef.current?.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenuOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [themeMenuOpen]);

  function chooseTheme(next: string) {
    applyTheme(next);
    setTheme(next);
    setThemeMenuOpen(false);
  }

  function toggleDensity() {
    const next = density === "compact" ? "comfortable" : "compact";
    applyDensity(next);
    setDensity(next);
  }

  function logout() {
    // 清掉令牌后复用 401 那条通路，让 App 弹登录框——不另造一套。
    setAdminToken("");
    window.dispatchEvent(
      new CustomEvent<string>("console:unauthorized", { detail: "已退出，请重新输入管理员令牌。" }),
    );
  }

  const compact = density === "compact";

  return (
    <nav className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">
          <BrandMark />
          <Co1dsandLogo />
        </span>
        <div className="brand-text">
          <h1>WildToken</h1>
          <span className="brand-label">Admin</span>
        </div>
      </div>

      <div className="topbar-nav" role="tablist" aria-label="主导航" ref={navRef}>
        <span className="nav-active-thumb" aria-hidden="true" ref={navThumbRef} />
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            /* 高亮认 .nav-link.active——base.css 和每个主题包都只写了这个选择器，
               光发 aria-selected 的话当前页在任何主题下都不会亮。 */
            className={view === item.id ? "nav-link active" : "nav-link"}
            role="tab"
            aria-selected={view === item.id}
            data-view={item.id}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="topbar-actions">
        {/* 自动刷新指示。旧版默认收起，只在轮询期间露出。 */}
        <span className="live-indicator" hidden title="自动刷新中">
          <span className="live-dot" aria-hidden="true" />
          <span className="live-label">实时</span>
        </span>

        <button
          type="button"
          className="secondary ghost density-toggle"
          aria-label={compact ? "切换到舒适密度" : "切换到紧凑密度"}
          title={compact ? "当前：紧凑 · 点击切换" : "当前：舒适 · 点击切换"}
          onClick={toggleDensity}
        >
          <span className="density-toggle-label">{compact ? "紧凑" : "舒适"}</span>
        </button>

        <div className="theme-menu-wrap" ref={themeWrapRef}>
          <button
            type="button"
            className="secondary ghost theme-toggle"
            aria-label="选择主题"
            title="选择主题"
            aria-haspopup="menu"
            aria-expanded={themeMenuOpen}
            onClick={() => setThemeMenuOpen((open) => !open)}
          >
            <span className="theme-toggle-icon" aria-hidden="true" />
          </button>
          <div className="theme-menu" ref={themeMenuRef} role="menu" aria-label="主题列表" hidden={!themeMenuOpen}>
            {THEME_IDS.map((id) => {
              const swatch = THEME_SWATCHES[id] ?? ["#000000", "#ffffff"];
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === id}
                  data-theme-choice={id}
                  onClick={() => chooseTheme(id)}
                >
                  <span className="theme-swatch-pair" aria-hidden="true">
                    <span className="theme-swatch" style={{ "--swatch-color": swatch[0] } as React.CSSProperties} />
                    <span className="theme-swatch" style={{ "--swatch-color": swatch[1] } as React.CSSProperties} />
                  </span>
                  <span>{THEME_LABELS[id] ?? id}</span>
                </button>
              );
            })}
          </div>
        </div>

        <button type="button" className="secondary ghost nav-logout" onClick={logout}>
          退出
        </button>
      </div>
    </nav>
  );
}

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <path
        d="M32 14v18M32 32l15 10M32 32L17 42"
        stroke="var(--brand-ink)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="14" r="4.5" fill="var(--brand-ink)" />
      <circle cx="47" cy="42" r="4.5" fill="var(--brand-ink)" />
      <circle cx="17" cy="42" r="4.5" fill="var(--brand-ink)" />
      <circle cx="32" cy="32" r="7" fill="var(--brand-ink)" />
      <circle cx="32" cy="32" r="3" fill="currentColor" />
    </svg>
  );
}
