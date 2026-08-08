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

function renderTokenRows() {
  if (tokensLoading && !tokensLoadedOnce) {
    tokenRows.innerHTML = skeletonRowsMarkup(6, 5);
    return;
  }

  if (tokensLoadedOnce && tokens.length === 0 && !tokenFiltersActive()) {
    tokenRows.innerHTML = emptyStateCell(6, {
      title: "暂无令牌",
      copy: "还没有创建下游 API 访问令牌。",
      actionLabel: "新增令牌",
      actionId: "new-token",
    });
    return;
  }

  const filtered = getFilteredTokens();
  if (tokensLoadedOnce && filtered.length === 0) {
    tokenRows.innerHTML = noMatchStateCell(6, {
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
      <td class="muted">${escapeHtml(t.description || "—")}</td>
      <td>
        <code class="token-preview-code" title="完整令牌仅在创建时显示一次">${escapeHtml(t.token_preview)}</code>
      </td>
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

function resetTokenForm() {
  tokenIdInput.value = "";
  tokenNameInput.value = "";
  tokenDescriptionInput.value = "";
  tokenCustomInput.value = "";
  tokenCustomRow.hidden = false;
  tokenExpiresInput.value = "";
  renderExpiryPreview();
  tokenEnabledCheckbox.checked = true;
  tokenValueRow.hidden = true;
  tokenValueDisplay.textContent = "";
  tokenFormTitle.textContent = "新增令牌";
}

function openTokenDialog(mode = "new") {
  if (mode === "new") {
    resetTokenForm();
  }
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
  tokenCustomInput.value = "";
  tokenCustomRow.hidden = true;
  tokenExpiresInput.value = expiryInputValue(token.expires_at);
  renderExpiryPreview();
  tokenEnabledCheckbox.checked = token.enabled;
  tokenValueRow.hidden = true;
  tokenFormTitle.textContent = `编辑令牌：${token.name}`;
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

copyTokenButton.addEventListener("click", async () => {
  const text = tokenValueDisplay.textContent;
  if (!text) return;
  try {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      throw new Error("浏览器拒绝复制，请手动复制。");
    }
    copyTokenButton.textContent = "已复制";
    setTimeout(() => { copyTokenButton.textContent = "复制"; }, 2000);
  } catch (error) {
    setStatus(`复制失败：${error.message}`, "error");
  }
});

/* Below this a custom token is short enough to be worth stopping for. This is
   the only place the threshold exists — see the note on API_TOKEN_MIN_BYTES in
   src/models/token.rs for why the server does not enforce it. Byte length, not
   character count: the field is ASCII-only, but a pasted multi-byte character
   would make .length disagree with what the server measures. */
const TOKEN_WEAK_BYTES = 16;

function customTokenByteLength(value) {
  return new TextEncoder().encode(value).length;
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
  };
  if (id) {
    // 编辑时不要 enabled（由单独的 enabled toggle 控制）
    payload.enabled = undefined;
  } else {
    payload.enabled = tokenEnabledCheckbox.checked;
    payload.token = tokenCustomInput.value === "" ? null : tokenCustomInput.value;

    // Short custom tokens are allowed, but not by accident. Only on create —
    // editing cannot change the token — and only when one was actually typed.
    if (payload.token !== null) {
      const bytes = customTokenByteLength(payload.token);
      if (bytes < TOKEN_WEAK_BYTES) {
        const accepted = await requestConfirm({
          title: "令牌偏短",
          message:
            `这个自定义令牌只有 ${bytes} 字节，短于建议的 ${TOKEN_WEAK_BYTES} 字节。`
            + "它可被暴力枚举，任何拿到它的人都能以此调用下游 API。确认要继续创建吗？",
          confirmLabel: "仍然创建",
          cancelLabel: "返回修改",
        });
        if (!accepted) {
          tokenCustomInput.focus();
          tokenCustomInput.select();
          return;
        }
      }
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
      // 新建成功后展示完整 token
      tokenValueDisplay.textContent = result.token;
      tokenValueRow.hidden = false;
      tokenIdInput.value = result.id;
      tokenFormTitle.textContent = `令牌已创建：${result.name}`;
      // 不关闭弹窗，让用户复制
      await loadTokens();
      setStatus("令牌已创建。请复制保存。", "ok");
      return;
    }
    closeTokenDialog();
    await loadTokens();
    setStatus("令牌已保存。", "ok");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "error");
  }
});
