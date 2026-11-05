import { useCallback, useEffect, useRef, useState } from "react";

import { UnauthorizedError, fetchUpstreamBalance } from "../api";
import type { BalanceResult, Upstream } from "../types";
import { useDialog } from "../useDialog";

export type BalanceProvider = "new-api" | "sub2api";

/**
 * 金额排版。
 *
 * 小额留四位小数，大额两位，尾零一律去掉。照抄旧版 formatBalanceAmount——
 * 余额常常是 0.0037 这种数量级，两位小数会直接显示成 0。
 */
function formatAmount(value: number | null | undefined, unit = "USD"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const fixed = Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return unit === "USD" ? `$${trimmed}` : `${trimmed} ${unit}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="balance-row">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

/** 两家的字段不一样：new-api 是总额/已用/剩余，sub2api 还带计划和模式。 */
function Result({ result, provider }: { result: BalanceResult; provider: BalanceProvider }) {
  const unit = result.unit || "USD";

  if (provider === "sub2api" || result.provider === "sub2api") {
    return (
      <>
        <Row label="余额" value={formatAmount(result.remaining_usd, unit)} />
        <Row label="累计实耗" value={formatAmount(result.used_usd, unit)} />
        {result.plan_name ? <Row label="计划" value={result.plan_name} /> : null}
        {typeof result.is_valid === "boolean" ? (
          <Row label="状态" value={result.is_valid ? "有效" : "无效"} />
        ) : null}
        {result.mode ? <Row label="模式" value={result.mode} /> : null}
      </>
    );
  }

  return (
    <>
      <Row label="总额" value={formatAmount(result.total_usd, unit)} />
      <Row label="已用" value={formatAmount(result.used_usd, unit)} />
      <Row label="剩余" value={formatAmount(result.remaining_usd, unit)} />
    </>
  );
}

/** 一项结果：成功显金额，失败显原因。 */
function Outcome({ result, provider }: { result: BalanceResult; provider: BalanceProvider }) {
  if (result.ok) return <Result result={result} provider={provider} />;
  return <p className="muted">{result.message || "未知错误"}</p>;
}

/** 例："3 把 Key，1 把失败"。全成或全败时只说结果。 */
function summarize(results: BalanceResult[]): string {
  const failed = results.filter((result) => !result.ok).length;
  if (failed === 0) return "查询成功";
  if (failed === results.length) return "查询失败";
  return `${results.length} 把 Key，${failed} 把失败`;
}

/**
 * 余额查询。
 *
 * 旧版是个带刷新按钮的窗口而不是一条 toast：余额要对着看、要反复刷，
 * 看完就消失的提示不顶用。
 *
 * 启用的 Key 逐把查：几把 Key 可能是几个账号，各有各的余额。只有一项时
 * 照旧平铺；多把时每把一节，空名的 Key 用 #id 称呼。不算合计——同一账号
 * 的几把 Key 报的可能是同一笔余额，加起来就重复了。
 */
export function BalanceDialog({
  open,
  upstream,
  provider,
  onClose,
}: {
  open: boolean;
  upstream: Upstream | null;
  provider: BalanceProvider;
  onClose: () => void;
}) {
  const [results, setResults] = useState<BalanceResult[] | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useDialog(open, onClose);
  /* 每次发起自增。刷新和重开都作废在途的那次——慢的那个回来时不能盖掉
     它输掉竞速的那个新结果。 */
  const queryRef = useRef(0);

  const query = useCallback(async () => {
    if (!upstream) return;
    const token = ++queryRef.current;
    setBusy(true);
    setResults(null);
    setFailure("");
    try {
      const outcome = await fetchUpstreamBalance(upstream.id, provider);
      if (token !== queryRef.current) return;
      if (outcome.keys?.length) setResults(outcome.keys);
      else setFailure("没有可查的 Key");
    } catch (err) {
      if (token !== queryRef.current) return;
      if (err instanceof UnauthorizedError) return;
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === queryRef.current) setBusy(false);
    }
  }, [upstream, provider]);

  useEffect(() => {
    if (!open) {
      // 关窗也要作废在途的：它的结果不该落进下一次打开的窗口里。
      queryRef.current += 1;
      return;
    }
    void query();
  }, [open, query]);

  const summary = busy ? "正在查询..." : results ? summarize(results) : failure ? "查询失败" : "";

  return (
    <dialog className="balance-dialog dialog--drawer" ref={dialogRef} onCancel={onClose}>
      <div className="balance-panel">
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{`${provider} 余额：${upstream?.name ?? ""}`}</h2>
            <p>{summary}</p>
          </div>
          <div className="modal-head-actions">
            <button
              type="button"
              className={busy ? "secondary ghost icon-refresh is-busy" : "secondary ghost icon-refresh"}
              aria-label="刷新"
              title="刷新"
              disabled={busy}
              onClick={() => void query()}
            >
              <svg className="dialog-icon dialog-icon--refresh" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.75-4.02" />
                <path d="M13.6 2.4v3.2h-3.2" />
              </svg>
            </button>
            <button
              type="button"
              className="secondary ghost icon-close"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4L4 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="balance-body upstream-dialog-body">
          {results?.length === 1 ? <Outcome result={results[0]} provider={provider} /> : null}
          {results && results.length > 1
            ? results.map((result) => (
                <section className="balance-key" key={result.key_id}>
                  <h3>{`Key ${result.key_name || `#${result.key_id}`}`}</h3>
                  <Outcome result={result} provider={provider} />
                </section>
              ))
            : null}
          {failure ? <p className="muted">{failure}</p> : null}
        </div>
      </div>
    </dialog>
  );
}
