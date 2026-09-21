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

/** 快捷档。填进输入框而不是替代它——填完还能接着改。 */
const EXPIRY_PRESETS = [
  { label: "7 天", value: "7d" },
  { label: "30 天", value: "30d" },
  { label: "90 天", value: "90d" },
  { label: "永不过期", value: "" },
];

const EXPIRY_ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const EXPIRY_HINT =
  "留空则永不过期。可填 30d、1d3h、90m 这类时长，或 2026-09-01 12:00 这样的时刻。";

/**
 * 解析有效期输入。
 *
 * 两种写法：绝对时刻，或多段时长的累加（1d3h）。返回 expiresAtMs 为 null
 * 表示永不过期。只给预设下拉的话设不了任意时刻。
 */
function parseExpiry(
  raw: string,
  nowMs: number,
): { ok: true; expiresAtMs: number | null } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: true, expiresAtMs: null };

  const absolute = EXPIRY_ABSOLUTE.exec(value);
  if (absolute) {
    const [, y, mo, d, h = "0", mi = "0", s = "0"] = absolute;
    if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
      return { ok: false, error: "这个时刻不存在。" };
    }
    /* new Date(2026, 1, 31) 会顺延到三月。回读一次，不合法就报错而不是猜。 */
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    if (at.getFullYear() !== Number(y) || at.getMonth() !== Number(mo) - 1 || at.getDate() !== Number(d)) {
      return { ok: false, error: "这个日期不存在。" };
    }
    return { ok: true, expiresAtMs: at.getTime() };
  }

  // 粘性正则逐段吃，没吃完就是有看不懂的字符。
  const segment = /(\d+)\s*([smhdw])\s*/y;
  const expression = value.toLowerCase();
  const seen = new Set<string>();
  let seconds = 0;
  while (segment.lastIndex < expression.length) {
    const match = segment.exec(expression);
    if (!match) return { ok: false, error: `看不懂这个有效期。${EXPIRY_HINT}` };
    if (seen.has(match[2])) return { ok: false, error: `单位 ${match[2]} 出现了两次。` };
    seen.add(match[2]);
    seconds += Number(match[1]) * UNIT_SECONDS[match[2]];
  }
  if (seconds <= 0) return { ok: false, error: "有效期要大于 0。" };
  return { ok: true, expiresAtMs: nowMs + seconds * 1000 };
}

/** 把存着的 UTC 变回输入框里可编辑的本地读数，与 parseExpiry 互为逆。 */
function expiryInputValue(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const normalized = expiresAt.includes("T") ? expiresAt : expiresAt.replace(" ", "T");
  const withZone = /[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const at = new Date(withZone);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

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
  const [expires, setExpires] = useState("");
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
    // 编辑时把现有到期时间填回输入框，保存时原样解回去，不动就不会变。
    setExpires(expiryInputValue(token?.expires_at ?? null));
  }, [open, token, groups]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  /* 边输边算，看得见结果才敢填 1d3h 这种写法。 */
  const parsedExpiry = parseExpiry(expires, Date.now());
  const expiryPreview = !parsedExpiry.ok
    ? parsedExpiry.error
    : parsedExpiry.expiresAtMs === null
      ? "永不过期"
      : new Date(parsedExpiry.expiresAtMs).toLocaleString("zh-CN", { hour12: false });

  return (
    <dialog className="upstream-dialog" ref={ref} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          // 有效期解析不过就不提交，否则会静默地存成永不过期。
          if (busy || !name.trim() || !parsedExpiry.ok) return;
          onSubmit({
            name: name.trim(),
            description: description.trim(),
            enabled,
            expires_at:
              parsedExpiry.expiresAtMs === null
                ? null
                : toUtcStamp(new Date(parsedExpiry.expiresAtMs)),
            group_id: groupId,
            limit_tokens: parseLimit(limit),
            rate_limit: rateLimit.trim() || null,
            ...(token ? {} : { token: custom.trim() || null }),
          });
        }}
      >
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{token ? `编辑令牌 #${token.id}` : "新增令牌"}</h2>
            <p>下游调用凭证。限额与有效期都可以留空表示不限。</p>
          </div>
          {/* 和其他对话框同形：icon-close 加 SVG，不是一个字符×。 */}
          <div className="modal-head-actions">
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

          {/* 自由输入加快捷档。只给下拉的话设不了 1d3h 或某个具体时刻。 */}
          <div className="field">
            <span className="field-label">有效期（可选）</span>
            <input
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
              placeholder="留空则永不过期，如 30d、1d3h"
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="expiry-presets">
              {EXPIRY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="secondary small"
                  onClick={() => setExpires(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <span className={parsedExpiry.ok ? "field-hint" : "field-hint field-hint-error"}>
              {parsedExpiry.ok ? `到期时间：${expiryPreview}` : expiryPreview}
            </span>
          </div>

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
