// ── 有效期 ───────────────────────────────────────────────────

/* 有效期输入接受两种写法：1d3h 这样的时长，或 2026-09-01 12:00 这样的时刻。
   时长从本机时钟起算——服务端只收绝对时间，所以这台机器的时钟偏多少，到期
   时间就偏多少。时刻按控制台统一的展示时区解读，好让输入框里填的读数和列表
   里显示回来的读数是同一个。 */
const EXPIRY_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
const EXPIRY_ABSOLUTE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const EXPIRY_INPUT_HINT = "留空则永不过期。可填 30d、1d3h、90m 这类时长，或 2026-09-01 12:00 这样的时刻。";
const EXPIRY_INPUT_ERROR = `看不懂这个有效期。${EXPIRY_INPUT_HINT}`;
/** 早于这个余量就换个颜色提醒，别等到已经过期才发现。 */
const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 解析有效期输入框。返回 { ok, expiresAtMs, error }，expiresAtMs 为 null 表示
 * 永不过期。纯函数，不碰 DOM——tests/token-expiry.test.mjs 单独跑它。
 */
function parseExpiryInput(raw, nowMs) {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, expiresAtMs: null };

  const absolute = EXPIRY_ABSOLUTE_PATTERN.exec(value);
  if (absolute) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = absolute;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
      return { ok: false, error: "这个时刻不存在。" };
    }
    // Date.UTC 会把 2026-02-31 顺延到三月。回读一次，不合法就报错而不是猜。
    const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      probe.getUTCFullYear() !== Number(year) ||
      probe.getUTCMonth() !== Number(month) - 1 ||
      probe.getUTCDate() !== Number(day)
    ) {
      return { ok: false, error: "这个日期不存在。" };
    }
    return {
      ok: true,
      expiresAtMs: consoleWallClockToTimestamp(
        Number(year),
        Number(month),
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    };
  }

  const expression = value.toLowerCase();
  const segment = /(\d+)\s*([smhdw])\s*/y;
  const seenUnits = new Set();
  let seconds = 0;
  while (segment.lastIndex < expression.length) {
    const match = segment.exec(expression);
    if (!match) return { ok: false, error: EXPIRY_INPUT_ERROR };
    const unit = match[2];
    if (seenUnits.has(unit)) {
      return { ok: false, error: `单位 ${unit} 出现了两次。` };
    }
    seenUnits.add(unit);
    seconds += Number(match[1]) * EXPIRY_UNIT_SECONDS[unit];
  }
  if (seconds <= 0) return { ok: false, error: "有效期要大于 0。" };
  return { ok: true, expiresAtMs: nowMs + seconds * 1000 };
}

