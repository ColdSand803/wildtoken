import { useCallback, useState } from "react";

import { LoadError } from "../components/LoadError";
import { LogDetailDialog } from "../components/LogDetailDialog";
import { COLUMNS } from "../components/logs/columns";
import { LogTable } from "../components/logs/LogTable";
import { LogPager, LogToolbar } from "../components/logs/LogToolbar";
import { readStored, writeStored } from "../storage";
import type { RequestLog } from "../types";
import { useColumns } from "../useColumns";
import { useLogQuery } from "../useLogQuery";

const COLUMNS_STORAGE_KEY = "wildtoken_log_columns";
const SENSITIVE_STORAGE_KEY = "wildtoken_log_sensitive_hidden";

export function LogsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const query = useLogQuery(onUnauthorized);
  const columns = useColumns(COLUMNS_STORAGE_KEY, COLUMNS);
  const [sensitiveHidden, setSensitiveHidden] = useState(() => readStored(SENSITIVE_STORAGE_KEY) === "true");
  const [detail, setDetail] = useState<RequestLog | null>(null);
  const openDetail = useCallback((log: RequestLog) => setDetail(log), []);

  function toggleSensitive() {
    const next = !sensitiveHidden;
    setSensitiveHidden(next);
    writeStored(SENSITIVE_STORAGE_KEY, String(next));
  }

  return (
    <section className="view" data-view="logs">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">REQUEST STREAM</span>
            <h2>使用日志</h2><p>实时请求流与在途请求。</p>
            <p className="log-rate-pills" aria-live="polite" aria-atomic="true">
              <RatePill label="RPM" value={query.rpm} />
              <RatePill label="TPM" value={query.tpm} />
              <RatePill label="并发" value={query.activeTotal} />
            </p>
          </div>
        </div>
        <LogToolbar query={query} visible={columns.visible} onToggleColumn={columns.toggle}
          sensitiveHidden={sensitiveHidden} onToggleSensitive={toggleSensitive} />
        <LoadError error={query.error} label="日志" onRetry={query.reload} />
        <div className="log-new-entries-notice" hidden={!query.missedNew}>
          <p role="status" aria-live="polite">有新的请求日志。</p>
          <button type="button" className="secondary" onClick={query.goLatest}>返回最新</button>
        </div>
        <LogTable logs={query.logs} loading={query.loading} active={query.active} activeLatest={query.activeLatest}
          hiddenClasses={columns.hiddenClasses} sensitiveHidden={sensitiveHidden} onOpenDetail={openDetail} />
        <LogPager query={query} />
      </section>
      <LogDetailDialog open={detail !== null} log={detail} onClose={() => setDetail(null)} />
    </section>
  );
}

function RatePill({ label, value }: { label: string; value: number | null }) {
  const shown = value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");
  return <span className="log-rate-pill"><span className="log-rate-pill-label">{label}</span><span className="log-rate-value">{shown}</span></span>;
}
