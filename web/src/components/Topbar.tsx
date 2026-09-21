import type { ViewId } from "../App";

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: "dashboard", label: "看板" },
  { id: "upstreams", label: "渠道" },
  { id: "logs", label: "日志" },
  { id: "tokens", label: "令牌" },
  { id: "groups", label: "分组" },
  { id: "settings", label: "设置" },
];

/**
 * 顶栏。类名照抄旧控制台——主题 CSS 里 138 个类选择器，靠的就是这些名字。
 * 组件内部怎么组织随意，往外发的 class 必须一致。
 */
export function Topbar({
  view,
  onNavigate,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
}) {
  return (
    <nav className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">
          <BrandMark />
        </span>
        <div className="brand-text">
          <h1>WildToken</h1>
          <span className="brand-label">Console</span>
        </div>
      </div>

      <div className="topbar-nav" role="tablist" aria-label="主导航">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-link"
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
        {/* 旧版控制台仍在新标签里可用。探针阶段需要一个明显的回退口，
            而不是让人自己猜 /admin 还在不在。 */}
        <a className="secondary ghost nav-logout" href="/admin">
          旧版
        </a>
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
