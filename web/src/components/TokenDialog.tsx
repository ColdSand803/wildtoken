import { useEffect, useRef, useState } from "react";

import type { APIToken } from "../types";

export interface TokenPayload {
  name: string;
  description: string;
  enabled: boolean;
  expires_at: string | null;
  group_id: number;
  limit_tokens: number | null;
  rate_limit: string | null;
  /** 只在新建时允许，留空由后端生成。 */
  token?: string | null;
}

/** 有效期快捷档。值是天数，null 表示永不过期。 */
const EXPIRY_PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "永不过期", days: null },
  { label: "7 天", days: 7 },
  { label: "30 天", days: 30 },
  { label: "90 天", days: 90 },
  { label: "365 天", days: 365 },
];

/** 后端要的是 'YYYY-MM-DD HH:MM:SS' 的 UTC，和 created_at 同形。 */
function toUtcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** 限额表达式转数字：支持 1000、10k、2.5M 三种写法。 */
function parseLimit(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmMbB])?$/.exec(text);
  if (!match) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

/* 有效期三态：具体天数 / 永不过期 / 不修改。
   编辑时默认落在 keep——原值是绝对时间，硬塞进「N 天」会在保存时
   把到期日往后推。 */
type ExpiryChoice = number | null | "keep";

export function TokenDialog({
  open,
  token,
  groups,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** null 表示新建。 */
  token: APIToken | null;
  groups: Array<{ id: number; name: string }>;
  busy: boolean;
  onSubmit: (payload: TokenPayload) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [expiresDays, setExpiresDays] = useState<ExpiryChoice>(null);
  const [groupId, setGroupId] = useState(1);
  const [limit, setLimit] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(token?.name ?? "");
    setDescription(token?.description ?? "");
    setEnabled(token?.enabled ?? true);
    setGroupId(token?.group_id ?? groups[0]?.id ?? 1);
    setLimit(token?.quota.limit_tokens === null || token === null ? "" : String(token.quota.limit_tokens));
    setRateLimit(token?.rate_limit ?? "");
    setCustom("");
    setExpiresDays(token ? "keep" : null);
  }, [open, token, groups]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const expiryPreview = (() => {
    if (expiresDays === "keep") return token?.expires_at ?? "永不过期";
    if (expiresDays === null) return "永不过期";
    const target = new Date(Date.now() + expiresDays * 86_400_000);
    return toUtcStamp(target);
  })();

  return (
    <dialog className="upstream-dialog" ref={ref} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          onSubmit({
            name: name.trim(),
            description: description.trim(),
            enabled,
            expires_at:
              expiresDays === "keep"
                ? (token?.expires_at ?? null)
                : expiresDays === null
                  ? null
                  : toUtcStamp(new Date(Date.now() + expiresDays * 86_400_000)),
            group_id: groupId,
            limit_tokens: parseLimit(limit),
            rate_limit: rateLimit.trim() || null,
            ...(token ? {} : { token: custom.trim() || null }),
          });
        }}
      >
        <div className="modal-head">
          <div>
            <h2>{token ? `编辑令牌 #${token.id}` : "新增令牌"}</h2>
            <p>下游调用凭证。限额与有效期都可以留空表示不限。</p>
          </div>
          <button type="button" className="secondary ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
          </label>

          <label className="field">
            <span className="field-label">描述</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
          </label>

          <label className="field">
            <span className="field-label">分组</span>
            <select value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <span className="field-hint">令牌只能访问所属分组里的渠道。</span>
          </label>

          <label className="field">
            <span className="field-label">限额</span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="留空不限，支持 10k / 2.5M"
              autoComplete="off"
            />
            <span className="field-hint">
              计数养在令牌行上，不随日志过期回落。
            </span>
          </label>

          <label className="field">
            <span className="field-label">限速</span>
            <input
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder="100/m"
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">有效期</span>
            <select
              value={expiresDays === "keep" ? "keep" : expiresDays === null ? "null" : String(expiresDays)}
              onChange={(e) =>
                setExpiresDays(
                  e.target.value === "keep" ? "keep" : e.target.value === "null" ? null : Number(e.target.value),
                )
              }
            >
              {token ? <option value="keep">不修改</option> : null}
              {EXPIRY_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.days === null ? "null" : preset.days}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="field-hint">到期时间：{expiryPreview}</span>
          </label>

          {token ? null : (
            <label className="field">
              <span className="field-label">自定义令牌</span>
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="留空自动生成"
                autoComplete="off"
              />
            </label>
          )}

          <label className="field">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>启用</span>
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