function formatExpiryDistance(deltaMs) {
  if (deltaMs <= 0) return "已过期";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

function expiryBadgeTone(deltaMs) {
  if (deltaMs <= 0) return "danger";
  return deltaMs <= EXPIRY_SOON_MS ? "neutral" : "on";
}

function expiryCellMarkup(expiresAt, nowMs) {
  if (!expiresAt) return `<span class="muted">永不过期</span>`;
  const timestamp = parseLogTimestamp(expiresAt);
  if (!Number.isFinite(timestamp)) return `<span class="muted">—</span>`;
  const delta = timestamp - nowMs;
  return `<div class="token-expiry">
        <span class="token-expiry-time">${escapeHtml(logTimeFormatter.format(new Date(timestamp)))}</span>
        <span class="badge ${expiryBadgeTone(delta)}">${escapeHtml(formatExpiryDistance(delta))}</span>
      </div>`;
}

/** 把存储的 UTC 时间戳变回输入框里可编辑的读数，用控制台展示时区。 */
function expiryInputValue(expiresAt) {
  const timestamp = parseLogTimestamp(expiresAt);
  if (!Number.isFinite(timestamp)) return "";
  const pad = (value) => String(value).padStart(2, "0");
  const zoned = consoleZoneFields(timestamp);
  return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)} ${pad(zoned.hour)}:${pad(zoned.minute)}:${pad(zoned.second)}`;
}

function renderExpiryPreview() {
  const parsed = parseExpiryInput(tokenExpiresInput.value, Date.now());
  tokenExpiresPreview.classList.toggle("field-hint-error", !parsed.ok);
  if (!parsed.ok) {
    tokenExpiresPreview.textContent = parsed.error;
    return;
  }
  if (parsed.expiresAtMs === null) {
    tokenExpiresPreview.textContent = EXPIRY_INPUT_HINT;
    return;
  }
  const when = logTimeFormatter.format(new Date(parsed.expiresAtMs));
  tokenExpiresPreview.textContent = `将于 ${when} 过期 · ${formatExpiryDistance(parsed.expiresAtMs - Date.now())}`;
}

// ── 令牌 CRUD ────────────────────────────────────────────────

function startTokenRefresh() {
  if (tokenRefreshTimer !== null || !pageVisible) {
    updateLiveIndicator();
    return;
  }
  tokenRefreshTimer = window.setInterval(loadTokens, DEFAULT_REFRESH_MS);
  updateLiveIndicator();
}

function stopTokenRefresh() {
  if (tokenRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = null;
  updateLiveIndicator();
}

/* 整表每 10 秒重绘一次，复制确认态得撑过那一次重绘，否则点完刚亮起来就被刷没。
   记住是哪一行在确认，重绘时照着补回去。 */
let tokenCopyConfirmedId = null;
let tokenCopyConfirmedTimer = null;

const TOKEN_COPY_GLYPH =
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
  + `<rect x="9" y="9" width="10" height="10" rx="2"></rect>`
  + `<path d="M5 15V7a2 2 0 0 1 2-2h8"></path></svg>`;
const TOKEN_SEALED_GLYPH =
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
  + `<rect x="5" y="11" width="14" height="9" rx="2"></rect>`
  + `<path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>`;

const TOKEN_SEALED_TITLE =
  "这个令牌创建于明文保存启用之前，完整值已经无法恢复。需要完整令牌只能删除后重建。";

/* 预览片段本身就是复制按钮：表格已经八列，再塞一个独立按钮会挤掉别的列。
   按钮常驻 tab 序（不可复制的行用 aria-disabled 而不是 disabled），所以键盘用户
   一样停得上来、读得到 title 里的原因。 */
function tokenPreviewCellMarkup(token) {
  const preview = escapeHtml(token.token_preview || "");
  const name = escapeHtml(token.name);
  const sealed = !token.token;
  const confirmed = token.id === tokenCopyConfirmedId;

  const state = sealed
    ? `aria-disabled="true" aria-label="令牌 ${name} 的完整值不可复制" title="${escapeHtml(TOKEN_SEALED_TITLE)}"`
    : `aria-label="复制令牌 ${name} 的完整值" title="复制完整令牌"`;

  return `<button type="button" class="token-preview-button${confirmed ? " is-confirmed" : ""}"`
    + ` data-token-action="copy-token" data-token-id="${token.id}" ${state}>`
    + `<code class="token-preview-code">${preview}</code>`
    + `<span class="token-preview-icon" aria-hidden="true">${sealed ? TOKEN_SEALED_GLYPH : TOKEN_COPY_GLYPH}</span>`
    + `</button>`;
}

function renderTokenRows() {
  if (tokensLoading && !tokensLoadedOnce) {
    tokenRows.innerHTML = skeletonRowsMarkup(8, 5);
    return;
  }

  if (tokensLoadedOnce && tokens.length === 0 && !tokenFiltersActive()) {
    tokenRows.innerHTML = emptyStateCell(8, {
      title: "暂无令牌",
      copy: "还没有创建下游 API 访问令牌。",
      actionLabel: "新增令牌",
      actionId: "new-token",
    });
    return;
  }

  const filtered = getFilteredTokens();
  if (tokensLoadedOnce && filtered.length === 0) {
    tokenRows.innerHTML = noMatchStateCell(8, {
      title: "无匹配令牌",
      copy: "当前搜索条件下没有结果。",
      actionLabel: "清除筛选",
      actionId: "clear-token-filters",
    });
    return;
  }

  // One reading of the clock for the whole table, so every row's remaining
  // time is measured against the same instant.
  const nowMs = Date.now();
  tokenRows.innerHTML = filtered
    .map(
      (t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      ${renderDescriptionCell(t.description)}
      <td>${tokenPreviewCellMarkup(t)}</td>
      <td>${escapeHtml(t.group_name || "default")}</td>
      <td class="col-quota">${quotaCellMarkup(t)}</td>
      <td class="col-expiry">${expiryCellMarkup(t.expires_at, nowMs)}</td>
      <td class="col-status">
        <button
          type="button"
          class="status-switch ${t.enabled ? "on" : "off"}"
          data-token-action="${t.enabled ? "disable" : "enable"}"
          data-token-id="${t.id}"
          role="switch"
          aria-checked="${t.enabled ? "true" : "false"}"
          aria-label="${t.enabled ? "停用" : "启用"}令牌 ${escapeHtml(t.name)}"
          title="${t.enabled ? "点击停用" : "点击启用"}"
        >
          <span class="status-switch-track" aria-hidden="true">
            <span class="status-switch-thumb"></span>
          </span>
        </button>
      </td>
      <td class="action-cell">
        <button type="button" class="secondary small" data-token-action="edit" data-token-id="${t.id}">编辑</button>
        ${t.quota?.limit_tokens
          ? `<button type="button" class="secondary small" data-token-action="reset-usage" data-token-id="${t.id}" title="把已用量清零，限额保持不变">重置用量</button>`
          : ""}
        <button type="button" class="secondary small danger" data-token-action="delete" data-token-id="${t.id}">删除</button>
      </td>
    </tr>`,
    )
    .join("");
}

