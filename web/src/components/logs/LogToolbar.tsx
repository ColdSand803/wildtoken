import type { LogQuery } from "../../useLogQuery";
import { ColumnMenu } from "../ColumnMenu";
import { COLUMNS } from "./columns";
import type { ColumnKey } from "./columns";

export function LogToolbar({
  query,
  visible,
  onToggleColumn,
  sensitiveHidden,
  onToggleSensitive,
}: {
  query: LogQuery;
  visible: Record<ColumnKey, boolean>;
  onToggleColumn: (key: ColumnKey) => void;
  sensitiveHidden: boolean;
  onToggleSensitive: () => void;
}) {
  return (
    <div className="log-toolbar">
      <label className="log-filter log-filter-channel">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="渠道 ID"
          aria-label="按渠道 ID 筛选日志"
          value={query.channelInput}
          onChange={(event) => query.setChannelInput(event.target.value.replace(/\D/g, ""))}
        />
      </label>
      <label className="log-filter">
        <input
          type="search"
          id="log-search"
          autoComplete="off"
          placeholder="模型、渠道、令牌、状态码…"
          aria-label="搜索日志"
          value={query.searchInput}
          onChange={(event) => query.setSearchInput(event.target.value)}
        />
      </label>
      <label className="log-filter">
        <select
          aria-label="按客户端筛选日志"
          value={query.clientFilter}
          onChange={(event) => query.changeClient(event.target.value)}
        >
          <option value="">全部客户端</option>
          {query.clientOptions.clients.map((type) => <option key={type} value={type}>{type}</option>)}
          {query.clientOptions.probes.length > 0 ? (
            <optgroup label="控制台探测">
              {query.clientOptions.probes.map((type) => <option key={type} value={type}>{type}</option>)}
            </optgroup>
          ) : null}
        </select>
      </label>
      <label className="log-filter">
        <select
          aria-label="按状态码筛选日志"
          value={query.statusFilter}
          onChange={(event) => query.changeStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="2xx">2xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
          <option value="none">无响应</option>
        </select>
      </label>
      <ColumnMenu label="日志列显示" columns={COLUMNS} visible={visible} onToggle={onToggleColumn} />
      <button
        type="button"
        className={`secondary ghost log-sensitive-toggle${sensitiveHidden ? " is-active" : ""}`}
        aria-pressed={sensitiveHidden}
        aria-label={sensitiveHidden ? "敏感信息已屏蔽，点击显示" : "敏感信息显示中，点击屏蔽"}
        title={sensitiveHidden ? "敏感信息已屏蔽" : "点击屏蔽令牌与渠道名"}
        onClick={onToggleSensitive}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path className="log-sensitive-eye" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
          {sensitiveHidden ? <line className="log-sensitive-slash" x1="3" y1="3" x2="21" y2="21" /> : null}
        </svg>
      </button>
      <div className="actions toolbar-actions">
        <span className={`live-indicator${query.connected ? " is-live" : ""}`}>
          <span className="live-dot" aria-hidden="true" />
          <span className="live-label">{query.connected ? "实时" : "已断开"}</span>
        </span>
        <button type="button" className="secondary" onClick={() => void query.reload()}>
          {query.loading ? "刷新中…" : "刷新"}
        </button>
      </div>
    </div>
  );
}

const PAGE_SIZES = [20, 50, 100, 200];

export function LogPager({ query }: { query: LogQuery }) {
  return (
    <div className="pager log-pager">
      <div className="pager-meta">
        <span className="pager-meta-text">第 {query.pageNumber} 页</span>
        <label className="pager-size-field">
          <span className="pager-size-label">每页</span>
          <select
            aria-label="日志每页条数"
            value={query.pageSize}
            onChange={(event) => query.changePageSize(Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div className="pager-actions">
        <button type="button" className="secondary" disabled={query.onLatestPage} onClick={query.goLatest}>首页</button>
        <button type="button" className="secondary" disabled={query.onLatestPage} onClick={query.previousPage}>上一页</button>
        <button type="button" className="secondary" disabled={!query.hasMore} onClick={query.nextPage}>下一页</button>
      </div>
    </div>
  );
}