async function loadTokens() {
  const showSkeleton = !tokensLoadedOnce;
  if (showSkeleton) {
    tokensLoading = true;
    renderTokenRows();
  }
  try {
    tokens = await api("/api/admin/tokens");
    tokensLoadedOnce = true;
    renderTokenRows();
  } catch (error) {
    setStatus(`加载令牌失败：${error.message}`, "error");
  } finally {
    tokensLoading = false;
  }
}

async function handleBaseUrlAction(button) {
  const baseUrl = button.dataset.baseUrl || "";
  if (button.dataset.urlAction === "copy") {
    try {
      const copied = await copyTextToClipboard(baseUrl);
      if (!copied) throw new Error("clipboard unavailable");
      button.classList.add("is-confirmed");
      window.setTimeout(() => button.classList.remove("is-confirmed"), 1200);
      setStatus("Base URL 已复制。", "ok");
    } catch (error) {
      setStatus(`复制 Base URL 失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.urlAction === "open") {
    const url = normalizeHttpUrl(baseUrl);
    if (!url) {
      setStatus("Base URL 不是可打开的 HTTP 地址。", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/* 同一个输入框在两种模式下含义不同：新增时是「可以留空、留空就自动生成」，编辑时
   是「这就是当前生效的令牌，改了就换掉」。文案跟着模式换，别让编辑的人以为留空会
   把令牌清掉。 */
const TOKEN_CUSTOM_COPY = {
  new: {
    label: "自定义令牌（可选）",
    placeholder: "留空则自动生成",
    hint: "需为无空格的可打印 ASCII，最长 256 字节；短于 16 字节会要求二次确认。",
  },
  edit: {
    label: "令牌",
    placeholder: "",
    hint: "这是当前生效的令牌，可直接改写。改动会立即替换旧值，用旧令牌的调用方随即失效；清空则保持不变。",
  },
};

/* 编辑时记下打开表单那一刻的令牌，提交时用来判断用户到底动没动它——只改了个名字
   的人不该被一个自己没碰过的字段拦下来问「令牌偏短吗」。 */
let tokenCustomOriginal = "";
let tokenCustomCopyTimer = null;

function resetTokenCustomCopyButton() {
  window.clearTimeout(tokenCustomCopyTimer);
  tokenCustomCopyTimer = null;
  tokenCustomCopy?.classList.remove("is-confirmed");
}

/* 空值没什么可复制的（新增态、或者用户把它清空了），按钮就禁掉，免得点了没反应。 */
function syncTokenCustomCopyButton() {
  if (!tokenCustomCopy) return;
  tokenCustomCopy.disabled = tokenCustomInput.value === "";
}

function setTokenCustomField(mode, value) {
  const copy = TOKEN_CUSTOM_COPY[mode] || TOKEN_CUSTOM_COPY.new;
  tokenCustomInput.value = value;
  tokenCustomOriginal = value;
  tokenCustomInput.placeholder = copy.placeholder;
  if (tokenCustomLabel) tokenCustomLabel.textContent = copy.label;
  if (tokenCustomHint) tokenCustomHint.textContent = copy.hint;
  resetTokenCustomCopyButton();
  syncTokenCustomCopyButton();
}

function resetTokenForm() {
  tokenIdInput.value = "";
  tokenNameInput.value = "";
  tokenDescriptionInput.value = "";
  setTokenCustomField("new", "");
  tokenExpiresInput.value = "";
  renderExpiryPreview();
  tokenEnabledCheckbox.checked = true;
  tokenFormTitle.textContent = "新增令牌";
  delete tokenGroupSelect?.dataset.pendingGroupId;
  if (tokenLimitInput) {
    tokenLimitInput.value = "";
  }
}

/* 限额展示成「已用 / 剩余 / 限额」。数字按 K/M/B 缩写，免得一列全是长数字看不清；
   完整数值放 title 里。不限额的令牌只显示已用量，不编造一个剩余值出来。 */
const QUOTA_UNITS = [
  { suffix: "T", value: 1e12 },
  { suffix: "B", value: 1e9 },
  { suffix: "M", value: 1e6 },
  { suffix: "K", value: 1e3 },
];

function formatTokenCount(count) {
  const amount = Number(count) || 0;
  for (const unit of QUOTA_UNITS) {
    if (amount >= unit.value) {
      const scaled = amount / unit.value;
      // 整数就不带小数点，2.5M 这种保留一位足够看清量级。
      const text = scaled >= 100 || Number.isInteger(scaled)
        ? String(Math.round(scaled))
        : scaled.toFixed(1);
      return `${text}${unit.suffix}`;
    }
  }
  return String(amount);
}

function quotaCellMarkup(token) {
  const quota = token.quota || {};
  const used = Number(quota.used_tokens) || 0;

  if (quota.limit_tokens === null || quota.limit_tokens === undefined) {
    return `<span class="quota-cell" title="已用 ${used.toLocaleString()} tokens，未设限额">`
      + `<span class="quota-used">${formatTokenCount(used)}</span>`
      + `<span class="quota-sep">/</span><span class="muted">不限</span></span>`;
  }

  const limit = Number(quota.limit_tokens) || 0;
  const remaining = Number(quota.remaining_tokens) || 0;
  const ratio = limit > 0 ? used / limit : 0;
  // 用尽标红、接近用尽标黄，好在一列里扫出该处理哪个。
  const tone = quota.exhausted ? "danger" : ratio >= 0.8 ? "warn" : "";
  const title = `已用 ${used.toLocaleString()} / 剩余 ${remaining.toLocaleString()}`
    + ` / 限额 ${limit.toLocaleString()} tokens`;

  return `<span class="quota-cell ${tone}" title="${escapeHtml(title)}">`
    + `<span class="quota-used">${formatTokenCount(used)}</span>`
    + `<span class="quota-sep">/</span>`
    + `<span class="quota-remaining">${formatTokenCount(remaining)}</span>`
    + `<span class="quota-sep">/</span>`
    + `<span class="quota-limit">${escapeHtml(quota.limit_expression || formatTokenCount(limit))}</span>`
    + `</span>`;
}

function openTokenDialog(mode = "new") {
  if (mode === "new") {
    resetTokenForm();
  }
  // 分组列表可能在别处被改过，每次开弹窗都重新填一遍。
  fillTokenGroupOptions(tokenGroupSelect?.dataset.pendingGroupId);
  if (typeof tokenDialog.showModal === "function") {
    tokenDialog.showModal();
  } else {
    tokenDialog.setAttribute("open", "");
  }
  tokenNameInput.focus();
}

function closeTokenDialog() {
  clearDialogMaximized(tokenDialog);
  if (tokenDialog.open && typeof tokenDialog.close === "function") {
    tokenDialog.close();
  } else {
    tokenDialog.removeAttribute("open");
  }
  resetTokenForm();
}

async function editToken(token) {
  tokenIdInput.value = token.id;
  tokenNameInput.value = token.name;
  tokenDescriptionInput.value = token.description || "";
  // 明文缺失的老数据用户说已经清掉了，这里仍然兜一下，别让输入框写进 undefined。
  setTokenCustomField("edit", String(token.token || ""));
  tokenExpiresInput.value = expiryInputValue(token.expires_at);
  if (tokenLimitInput) {
    // 回填服务端算好的最短表达式，这样不动表单再保存不会改变限额。
    tokenLimitInput.value = token.quota?.limit_expression || "";
  }
  renderExpiryPreview();
  tokenEnabledCheckbox.checked = token.enabled;
  tokenFormTitle.textContent = `编辑令牌：${token.name}`;
  if (tokenGroupSelect) {
    tokenGroupSelect.dataset.pendingGroupId = String(token.group_id || 1);
  }
  openTokenDialog("edit");
}

async function handleTokenAction(button) {
  const id = Number(button.dataset.tokenId);
  const token = tokens.find((t) => t.id === id);
  if (!token) {
    setStatus("令牌已不存在，请刷新页面后重试。", "error");
    return;
  }

  if (button.dataset.tokenAction === "edit") {
    await editToken(token);
    return;
  }

  if (button.dataset.tokenAction === "copy-token") {
    // 明文没保存的历史令牌：按钮点得动，但只能解释为什么拿不到。这不是出错，
    // 用中性语气，别弹一条红的。
    if (!token.token) {
      setStatus(TOKEN_SEALED_TITLE);
      return;
    }
    try {
      const copied = await copyTextToClipboard(token.token);
      if (!copied) throw new Error("clipboard unavailable");
      button.classList.add("is-confirmed");
      tokenCopyConfirmedId = id;
      window.clearTimeout(tokenCopyConfirmedTimer);
      tokenCopyConfirmedTimer = window.setTimeout(() => {
        tokenCopyConfirmedId = null;
        // 中途重绘过的话原来那个按钮已经不在文档里了，按类名找当前这个。
        tokenRows
          .querySelector(".token-preview-button.is-confirmed")
          ?.classList.remove("is-confirmed");
      }, 1200);
      setStatus(`令牌「${token.name}」已复制。`, "ok");
    } catch (error) {
      setStatus(`复制令牌失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.tokenAction === "reset-usage") {
    /* 重置只清已用量，不动限额。要二次确认：清零之后原来的消耗记录就对不上了，
       而且一个已经用尽的令牌会立刻重新可用。 */
    const used = Number(token.quota?.used_tokens) || 0;
    const confirmed = await requestConfirm({
      title: "重置用量",
      message: `确定把令牌「${token.name}」的已用量 ${used.toLocaleString()} tokens 清零？`
        + `限额保持不变，该令牌将立即恢复可用。`,
      confirmLabel: "重置用量",
    });
    if (!confirmed) return;

    button.disabled = true;
    button.classList.add("is-busy");
    try {
      const updated = await api(`/api/admin/tokens/${id}/usage/reset`, { method: "POST" });
      Object.assign(token, updated);
      renderTokenRows();
      setStatus(`令牌 ${escapeHtml(updated.name)} 的用量已重置。`, "ok");
    } catch (error) {
      button.disabled = false;
      button.classList.remove("is-busy");
      setStatus(`重置用量失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.tokenAction === "enable" || button.dataset.tokenAction === "disable") {
    const nextEnabled = button.dataset.tokenAction === "enable";
    const originalMarkup = button.innerHTML;
    button.disabled = true;
    button.classList.add("is-busy");
    try {
      const updated = await api(`/api/admin/tokens/${id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      Object.assign(token, updated);
      renderTokenRows();
      setStatus(`令牌 ${escapeHtml(updated.name)} 已${updated.enabled ? "启用" : "停用"}。`, "ok");
    } catch (error) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.innerHTML = originalMarkup;
      setStatus(`切换令牌状态失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.tokenAction === "delete") {
    const name = token.name;
    const confirmed = await requestConfirm({
      title: "删除令牌",
      message: `确定删除令牌「${name}」？删除后无法恢复。`,
      confirmLabel: "删除令牌",
    });
    if (!confirmed) return;
    try {
      await api(`/api/admin/tokens/${id}`, { method: "DELETE" });
      await loadTokens();
      setStatus(`令牌「${name}」已删除。`, "ok");
    } catch (error) {
      setStatus(`删除失败：${error.message}`, "error");
    }
    return;
  }
}

// ── Token events ──────────────────────────────────────────

tokenRows.addEventListener("click", (event) => {
  const emptyAction = event.target.closest("button[data-empty-action]");
  if (emptyAction) {
    const action = emptyAction.dataset.emptyAction;
    if (action === "new-token") {
      openTokenDialog("new");
    } else if (action === "clear-token-filters") {
      clearTokenFilters();
    }
    return;
  }
  const button = event.target.closest("button[data-token-action]");
  if (!button) return;
  handleTokenAction(button);
});

tokenExpiresInput.addEventListener("input", renderExpiryPreview);

tokenExpiresPresets.addEventListener("click", (event) => {
  const preset = event.target.closest("button[data-expiry-preset]");
  if (!preset) return;
  tokenExpiresInput.value = preset.dataset.expiryPreset;
  renderExpiryPreview();
  tokenExpiresInput.focus();
});

dismissOnBackdropClick(tokenDialog, closeTokenDialog);

newTokenButton.addEventListener("click", () => openTokenDialog("new"));

tokenDialogClose.addEventListener("click", closeTokenDialog);
tokenResetButton.addEventListener("click", closeTokenDialog);

// 清空了就没什么可复制的，跟着输入实时开关按钮。
tokenCustomInput.addEventListener("input", () => {
  resetTokenCustomCopyButton();
  syncTokenCustomCopyButton();
});

tokenCustomCopy?.addEventListener("click", async () => {
  const text = tokenCustomInput.value;
  if (!text) return;
  try {
    const copied = await copyTextToClipboard(text);
    if (!copied) throw new Error("clipboard unavailable");
    tokenCustomCopy.classList.add("is-confirmed");
    window.clearTimeout(tokenCustomCopyTimer);
    tokenCustomCopyTimer = window.setTimeout(resetTokenCustomCopyButton, 1200);
    setStatus("令牌已复制。", "ok");
  } catch (error) {
    // 值就在输入框里，选中手动复制即可，所以只报一句就够。
    tokenCustomInput.focus();
    tokenCustomInput.select();
    setStatus(`复制令牌失败：${error.message}`, "error");
  }
});

/* Below this a custom token is short enough to be worth stopping for. This is
   the only place the threshold exists — see the note on APITokenMinBytes in
   internal/models/token.go for why the server does not enforce it. Byte length,
   not character count: the field is ASCII-only, but a pasted multi-byte
   character would make .length disagree with what the server measures. */
const TOKEN_WEAK_BYTES = 16;

function customTokenByteLength(value) {
  return new TextEncoder().encode(value).length;
}

/* 短令牌可以用，但不能是手滑用上的。创建和编辑走同一道确认——把令牌改短跟一开始就
   设得短一样能被枚举出来。返回 true 表示可以继续提交。 */
async function confirmWeakToken(value, verb) {
  const bytes = customTokenByteLength(value);
  if (bytes >= TOKEN_WEAK_BYTES) return true;

  const accepted = await requestConfirm({
    title: "令牌偏短",
    message:
      `这个令牌只有 ${bytes} 字节，短于建议的 ${TOKEN_WEAK_BYTES} 字节。`
      + `它可被暴力枚举，任何拿到它的人都能以此调用下游 API。确认要继续${verb}吗？`,
    confirmLabel: `仍然${verb}`,
    cancelLabel: "返回修改",
  });
  if (!accepted) {
    tokenCustomInput.focus();
    tokenCustomInput.select();
  }
  return accepted;
}

tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = tokenIdInput.value;
  const expiry = parseExpiryInput(tokenExpiresInput.value, Date.now());
  if (!expiry.ok) {
    renderExpiryPreview();
    setStatus(`有效期填写有误：${expiry.error}`, "error");
    tokenExpiresInput.focus();
    tokenExpiresInput.select();
    return;
  }

  const payload = {
    name: tokenNameInput.value.trim(),
    description: tokenDescriptionInput.value.trim(),
    // The server only takes absolute times, so a duration is resolved here
    // against this machine's clock and sent as the instant it lands on.
    expires_at: expiry.expiresAtMs === null ? null : toStoredTimestamp(expiry.expiresAtMs),
    group_id: Number(tokenGroupSelect?.value) || 1,
    limit_expression: tokenLimitInput?.value.trim() || "",
  };
  const customToken = tokenCustomInput.value;
  if (id) {
    // 编辑时不要 enabled（由单独的 enabled toggle 控制）
    payload.enabled = undefined;
    /* 空串 = 不动令牌；原样回传当前值后端也认作无变化。所以照原样送就行，
       不用在前端判断有没有改。 */
    payload.token = customToken;

    // 只有真被改过才问。没动过的字段不该拦住一次改名字的保存。
    if (customToken !== "" && customToken !== tokenCustomOriginal
      && !(await confirmWeakToken(customToken, "保存"))) {
      return;
    }
  } else {
    payload.enabled = tokenEnabledCheckbox.checked;
    payload.token = customToken === "" ? null : customToken;

    if (payload.token !== null && !(await confirmWeakToken(payload.token, "创建"))) {
      return;
    }
  }

  try {
    let result;
    if (id) {
      result = await api(`/api/admin/tokens/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      // 同步 enabled 状态
      if (tokenEnabledCheckbox.checked !== result.enabled) {
        await api(`/api/admin/tokens/${id}/enabled`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: tokenEnabledCheckbox.checked }),
        });
      }
    } else {
      result = await api("/api/admin/tokens", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeTokenDialog();
      await loadTokens();
      setStatus(`令牌「${result.name}」已创建，可在列表的「令牌」一列复制。`, "ok");
      return;
    }
    closeTokenDialog();
    await loadTokens();
    setStatus("令牌已保存。", "ok");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "error");
  }
});
