const ADMIN_TOKEN_KEY = "wildtoken_admin_token";
const adminTokenDialog = document.querySelector("#admin-token-dialog");
const adminTokenForm = document.querySelector("#admin-token-form");
const adminTokenInput = document.querySelector("#admin-token-input");
const adminTokenError = document.querySelector("#admin-token-error");
const adminLogoutButton = document.querySelector("#admin-logout");

const balanceDialog = document.querySelector("#balance-dialog");
const balanceTitle = document.querySelector("#balance-title");
const balanceSummary = document.querySelector("#balance-summary");
const balanceBody = document.querySelector("#balance-body");
const balanceClose = document.querySelector("#balance-close");

const toastRegion = document.querySelector("#toast-region");
const upstreamActionMenu = document.querySelector("#upstream-action-menu");
const rows = document.querySelector("#upstream-rows");
const upstreamSummary = document.querySelector("#upstream-summary");
const form = document.querySelector("#upstream-form");
const formTitle = document.querySelector("#form-title");
const newButton = document.querySelector("#new-upstream");
const resetButton = document.querySelector("#reset-form");
const fetchModelsButton = document.querySelector("#fetch-models");
const upstreamDialog = document.querySelector("#upstream-dialog");
const upstreamDialogClose = document.querySelector("#upstream-dialog-close");
const advancedSettings = document.querySelector("#advanced-settings");

const quickImportButton = document.querySelector("#quick-import");
const quickImportDialog = document.querySelector("#quick-import-dialog");
const quickImportClose = document.querySelector("#quick-import-close");
const quickImportCancel = document.querySelector("#quick-import-cancel");
const quickImportText = document.querySelector("#quick-import-text");
const quickImportBaseUrlInput = document.querySelector("#quick-import-baseurl");
const quickImportApiKeyInput = document.querySelector("#quick-import-apikey");
const quickImportFillButton = document.querySelector("#quick-import-fill");

const navLinks = document.querySelectorAll(".nav-link");
const views = document.querySelectorAll(".view");
const DEFAULT_VIEW = "upstreams";

const logStatusBox = document.querySelector("#log-status");
const logRows = document.querySelector("#log-rows");
const logUpstreamFilter = document.querySelector("#log-upstream-filter");
const logRefreshButton = document.querySelector("#log-refresh");
const logPrevButton = document.querySelector("#log-prev");
const logNextButton = document.querySelector("#log-next");
const logDetailDialog = document.querySelector("#log-detail-dialog");
const logDetailTitle = document.querySelector("#log-detail-title");
const logDetailSummary = document.querySelector("#log-detail-summary");
const logDetailMeta = document.querySelector("#log-detail-meta");
const logDetailClose = document.querySelector("#log-detail-close");
const logDetailSections = document.querySelectorAll(".log-detail-section");
let currentLogDetail = null;
const LOG_PAGE_SIZE = 50;
const LOG_REFRESH_MS = 10000;
let logOffset = 0;
let logHasMore = false;
let logRefreshTimer = null;

const UPSTREAM_REFRESH_MS = 10000;
let upstreamRefreshTimer = null;

const BACKOFF_TICK_MS = 1000;
const MAX_MODEL_CHIPS = 5;
let backoffTickTimer = null;

const modelDialog = document.querySelector("#model-dialog");
const modelDialogTitle = document.querySelector("#model-dialog-title");
const modelDialogSummary = document.querySelector("#model-dialog-summary");
const modelDialogClose = document.querySelector("#model-dialog-close");
const modelFilter = document.querySelector("#model-filter");
const modelOptions = document.querySelector("#model-options");
const modelSelectAllButton = document.querySelector("#model-select-all");
const modelClearAllButton = document.querySelector("#model-clear-all");
const modelSaveSelectionButton = document.querySelector("#model-save-selection");
const modelCancelSelectionButton = document.querySelector("#model-cancel-selection");

const fields = {
  id: document.querySelector("#upstream-id"),
  name: document.querySelector("#name"),
  baseUrl: document.querySelector("#base-url"),
  apiKey: document.querySelector("#api-key"),
  modelNames: document.querySelector("#model-names"),
  modelPrefixes: document.querySelector("#model-prefixes"),
  modelMappings: document.querySelector("#model-mappings"),
  priority: document.querySelector("#priority"),
  timeoutSeconds: document.querySelector("#timeout-seconds"),
  extraHeaders: document.querySelector("#extra-headers"),
  enabled: document.querySelector("#enabled"),
  clearApiKey: document.querySelector("#clear-api-key"),
};

// ── 令牌管理 ────────────────────────────────────────────────
const tokenRows = document.querySelector("#token-rows");
const tokenDialog = document.querySelector("#token-dialog");
const tokenForm = document.querySelector("#token-form");
const tokenFormTitle = document.querySelector("#token-form-title");
const tokenDialogClose = document.querySelector("#token-dialog-close");
const newTokenButton = document.querySelector("#new-token");
const tokenResetButton = document.querySelector("#token-reset-form");
const copyTokenButton = document.querySelector("#copy-token");
const tokenValueRow = document.querySelector("#token-value-row");
const tokenNameInput = document.querySelector("#token-name");
const tokenDescriptionInput = document.querySelector("#token-description");
const tokenCustomRow = document.querySelector("#token-custom-row");
const tokenCustomInput = document.querySelector("#token-custom");
const tokenEnabledCheckbox = document.querySelector("#token-enabled");
const tokenIdInput = document.querySelector("#token-id");
const tokenValueDisplay = document.querySelector("#token-value-display");

const TOKEN_REFRESH_MS = 10000;
let tokenRefreshTimer = null;
let tokens = [];

let upstreams = [];
let activeActionMenuButton = null;
let lastUpstreamLoadError = "";
const modelDialogState = {
  upstream: null,
  mode: "form",
  models: [],
  selected: new Set(),
};

function setStatus(message, tone = "neutral") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = tone;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");

  const messageBox = document.createElement("div");
  messageBox.className = "toast-message";
  messageBox.textContent = message;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "toast-close";
  closeButton.setAttribute("aria-label", "关闭消息");
  closeButton.title = "关闭";
  closeButton.textContent = "×";

  toast.append(messageBox, closeButton);
  toastRegion.append(toast);
  showPopoverLayer(toastRegion, true);

  while (toastRegion.children.length > 4) {
    toastRegion.firstElementChild.remove();
  }

  const duration = tone === "error" ? 6000 : tone === "ok" ? 4000 : 3000;
  let dismissTimer = window.setTimeout(() => dismissToast(toast), duration);
  const restartTimer = () => {
    window.clearTimeout(dismissTimer);
    dismissTimer = window.setTimeout(() => dismissToast(toast), duration);
  };

  toast.addEventListener("mouseenter", () => window.clearTimeout(dismissTimer));
  toast.addEventListener("mouseleave", restartTimer);
  closeButton.addEventListener("click", () => {
    window.clearTimeout(dismissTimer);
    dismissToast(toast);
  });
}

function dismissToast(toast) {
  if (!toast.isConnected || toast.classList.contains("is-leaving")) {
    return;
  }
  toast.classList.add("is-leaving");
  window.setTimeout(() => {
    toast.remove();
    if (toastRegion.children.length === 0) {
      hidePopoverLayer(toastRegion);
    }
  }, 180);
}

function popoverIsOpen(element) {
  return typeof element.showPopover === "function" && element.matches(":popover-open");
}

function showPopoverLayer(element, bringToFront = false) {
  element.hidden = false;
  if (typeof element.showPopover !== "function") {
    return;
  }
  try {
    if (bringToFront && popoverIsOpen(element)) {
      element.hidePopover();
    }
    if (!popoverIsOpen(element)) {
      element.showPopover();
    }
  } catch {
    // The fixed-position fallback remains visible when Popover API is unavailable.
  }
}

function hidePopoverLayer(element) {
  if (popoverIsOpen(element)) {
    element.hidePopover();
  }
  element.hidden = true;
}

function splitList(value) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value) {
  return (value || []).join(", ");
}

function parseModelMappings(value) {
  const mappings = {};
  for (const line of value.split(/\n/)) {
    const clean = line.trim();
    if (!clean) {
      continue;
    }
    const match = clean.match(/^(.+?)(?:=>|=|:)(.+)$/);
    if (!match) {
      throw new Error(`模型映射格式错误：${clean}`);
    }
    const downstream = match[1].trim();
    const upstream = match[2].trim();
    if (downstream && upstream) {
      mappings[downstream] = upstream;
    }
  }
  return mappings;
}

function joinModelMappings(value) {
  return Object.entries(value || {})
    .map(([downstream, upstream]) => `${downstream} => ${upstream}`)
    .join("\n");
}

function uniqueList(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const clean = String(item).trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function modelMatchItems(upstream) {
  return [
    ...Object.entries(upstream.model_mappings || {}).map(([downstream, upstreamModel]) => ({
      label: `${downstream}=>${upstreamModel}`,
      type: "mapping",
    })),
    ...upstream.model_names.map((value) => ({ label: value, type: "name" })),
    ...upstream.model_prefixes.map((value) => ({ label: `${value}*`, type: "prefix" })),
  ];
}

function renderModelMatches(upstream) {
  const items = modelMatchItems(upstream);
  if (items.length === 0) {
    return '<span class="muted">默认候选</span>';
  }
  const visible = items.slice(0, MAX_MODEL_CHIPS);
  const hiddenCount = items.length - visible.length;
  const title = items.map((item) => item.label).join(", ");
  const chips = visible
    .map((item) => (
      `<span class="model-chip ${escapeHtml(item.type)}">${escapeHtml(item.label)}</span>`
    ))
    .join("");
  const more = hiddenCount > 0 ? `<span class="model-chip more">+${hiddenCount}</span>` : "";
  return `<div class="model-chip-list" title="${escapeHtml(title)}">${chips}${more}</div>`;
}

function renderUpstreamSummary() {
  if (!upstreamSummary) {
    return;
  }
  const total = upstreams.length;
  const enabled = upstreams.filter((upstream) => upstream.enabled).length;
  const disabled = total - enabled;
  const backedOff = upstreams.filter((upstream) => liveBackoffSeconds(upstream) > 0).length;
  upstreamSummary.innerHTML = `
    <span><strong>${total}</strong>渠道总数</span>
    <span><strong>${enabled}</strong>启用</span>
    <span><strong>${disabled}</strong>停用</span>
    <span class="${backedOff ? "summary-warn" : ""}"><strong>${backedOff}</strong>退避中</span>
  `;
}

function currentViewFromHash() {
  const name = location.hash.replace("#", "");
  return [...views].some((view) => view.dataset.view === name) ? name : DEFAULT_VIEW;
}

function switchView(name) {
  for (const view of views) {
    view.hidden = view.dataset.view !== name;
  }
  for (const link of navLinks) {
    link.classList.toggle("active", link.dataset.view === name);
  }
  if (location.hash !== `#${name}`) {
    location.hash = name;
  }
  if (name === "logs") {
    loadLogs();
    startLogRefresh();
  } else {
    stopLogRefresh();
  }
  if (name === "upstreams") {
    loadUpstreams();
    startUpstreamRefresh();
    startBackoffTick();
  } else {
    stopUpstreamRefresh();
    stopBackoffTick();
  }
  if (name === "tokens") {
    loadTokens();
    startTokenRefresh();
  } else {
    stopTokenRefresh();
  }
}

function startLogRefresh() {
  if (logRefreshTimer !== null) {
    return;
  }
  logRefreshTimer = window.setInterval(loadLogs, LOG_REFRESH_MS);
}

function startUpstreamRefresh() {
  if (upstreamRefreshTimer !== null) {
    return;
  }
  upstreamRefreshTimer = window.setInterval(loadUpstreams, UPSTREAM_REFRESH_MS);
}

function stopUpstreamRefresh() {
  if (upstreamRefreshTimer === null) {
    return;
  }
  window.clearInterval(upstreamRefreshTimer);
  upstreamRefreshTimer = null;
}

function startBackoffTick() {
  if (backoffTickTimer !== null) {
    return;
  }
  backoffTickTimer = window.setInterval(updateBackoffNotes, BACKOFF_TICK_MS);
}

function stopBackoffTick() {
  if (backoffTickTimer === null) {
    return;
  }
  window.clearInterval(backoffTickTimer);
  backoffTickTimer = null;
}

function stopLogRefresh() {
  if (logRefreshTimer === null) {
    return;
  }
  window.clearInterval(logRefreshTimer);
  logRefreshTimer = null;
}

function getAdminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function setAdminToken(token) {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

function clearAdminToken() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function showAdminTokenError(message) {
  adminTokenError.textContent = message;
}

function openAdminTokenDialog() {
  if (!adminTokenDialog.open) {
    if (typeof adminTokenDialog.showModal === "function") {
      adminTokenDialog.showModal();
    } else {
      adminTokenDialog.setAttribute("open", "");
    }
  }
  adminTokenInput.focus();
}

function closeAdminTokenDialog() {
  if (adminTokenDialog.open && typeof adminTokenDialog.close === "function") {
    adminTokenDialog.close();
  } else {
    adminTokenDialog.removeAttribute("open");
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = getAdminToken();
  if (token) {
    headers.set("x-admin-token", token);
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.detail || data.error?.message || message;
    } catch (_) {
      // Keep the HTTP status message.
    }
    if (response.status === 401) {
      clearAdminToken();
      showAdminTokenError(message);
      openAdminTokenDialog();
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function payloadFromForm() {
  let extraHeaders;
  try {
    extraHeaders = JSON.parse(fields.extraHeaders.value || "{}");
  } catch (error) {
    throw new Error(`额外请求头不是合法 JSON: ${error.message}`);
  }
  const modelMappings = parseModelMappings(fields.modelMappings.value);
  return {
    name: fields.name.value.trim(),
    base_url: fields.baseUrl.value.trim(),
    api_key: fields.apiKey.value.trim() || null,
    model_names: splitList(fields.modelNames.value),
    model_prefixes: splitList(fields.modelPrefixes.value),
    model_mappings: modelMappings,
    priority: Number(fields.priority.value || 100),
    timeout_seconds: Number(fields.timeoutSeconds.value || 300),
    enabled: fields.enabled.checked,
    extra_headers: extraHeaders,
    clear_api_key: fields.clearApiKey.checked,
  };
}

function hasExtraHeaders(headers) {
  return headers
    && typeof headers === "object"
    && !Array.isArray(headers)
    && Object.keys(headers).length > 0;
}

function setAdvancedSettingsOpen(open) {
  if (advancedSettings) {
    advancedSettings.open = open;
  }
}

function openUpstreamDialog() {
  if (typeof upstreamDialog.showModal === "function") {
    upstreamDialog.showModal();
  } else {
    upstreamDialog.setAttribute("open", "");
  }
  fields.name.focus();
}

function closeUpstreamDialog() {
  if (upstreamDialog.open && typeof upstreamDialog.close === "function") {
    upstreamDialog.close();
  } else {
    upstreamDialog.removeAttribute("open");
  }
}

function cancelUpstreamDialog() {
  closeUpstreamDialog();
  resetForm();
}

function parseQuickImport(text) {
  const apiKeyMatches = text.match(/sk-[a-zA-Z0-9_-]{16,}/g) || [];
  const apiKey = [...apiKeyMatches].sort((a, b) => b.length - a.length)[0] || null;

  const urlMatches = text.match(/https?:\/\/[^\s"'<>()\[\]“”，、；]+/g) || [];
  const candidates = urlMatches
    .map((url) => url.replace(/[.,;:)\]}"'，。；、]+$/, ""))
    .filter(Boolean);

  const scoreUrl = (url) => {
    const lower = url.toLowerCase();
    let score = 0;
    if (lower.includes("/v1")) score += 2;
    if (lower.includes("api")) score += 1;
    return score;
  };

  let baseUrl = null;
  if (candidates.length > 0) {
    const ranked = [...candidates].sort((a, b) => scoreUrl(b) - scoreUrl(a));
    try {
      baseUrl = new URL(ranked[0]).origin;
    } catch (_) {
      baseUrl = null;
    }
  }

  return { baseUrl, apiKey };
}

function suggestNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^api\./, "");
  } catch (_) {
    return "";
  }
}

function updateQuickImportFillState() {
  quickImportFillButton.disabled =
    !quickImportBaseUrlInput.value.trim() && !quickImportApiKeyInput.value.trim();
}

function syncQuickImportFields() {
  const { baseUrl, apiKey } = parseQuickImport(quickImportText.value);
  if (baseUrl) {
    quickImportBaseUrlInput.value = baseUrl;
  }
  if (apiKey) {
    quickImportApiKeyInput.value = apiKey;
  }
  updateQuickImportFillState();
}

function openQuickImportDialog() {
  quickImportText.value = "";
  quickImportBaseUrlInput.value = "";
  quickImportApiKeyInput.value = "";
  updateQuickImportFillState();
  if (typeof quickImportDialog.showModal === "function") {
    quickImportDialog.showModal();
  } else {
    quickImportDialog.setAttribute("open", "");
  }
  quickImportText.focus();
}

function closeQuickImportDialog() {
  if (quickImportDialog.open && typeof quickImportDialog.close === "function") {
    quickImportDialog.close();
  } else {
    quickImportDialog.removeAttribute("open");
  }
}

async function editUpstream(upstream) {
  try {
    const detail = await api(`/api/admin/upstreams/${upstream.id}`);
    fields.id.value = detail.id;
    fields.name.value = detail.name;
    fields.baseUrl.value = detail.base_url;
    fields.apiKey.value = detail.api_key || "";
    fields.modelNames.value = joinList(detail.model_names);
    fields.modelPrefixes.value = joinList(detail.model_prefixes);
    fields.modelMappings.value = joinModelMappings(detail.model_mappings);
    fields.priority.value = detail.priority;
    fields.timeoutSeconds.value = detail.timeout_seconds;
    fields.extraHeaders.value = JSON.stringify(detail.extra_headers || {}, null, 2);
    fields.enabled.checked = detail.enabled;
    fields.clearApiKey.checked = false;
    setAdvancedSettingsOpen(hasExtraHeaders(detail.extra_headers));
    fetchModelsButton.disabled = false;
    formTitle.textContent = `编辑渠道：${detail.name}`;
    openUpstreamDialog();
  } catch (error) {
    setStatus(`加载渠道配置失败：${error.message}`, "error");
  }
}

function duplicateUpstream(upstream) {
  resetForm();
  fields.name.value = `${upstream.name} 副本`;
  fields.baseUrl.value = upstream.base_url;
  fields.modelNames.value = joinList(upstream.model_names);
  fields.modelPrefixes.value = joinList(upstream.model_prefixes);
  fields.modelMappings.value = joinModelMappings(upstream.model_mappings);
  fields.priority.value = upstream.priority;
  fields.timeoutSeconds.value = upstream.timeout_seconds;
  fields.extraHeaders.value = JSON.stringify(upstream.extra_headers || {}, null, 2);
  fields.enabled.checked = upstream.enabled;
  setAdvancedSettingsOpen(hasExtraHeaders(upstream.extra_headers));
  formTitle.textContent = `复制渠道：${upstream.name}`;
  openUpstreamDialog();
  setStatus("已复制渠道配置，API Key 需要重新填写后再保存。", "ok");
}

function openBalanceDialog() {
  if (typeof balanceDialog.showModal === "function") {
    balanceDialog.showModal();
  } else {
    balanceDialog.setAttribute("open", "");
  }
}

function closeBalanceDialog() {
  if (balanceDialog.open && typeof balanceDialog.close === "function") {
    balanceDialog.close();
  } else {
    balanceDialog.removeAttribute("open");
  }
}

function formatUsd(value) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "-";
}

async function showBalance(upstream) {
  balanceTitle.textContent = `余额查询：${upstream.name}`;
  balanceSummary.textContent = "正在查询...";
  balanceBody.innerHTML = "";
  openBalanceDialog();

  try {
    const result = await api(`/api/admin/upstreams/${upstream.id}/balance`, { method: "POST" });
    if (result.ok) {
      balanceSummary.textContent = "查询成功";
      balanceBody.innerHTML = `
        <div class="balance-row"><span class="label">总额</span><span class="value">${formatUsd(result.total_usd)}</span></div>
        <div class="balance-row"><span class="label">已用</span><span class="value">${formatUsd(result.used_usd)}</span></div>
        <div class="balance-row"><span class="label">剩余</span><span class="value">${formatUsd(result.remaining_usd)}</span></div>
      `;
    } else {
      balanceSummary.textContent = "查询失败";
      balanceBody.innerHTML = `<p class="muted">${escapeHtml(result.message || "未知错误")}</p>`;
    }
  } catch (error) {
    balanceSummary.textContent = "查询失败";
    balanceBody.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  fields.priority.value = 100;
  fields.timeoutSeconds.value = 300;
  fields.modelMappings.value = "";
  fields.extraHeaders.value = "{}";
  fields.enabled.checked = true;
  setAdvancedSettingsOpen(false);
  fetchModelsButton.disabled = false;
  formTitle.textContent = "新增渠道";
}

function renderRows() {
  const openMenuId = activeActionMenuButton && !upstreamActionMenu.hidden
    ? Number(activeActionMenuButton.dataset.menuId)
    : null;
  if (activeActionMenuButton) {
    activeActionMenuButton.setAttribute("aria-expanded", "false");
    activeActionMenuButton = null;
  }

  rows.innerHTML = "";
  renderUpstreamSummary();
  if (upstreams.length === 0) {
    closeUpstreamActionMenu();
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="6" class="empty">暂无渠道。点击「新增渠道」开始配置。</td>`;
    rows.append(row);
    return;
  }

  for (const upstream of upstreams) {
    const row = document.createElement("tr");
    row.className = upstream.enabled ? "" : "row-disabled";
    const statusLabel = upstream.enabled ? "启用" : "停用";
    const statusAction = upstream.enabled ? "停用" : "启用";
    const remainingBackoff = liveBackoffSeconds(upstream);
    row.innerHTML = `
      <td class="name-cell">
        <div class="name-stack">
          <strong title="${escapeHtml(upstream.name)}">${escapeHtml(upstream.name)}</strong>
          <span class="muted">#${upstream.id} · ${upstream.api_key_set ? "API Key 已配置" : "使用下游 Authorization"}</span>
        </div>
      </td>
      <td class="url-cell">
        <code title="${escapeHtml(upstream.base_url)}">${escapeHtml(upstream.base_url)}</code>
      </td>
      <td class="match-cell">${renderModelMatches(upstream)}</td>
      <td class="col-priority">
        <button
          type="button"
          class="priority-value"
          data-priority-edit="${upstream.id}"
          aria-label="修改渠道 ${escapeHtml(upstream.name)} 的优先级"
          title="点击修改优先级"
        >${upstream.priority}</button>
        <input
          type="number"
          class="priority-input"
          data-priority-input="${upstream.id}"
          min="0"
          max="100000"
          step="1"
          value="${upstream.priority}"
          aria-label="渠道 ${escapeHtml(upstream.name)} 的优先级"
          hidden
        />
      </td>
      <td class="col-status">
        <div class="status-stack">
          <button
            type="button"
            class="status-toggle ${upstream.enabled ? "on" : "off"}"
            data-action="toggle-enabled"
            data-id="${upstream.id}"
            aria-pressed="${upstream.enabled}"
            aria-label="点击${statusAction}渠道 ${escapeHtml(upstream.name)}"
            title="点击${statusAction}"
          >
            <span class="status-dot" aria-hidden="true"></span>
            <span>${statusLabel}</span>
          </button>
        </div>
        <span
          class="backoff-note"
          data-backoff-id="${upstream.id}"
          ${remainingBackoff ? "" : "hidden"}
        >${remainingBackoff ? `退避中，剩 ${remainingBackoff}s` : ""}</span>
      </td>
      <td class="row-actions col-actions">
        <button
          type="button"
          class="secondary action-menu-trigger"
          data-menu-id="${upstream.id}"
          aria-haspopup="menu"
          aria-expanded="false"
          aria-label="打开 ${escapeHtml(upstream.name)} 的操作菜单"
          title="操作"
        ><span aria-hidden="true">⋮</span></button>
      </td>
    `;
    rows.append(row);
  }

  if (openMenuId !== null) {
    const replacement = rows.querySelector(`button[data-menu-id="${openMenuId}"]`);
    if (replacement) {
      activeActionMenuButton = replacement;
      replacement.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(positionUpstreamActionMenu);
    } else {
      closeUpstreamActionMenu();
    }
  }
}

function liveBackoffSeconds(upstream) {
  if (!upstream.backoffUntilMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((upstream.backoffUntilMs - Date.now()) / 1000));
}

function updateBackoffNotes() {
  for (const note of rows.querySelectorAll("[data-backoff-id]")) {
    const upstream = upstreams.find((item) => item.id === Number(note.dataset.backoffId));
    const remaining = upstream ? liveBackoffSeconds(upstream) : 0;
    note.textContent = remaining ? `退避中，剩 ${remaining}s` : "";
    note.hidden = remaining === 0;
  }
  renderUpstreamSummary();
}

function actionMenuMarkup(upstreamId) {
  return `
    <button type="button" role="menuitem" data-action="test" data-id="${upstreamId}">测试连接</button>
    <button type="button" role="menuitem" data-action="balance" data-id="${upstreamId}">查询余额</button>
    <button type="button" role="menuitem" data-action="models" data-id="${upstreamId}">拉取模型</button>
    <div class="action-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="edit" data-id="${upstreamId}">编辑</button>
    <button type="button" role="menuitem" data-action="duplicate" data-id="${upstreamId}">复制</button>
    <div class="action-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="delete" data-id="${upstreamId}" class="danger">删除</button>
  `;
}

function openUpstreamActionMenu(button) {
  if (activeActionMenuButton === button && !upstreamActionMenu.hidden) {
    closeUpstreamActionMenu(true);
    return;
  }

  closeUpstreamActionMenu();
  activeActionMenuButton = button;
  button.setAttribute("aria-expanded", "true");
  upstreamActionMenu.innerHTML = actionMenuMarkup(Number(button.dataset.menuId));
  upstreamActionMenu.style.visibility = "hidden";
  showPopoverLayer(upstreamActionMenu, true);
  window.requestAnimationFrame(() => {
    positionUpstreamActionMenu();
    upstreamActionMenu.style.visibility = "visible";
    upstreamActionMenu.querySelector("button[role='menuitem']")?.focus();
  });
}

function closeUpstreamActionMenu(restoreFocus = false) {
  const button = activeActionMenuButton;
  if (button) {
    button.setAttribute("aria-expanded", "false");
  }
  activeActionMenuButton = null;
  upstreamActionMenu.style.visibility = "";
  hidePopoverLayer(upstreamActionMenu);
  if (restoreFocus && button?.isConnected) {
    button.focus();
  }
}

function positionUpstreamActionMenu() {
  if (!activeActionMenuButton || upstreamActionMenu.hidden) {
    return;
  }
  const triggerRect = activeActionMenuButton.getBoundingClientRect();
  const menuRect = upstreamActionMenu.getBoundingClientRect();
  const viewportGap = 8;
  let left = triggerRect.right - menuRect.width;
  let top = triggerRect.bottom + 6;

  if (top + menuRect.height > window.innerHeight - viewportGap) {
    top = triggerRect.top - menuRect.height - 6;
  }
  left = Math.min(Math.max(viewportGap, left), window.innerWidth - menuRect.width - viewportGap);
  top = Math.min(Math.max(viewportGap, top), window.innerHeight - menuRect.height - viewportGap);
  upstreamActionMenu.style.left = `${Math.round(left)}px`;
  upstreamActionMenu.style.top = `${Math.round(top)}px`;
}

async function loadUpstreams() {
  try {
    upstreams = await api("/api/admin/upstreams");
    for (const upstream of upstreams) {
      upstream.backoffUntilMs = upstream.backoff_remaining_seconds
        ? Date.now() + upstream.backoff_remaining_seconds * 1000
        : null;
    }
    if (!priorityEditorIsOpen()) {
      renderRows();
    }
    renderLogFilterOptions();
    lastUpstreamLoadError = "";
  } catch (error) {
    const message = `加载失败：${error.message}`;
    if (message !== lastUpstreamLoadError) {
      setStatus(message, "error");
      lastUpstreamLoadError = message;
    }
  }
}

function priorityEditorIsOpen() {
  return Boolean(rows.querySelector("input[data-priority-input]:not([hidden])"));
}

function startPriorityEdit(button) {
  const activeInput = rows.querySelector("input[data-priority-input]:not([hidden])");
  if (activeInput) {
    activeInput.focus();
    return;
  }
  const cell = button.closest(".col-priority");
  const input = cell?.querySelector("input[data-priority-input]");
  if (!input) {
    return;
  }
  button.hidden = true;
  input.hidden = false;
  input.value = button.textContent.trim();
  input.focus();
  input.select();
}

function cancelPriorityEdit(input) {
  input.dataset.cancelled = "true";
  const button = input.closest(".col-priority")?.querySelector("button[data-priority-edit]");
  input.hidden = true;
  if (button) {
    button.hidden = false;
    button.focus();
  }
}

async function savePriorityEdit(input) {
  if (input.dataset.cancelled === "true") {
    delete input.dataset.cancelled;
    return;
  }
  if (input.dataset.saving === "true") {
    return;
  }

  const id = Number(input.dataset.priorityInput);
  const upstream = upstreams.find((item) => item.id === id);
  if (!upstream) {
    renderRows();
    setStatus("渠道已不存在，请刷新页面后重试。", "error");
    return;
  }

  const nextPriority = Number(input.value);
  if (!Number.isInteger(nextPriority) || nextPriority < 0 || nextPriority > 100000) {
    setStatus("优先级必须是 0 到 100000 之间的整数。", "error");
    input.focus();
    input.select();
    return;
  }
  if (nextPriority === upstream.priority) {
    renderRows();
    return;
  }

  input.dataset.saving = "true";
  input.disabled = true;
  try {
    const updated = await api(`/api/admin/upstreams/${id}/priority`, {
      method: "PATCH",
      body: JSON.stringify({ priority: nextPriority }),
    });
    Object.assign(upstream, updated);
    upstreams.sort((left, right) => right.priority - left.priority || left.id - right.id);
    renderRows();
    await loadUpstreams();
    setStatus(`渠道 ${updated.name} 的优先级已更新为 ${updated.priority}。`, "ok");
  } catch (error) {
    input.disabled = false;
    delete input.dataset.saving;
    setStatus(`修改优先级失败：${error.message}`, "error");
    input.focus();
    input.select();
  }
}

function renderLogFilterOptions() {
  const selected = logUpstreamFilter.value;
  logUpstreamFilter.innerHTML = '<option value="">全部渠道</option>';
  for (const upstream of upstreams) {
    const option = document.createElement("option");
    option.value = upstream.id;
    option.textContent = `#${upstream.id} ${upstream.name}`;
    logUpstreamFilter.append(option);
  }
  logUpstreamFilter.value = selected;
}

function formatTokens(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  return `
    <span class="token-triple" aria-label="输入 输出 总计 tokens">
      <span><b>${part(log.prompt_tokens)}</b><small>输入</small></span>
      <span><b>${part(log.completion_tokens)}</b><small>输出</small></span>
      <span><b>${part(log.total_tokens)}</b><small>总计</small></span>
    </span>
  `;
}

function formatSeconds(ms) {
  return ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

function firstTokenTone(ms) {
  if (ms === null || ms === undefined) {
    return "neutral";
  }
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return "neutral";
  }
  if (value < 5000) {
    return "ok";
  }
  if (value >= 10000) {
    return "danger";
  }
  return "warn";
}

function formatFirstTokenTime(ms) {
  const label = formatSeconds(ms);
  const tone = firstTokenTone(ms);
  return `<span class="first-token-time ${tone}" title="首字耗时 ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function totalDurationRating(log) {
  const statusCode = Number(log.status_code);
  if (!Number.isFinite(statusCode)) {
    return { tone: "danger", basis: "请求无响应或状态码缺失" };
  }
  if (statusCode < 200 || statusCode >= 300) {
    return { tone: "danger", basis: `HTTP ${statusCode} 错误，优先标红` };
  }

  const durationMs = Number(log.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { tone: "neutral", basis: "总耗时无数据" };
  }

  const completionTokens = Number(log.completion_tokens);
  const firstTokenMs = Number(log.first_token_ms);
  if (Number.isFinite(completionTokens) && completionTokens > 0) {
    let generationMs = durationMs;
    if (Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && firstTokenMs < durationMs) {
      generationMs = durationMs - firstTokenMs;
    }
    const generationSeconds = generationMs / 1000;
    if (generationSeconds > 0) {
      const outputRate = completionTokens / generationSeconds;
      const displayRate = outputRate.toFixed(1).replace(/\.0$/, "");
      const usedFirstToken = generationMs !== durationMs;
      return {
        tone: outputRate >= 20 ? "ok" : outputRate >= 8 ? "warn" : "danger",
        basis: usedFirstToken
          ? `按输出吞吐 ${displayRate} t/s 判定`
          : `按全程输出吞吐 ${displayRate} t/s 判定`,
      };
    }
  }

  const totalTokens = Number(log.total_tokens);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    const totalRate = totalTokens / (durationMs / 1000);
    const displayRate = totalRate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: totalRate >= 80 ? "ok" : totalRate >= 20 ? "warn" : "danger",
      basis: `按总吞吐 ${displayRate} t/s 判定`,
    };
  }

  return {
    tone: durationMs < 30000 ? "ok" : durationMs < 60000 ? "warn" : "danger",
    basis: "无 token 数据，按绝对耗时兜底判定",
  };
}

function formatTotalDurationTime(log) {
  const label = formatSeconds(log.duration_ms);
  const rating = totalDurationRating(log);
  return `<span class="duration-time ${rating.tone}" title="总耗时 ${escapeHtml(label)} · ${escapeHtml(rating.basis)}">${escapeHtml(label)}</span>`;
}

function formatThroughput(log) {
  if (!log.stream) {
    return "";
  }
  const completionTokens = Number(log.completion_tokens);
  const durationMs = Number(log.duration_ms);
  if (
    !Number.isFinite(completionTokens)
    || completionTokens <= 0
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return "流，-t/s";
  }

  // Prefer generation time after first token; if TTFT is missing/invalid, use full duration.
  const firstTokenMs = Number(log.first_token_ms);
  let generationMs = durationMs;
  if (Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && firstTokenMs < durationMs) {
    generationMs = durationMs - firstTokenMs;
  }
  if (generationMs <= 0) {
    return "流，-t/s";
  }
  const rate = completionTokens / (generationMs / 1000);
  const displayRate = rate.toFixed(1).replace(/\.0$/, "");
  return `流，${displayRate}t/s`;
}

function formatStatusBadge(statusCode) {
  if (statusCode === null || statusCode === undefined) {
    return '<span class="muted">无响应</span>';
  }
  if (statusCode >= 200 && statusCode < 300) {
    return `<span class="badge on">${statusCode}</span>`;
  }
  if (statusCode >= 400) {
    return `<span class="badge danger">${statusCode}</span>`;
  }
  return `<span class="badge neutral">${statusCode}</span>`;
}

function renderLogRows(items) {
  logRows.innerHTML = "";
  if (items.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" class="empty">暂无请求日志。</td>`;
    logRows.append(row);
    return;
  }

  for (const log of items) {
    const row = document.createElement("tr");
    row.className = "log-row";
    row.dataset.logId = log.id;
    row.tabIndex = 0;
    row.title = log.error || "点击查看请求详情";
    const time = new Date(log.created_at).toLocaleString();
    const channel = log.upstream_name
      ? `
        <div class="channel-stack">
          <strong title="${escapeHtml(log.upstream_name)}">${escapeHtml(log.upstream_name)}</strong>
          <span class="muted">#${log.upstream_id}</span>
        </div>
      `
      : "<span class=\"muted\">无（未匹配到渠道）</span>";
    const status = formatStatusBadge(log.status_code);
    const throughput = formatThroughput(log);
    row.innerHTML = `
      <td class="time-cell">
        <span>${escapeHtml(time)}</span>
        <span class="muted">#${log.id}</span>
      </td>
      <td class="channel-cell">${channel}</td>
      <td class="model-cell">${log.model ? `<code title="${escapeHtml(log.model)}">${escapeHtml(log.model)}</code>` : "<span class=\"muted\">-</span>"}</td>
      <td class="col-reasoning">
        ${log.reasoning_effort
          ? `<span class="badge neutral">${escapeHtml(log.reasoning_effort)}</span>`
          : "<span class=\"muted\">-</span>"}
      </td>
      <td>${status}</td>
      <td class="duration-cell">
        <span>${formatFirstTokenTime(log.first_token_ms)} / ${formatTotalDurationTime(log)}</span>
        ${throughput ? `<span class="muted">${throughput}</span>` : ""}
      </td>
      <td class="tokens-cell">${formatTokens(log)}</td>
    `;
    logRows.append(row);
  }
}

function formatByteCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "未知大小";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function prettyBodyText(text) {
  const clean = String(text || "");
  const trimmed = clean.trim();
  if (!trimmed) {
    return "<empty body>";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch (_) {
    return clean;
  }
}

function formatBodyHeading(body) {
  const parts = ["Body"];
  if (body.encoding) {
    parts.push(body.encoding);
  }
  if (typeof body.byte_length === "number") {
    parts.push(formatByteCount(body.byte_length));
  }
  if (body.truncated) {
    parts.push("已截断");
  }
  return parts.join(" · ");
}

function compactText(value, maxLength = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function firstErrorMessageFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return compactText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstErrorMessageFromValue(item);
      if (message) return message;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  if (value.error) {
    const nested = firstErrorMessageFromValue(value.error);
    if (nested) return nested;
  }

  for (const key of ["message", "detail", "error_message", "msg", "reason"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return compactText(value[key]);
    }
  }

  if (value.errors) {
    const nested = firstErrorMessageFromValue(value.errors);
    if (nested) return nested;
  }

  return "";
}

function errorMessageFromSnapshot(snapshot) {
  const body = snapshot?.body;
  if (!body || typeof body.text !== "string") return "";
  const text = body.text.trim();
  if (!text) return "";

  try {
    const message = firstErrorMessageFromValue(JSON.parse(text));
    if (message) return message;
  } catch (_) {
    // Non-JSON error bodies are handled below.
  }

  if (snapshot?.status_code >= 400 && !text.startsWith("<")) {
    return compactText(text);
  }
  return "";
}

function extractLogDetailError(detail) {
  return (
    errorMessageFromSnapshot(detail.downstream_response)
    || errorMessageFromSnapshot(detail.upstream_response)
    || compactText(detail.error)
  );
}

function formatLogDetailMeta(detail) {
  const time = new Date(detail.created_at).toLocaleString();
  const channel = detail.upstream_name || "未匹配到渠道";
  const statusText = detail.status_code === null || detail.status_code === undefined
    ? "无响应"
    : `HTTP ${detail.status_code}`;
  const statusTone = detail.status_code === null || detail.status_code === undefined
    ? "neutral"
    : detail.status_code >= 400
      ? "danger"
      : detail.status_code >= 200 && detail.status_code < 300
        ? "ok"
        : "neutral";
  const tokenParts = [detail.prompt_tokens, detail.completion_tokens, detail.total_tokens]
    .map((value) => (value === null || value === undefined ? "-" : value));
  const reasoning = detail.reasoning_effort || "-";
  const streamLabel = detail.stream ? "流式" : "非流式";
  const extractedError = extractLogDetailError(detail);
  const statusErrorLine = extractedError
    ? `<small class="log-detail-status-error" title="${escapeHtml(extractedError)}">错误：${escapeHtml(extractedError)}</small>`
    : "";
  const errorCard = extractedError
    ? `
      <div class="log-detail-meta-card log-detail-error-card">
        <span class="log-detail-meta-label">错误详情</span>
        <strong>${escapeHtml(extractedError)}</strong>
      </div>
    `
    : "";

  return `
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">时间</span>
      <strong>${escapeHtml(time)}</strong>
      <small>#${detail.id}</small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">路由</span>
      <strong title="${escapeHtml(channel)}">${escapeHtml(channel)}</strong>
      <small title="${escapeHtml(detail.model || "-")}">${escapeHtml(detail.model || "-")}</small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">请求</span>
      <strong>${escapeHtml(detail.method)} /${escapeHtml(detail.path)}</strong>
      <small>${escapeHtml(streamLabel)} · 思考强度 ${escapeHtml(reasoning)}</small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">状态与耗时</span>
      <strong><span class="log-detail-status ${statusTone}">${escapeHtml(statusText)}</span></strong>
      <small>首字 ${formatFirstTokenTime(detail.first_token_ms)} · 总耗时 ${formatTotalDurationTime(detail)}</small>
      ${statusErrorLine}
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">Tokens</span>
      <strong>${tokenParts.join(" / ")}</strong>
      <small>输入 / 输出 / 总计</small>
    </div>
    ${errorCard}
  `;
}

function formatHttpSnapshot(snapshot) {
  if (!snapshot) {
    return "未记录\n\n这条历史日志没有保存这一项请求或响应详情。";
  }

  const firstLine = snapshot.method
    ? `${snapshot.method || "-"} ${snapshot.url || "-"}`
    : `HTTP ${snapshot.status_code ?? "-"}`;
  const lines = [firstLine, ""];
  const headers = snapshot.headers || {};
  lines.push("Headers");
  lines.push(Object.keys(headers).length ? JSON.stringify(headers, null, 2) : "(none)");
  lines.push("");

  const body = snapshot.body || {};
  lines.push(formatBodyHeading(body));
  if (body.cleared) {
    lines.push("日志正文已按保留策略清理，仅保留方法、URL 和 Headers。请查看较新的日志以获得完整正文。");
  } else if (!body.byte_length) {
    lines.push("<empty body>");
  } else if (body.encoding === "base64") {
    lines.push(body.base64 || "");
  } else {
    lines.push(prettyBodyText(body.text || ""));
  }
  return lines.join("\n");
}

function closeLogDetailDialog() {
  if (logDetailDialog.open && typeof logDetailDialog.close === "function") {
    logDetailDialog.close();
  } else {
    logDetailDialog.removeAttribute("open");
  }
}

function openLogDetailDialog() {
  if (typeof logDetailDialog.showModal === "function") {
    logDetailDialog.showModal();
  } else {
    logDetailDialog.setAttribute("open", "");
  }
}

function renderLogDetailSection(details) {
  const pre = details.querySelector("pre");
  pre.textContent = currentLogDetail ? formatHttpSnapshot(currentLogDetail[details.dataset.field]) : "";
}

async function showLogDetail(logId) {
  currentLogDetail = null;
  logDetailTitle.textContent = "请求详情";
  logDetailSummary.textContent = "正在加载...";
  if (logDetailMeta) {
    logDetailMeta.innerHTML = `
      <div class="log-detail-meta-card log-detail-loading-card">
        <span class="log-detail-meta-label">加载中</span>
        <strong>正在读取日志详情</strong>
        <small>请求 / 响应快照会在展开卡片时渲染。</small>
      </div>
    `;
  }
  for (const details of logDetailSections) {
    details.open = false;
    details.querySelector("pre").textContent = "";
  }
  openLogDetailDialog();

  try {
    const detail = await api(`/api/admin/logs/${logId}`);
    currentLogDetail = detail;
    const time = new Date(detail.created_at).toLocaleString();
    const channel = detail.upstream_name || "未匹配到渠道";
    const status = detail.status_code === null ? "无响应" : `HTTP ${detail.status_code}`;
    logDetailTitle.textContent = `请求详情 #${detail.id}`;
    logDetailSummary.textContent = `${time} · ${channel} · ${detail.model || "-"} · ${status}`;
    if (logDetailMeta) {
      logDetailMeta.innerHTML = formatLogDetailMeta(detail);
    }
    for (const details of logDetailSections) {
      if (details.open) {
        renderLogDetailSection(details);
      }
    }
  } catch (error) {
    logDetailSummary.textContent = `加载失败：${error.message}`;
    if (logDetailMeta) {
      logDetailMeta.innerHTML = `
        <div class="log-detail-meta-card log-detail-error-card">
          <span class="log-detail-meta-label">加载失败</span>
          <strong>${escapeHtml(error.message)}</strong>
          <small>请稍后重试或刷新日志列表。</small>
        </div>
      `;
    }
  }
}

async function loadLogs() {
  try {
    const params = new URLSearchParams({ limit: LOG_PAGE_SIZE, offset: logOffset });
    if (logUpstreamFilter.value) {
      params.set("upstream_id", logUpstreamFilter.value);
    }
    const page = await api(`/api/admin/logs?${params}`);
    logHasMore = page.has_more;
    renderLogRows(page.items);
    logStatusBox.textContent = `已加载 ${page.items.length} 条 · 自动刷新 10s`;
    logStatusBox.dataset.tone = "neutral";
  } catch (error) {
    logStatusBox.textContent = `加载失败：${error.message}`;
    logStatusBox.dataset.tone = "error";
  }
  logPrevButton.disabled = logOffset === 0;
  logNextButton.disabled = !logHasMore;
}

function getVisibleDialogModels() {
  const filter = modelFilter.value.trim().toLowerCase();
  if (!filter) {
    return modelDialogState.models;
  }
  return modelDialogState.models.filter((model) => model.toLowerCase().includes(filter));
}

function renderModelOptions() {
  const visibleModels = getVisibleDialogModels();
  modelOptions.innerHTML = "";
  modelDialogSummary.textContent = `已选择 ${modelDialogState.selected.size} / ${modelDialogState.models.length}`;

  if (visibleModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有匹配的模型。";
    modelOptions.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const model of visibleModels) {
    const label = document.createElement("label");
    label.className = "model-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.model = model;
    checkbox.checked = modelDialogState.selected.has(model);

    const text = document.createElement("span");
    text.textContent = model;

    label.append(checkbox, text);
    fragment.append(label);
  }
  modelOptions.append(fragment);
}

function openModelDialog(upstream, models, selectedNames, mode) {
  const currentSelection = uniqueList(selectedNames || upstream.model_names);
  modelDialogState.upstream = upstream;
  modelDialogState.mode = mode;
  modelDialogState.models = uniqueList([...models, ...currentSelection]);
  modelDialogState.selected = new Set(currentSelection);
  modelDialogTitle.textContent = `选择模型：${upstream.name}`;
  modelFilter.value = "";
  renderModelOptions();
  if (typeof modelDialog.showModal === "function") {
    modelDialog.showModal();
  } else {
    modelDialog.setAttribute("open", "");
  }
  modelFilter.focus();
}

function closeModelDialog() {
  if (modelDialog.open && typeof modelDialog.close === "function") {
    modelDialog.close();
  } else {
    modelDialog.removeAttribute("open");
  }
}

async function fetchModelsForUpstream(upstream, mode, button, selectedNames) {
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "拉取中";
  }
  setStatus(`正在拉取 ${upstream.name} 的模型...`);
  try {
    const result = await api(`/api/admin/upstreams/${upstream.id}/models`, { method: "POST" });
    openModelDialog(upstream, result.models, selectedNames, mode);
    setStatus(`已拉取 ${result.models.length} 个模型。`, "ok");
  } catch (error) {
    setStatus(`拉取模型失败：${error.message}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function fetchModelsFromForm() {
  const baseUrl = fields.baseUrl.value.trim();
  if (!baseUrl) {
    setStatus("请先填写 Base URL 再拉取模型。", "error");
    return;
  }

  let extraHeaders;
  try {
    extraHeaders = JSON.parse(fields.extraHeaders.value || "{}");
  } catch (error) {
    setStatus(`额外请求头不是合法 JSON: ${error.message}`, "error");
    return;
  }

  const draftUpstream = { name: fields.name.value.trim() || baseUrl, model_names: [] };
  const selectedNames = splitList(fields.modelNames.value);
  const originalText = fetchModelsButton.textContent;
  fetchModelsButton.disabled = true;
  fetchModelsButton.textContent = "拉取中";
  setStatus(`正在拉取 ${draftUpstream.name} 的模型...`);
  try {
    const result = await api("/api/admin/upstreams/fetch-models", {
      method: "POST",
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: fields.apiKey.value.trim() || null,
        extra_headers: extraHeaders,
        timeout_seconds: Number(fields.timeoutSeconds.value || 300),
      }),
    });
    openModelDialog(draftUpstream, result.models, selectedNames, "form");
    setStatus(`已拉取 ${result.models.length} 个模型。`, "ok");
  } catch (error) {
    setStatus(`拉取模型失败：${error.message}`, "error");
  } finally {
    fetchModelsButton.disabled = false;
    fetchModelsButton.textContent = originalText;
  }
}

async function saveModelSelection() {
  const upstream = modelDialogState.upstream;
  if (!upstream) {
    closeModelDialog();
    return;
  }

  const selectedModels = modelDialogState.models.filter((model) => modelDialogState.selected.has(model));
  if (modelDialogState.mode === "form") {
    fields.modelNames.value = joinList(selectedModels);
    closeModelDialog();
    setStatus(`已选择 ${selectedModels.length} 个模型，保存渠道后生效。`, "ok");
    return;
  }

  const originalText = modelSaveSelectionButton.textContent;
  modelSaveSelectionButton.disabled = true;
  modelSaveSelectionButton.textContent = "保存中";
  try {
    await api(`/api/admin/upstreams/${upstream.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: upstream.name,
        base_url: upstream.base_url,
        api_key: null,
        model_names: selectedModels,
        model_prefixes: upstream.model_prefixes,
        model_mappings: upstream.model_mappings || {},
        priority: upstream.priority,
        timeout_seconds: upstream.timeout_seconds,
        enabled: upstream.enabled,
        extra_headers: upstream.extra_headers || {},
        clear_api_key: false,
      }),
    });
    if (fields.id.value === String(upstream.id)) {
      fields.modelNames.value = joinList(selectedModels);
    }
    closeModelDialog();
    await loadUpstreams();
    setStatus(`已保存 ${selectedModels.length} 个模型到 ${upstream.name}。`, "ok");
  } catch (error) {
    setStatus(`保存模型失败：${error.message}`, "error");
  } finally {
    modelSaveSelectionButton.disabled = false;
    modelSaveSelectionButton.textContent = originalText;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = payloadFromForm();
    const id = fields.id.value;
    const path = id ? `/api/admin/upstreams/${id}` : "/api/admin/upstreams";
    await api(path, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeUpstreamDialog();
    resetForm();
    await loadUpstreams();
    setStatus("渠道已保存。", "ok");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "error");
  }
});

async function handleUpstreamAction(button) {
  const id = Number(button.dataset.id);
  const upstream = upstreams.find((item) => item.id === id);
  if (!upstream) {
    setStatus("渠道已不存在，请刷新页面后重试。", "error");
    return;
  }

  if (button.dataset.action === "edit") {
    await editUpstream(upstream);
    return;
  }

  if (button.dataset.action === "duplicate") {
    duplicateUpstream(upstream);
    return;
  }

  if (button.dataset.action === "delete") {
    if (!confirm(`删除渠道 ${upstream.name}？`)) return;
    try {
      await api(`/api/admin/upstreams/${id}`, { method: "DELETE" });
      await loadUpstreams();
      setStatus("渠道已删除。", "ok");
    } catch (error) {
      setStatus(`删除失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.action === "models") {
    await fetchModelsForUpstream(upstream, "upstream", button, upstream.model_names);
    return;
  }

  if (button.dataset.action === "toggle-enabled") {
    const nextEnabled = !upstream.enabled;
    const originalMarkup = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "切换中";
    try {
      const updated = await api(`/api/admin/upstreams/${id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (fields.id.value === String(id)) {
        fields.enabled.checked = updated.enabled;
      }
      Object.assign(upstream, updated);
      renderRows();
      await loadUpstreams();
      setStatus(`渠道 ${updated.name} 已${updated.enabled ? "启用" : "停用"}。`, "ok");
    } catch (error) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = originalMarkup;
      setStatus(`切换渠道状态失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.action === "test") {
    try {
      const result = await api(`/api/admin/upstreams/${id}/test`, {
        method: "POST",
        body: JSON.stringify({ path: "/v1/models" }),
      });
      setStatus(
        result.ok
          ? `测试完成：HTTP ${result.status_code}`
          : `测试失败：${result.message || "无响应"}`,
        result.ok ? "ok" : "error",
      );
    } catch (error) {
      setStatus(`测试失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.action === "balance") {
    await showBalance(upstream);
  }
}

rows.addEventListener("click", async (event) => {
  const priorityButton = event.target.closest("button[data-priority-edit]");
  if (priorityButton) {
    startPriorityEdit(priorityButton);
    return;
  }

  const menuButton = event.target.closest("button[data-menu-id]");
  if (menuButton) {
    openUpstreamActionMenu(menuButton);
    return;
  }

  const actionButton = event.target.closest("button[data-action]");
  if (actionButton) {
    await handleUpstreamAction(actionButton);
  }
});

rows.addEventListener("keydown", (event) => {
  const input = event.target.closest("input[data-priority-input]");
  if (!input) {
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    input.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelPriorityEdit(input);
  }
});

rows.addEventListener("focusout", (event) => {
  const input = event.target.closest("input[data-priority-input]");
  if (input) {
    savePriorityEdit(input);
  }
});

upstreamActionMenu.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) {
    return;
  }
  closeUpstreamActionMenu();
  await handleUpstreamAction(actionButton);
});

upstreamActionMenu.addEventListener("keydown", (event) => {
  const items = [...upstreamActionMenu.querySelectorAll("button[role='menuitem']")];
  const currentIndex = items.indexOf(document.activeElement);
  let nextIndex = null;

  if (event.key === "ArrowDown") {
    nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
  } else if (event.key === "ArrowUp") {
    nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeUpstreamActionMenu(true);
    return;
  }

  if (nextIndex !== null) {
    event.preventDefault();
    items[nextIndex]?.focus();
  }
});

upstreamActionMenu.addEventListener("focusout", () => {
  window.requestAnimationFrame(() => {
    if (
      activeActionMenuButton
      && !upstreamActionMenu.contains(document.activeElement)
      && document.activeElement !== activeActionMenuButton
    ) {
      closeUpstreamActionMenu();
    }
  });
});

document.addEventListener("click", (event) => {
  if (
    activeActionMenuButton
    && !upstreamActionMenu.contains(event.target)
    && !activeActionMenuButton.contains(event.target)
  ) {
    closeUpstreamActionMenu();
  }
});

window.addEventListener("resize", () => closeUpstreamActionMenu());
window.addEventListener("scroll", () => closeUpstreamActionMenu(), true);

newButton.addEventListener("click", () => {
  resetForm();
  openUpstreamDialog();
});
resetButton.addEventListener("click", cancelUpstreamDialog);
upstreamDialogClose.addEventListener("click", cancelUpstreamDialog);
upstreamDialog.addEventListener("click", (event) => {
  if (event.target === upstreamDialog) {
    cancelUpstreamDialog();
  }
});
quickImportButton.addEventListener("click", openQuickImportDialog);
quickImportClose.addEventListener("click", closeQuickImportDialog);
quickImportCancel.addEventListener("click", closeQuickImportDialog);
quickImportDialog.addEventListener("click", (event) => {
  if (event.target === quickImportDialog) {
    closeQuickImportDialog();
  }
});
quickImportText.addEventListener("input", syncQuickImportFields);
quickImportBaseUrlInput.addEventListener("input", updateQuickImportFillState);
quickImportApiKeyInput.addEventListener("input", updateQuickImportFillState);
quickImportFillButton.addEventListener("click", () => {
  const baseUrl = quickImportBaseUrlInput.value.trim();
  const apiKey = quickImportApiKeyInput.value.trim();
  resetForm();
  if (baseUrl) {
    fields.baseUrl.value = baseUrl;
    const suggestedName = suggestNameFromUrl(baseUrl);
    if (suggestedName) {
      fields.name.value = suggestedName;
    }
  }
  if (apiKey) {
    fields.apiKey.value = apiKey;
  }
  closeQuickImportDialog();
  openUpstreamDialog();
  setStatus("已从快速导入填入 Base URL / API Key，请检查并补充名称等信息后保存。", "ok");
});

fetchModelsButton.addEventListener("click", async () => {
  const id = Number(fields.id.value);
  const upstream = upstreams.find((item) => item.id === id);
  if (upstream) {
    await fetchModelsForUpstream(upstream, "form", fetchModelsButton, splitList(fields.modelNames.value));
    return;
  }
  await fetchModelsFromForm();
});

modelFilter.addEventListener("input", renderModelOptions);
modelOptions.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type='checkbox'][data-model]");
  if (!checkbox) return;
  if (checkbox.checked) {
    modelDialogState.selected.add(checkbox.dataset.model);
  } else {
    modelDialogState.selected.delete(checkbox.dataset.model);
  }
  renderModelOptions();
});
modelSelectAllButton.addEventListener("click", () => {
  for (const model of getVisibleDialogModels()) {
    modelDialogState.selected.add(model);
  }
  renderModelOptions();
});
modelClearAllButton.addEventListener("click", () => {
  for (const model of getVisibleDialogModels()) {
    modelDialogState.selected.delete(model);
  }
  renderModelOptions();
});
modelSaveSelectionButton.addEventListener("click", saveModelSelection);
modelCancelSelectionButton.addEventListener("click", closeModelDialog);
modelDialogClose.addEventListener("click", closeModelDialog);
modelDialog.addEventListener("click", (event) => {
  if (event.target === modelDialog) {
    closeModelDialog();
  }
});

for (const link of navLinks) {
  link.addEventListener("click", () => switchView(link.dataset.view));
}
window.addEventListener("hashchange", () => switchView(currentViewFromHash()));

logUpstreamFilter.addEventListener("change", () => {
  logOffset = 0;
  loadLogs();
});
logRefreshButton.addEventListener("click", async () => {
  logRefreshButton.disabled = true;
  logRefreshButton.setAttribute("aria-busy", "true");
  logRefreshButton.textContent = "刷新中";
  try {
    await loadLogs();
  } finally {
    logRefreshButton.disabled = false;
    logRefreshButton.removeAttribute("aria-busy");
    logRefreshButton.textContent = "刷新";
  }
});
logPrevButton.addEventListener("click", () => {
  logOffset = Math.max(0, logOffset - LOG_PAGE_SIZE);
  loadLogs();
});
logNextButton.addEventListener("click", () => {
  logOffset += LOG_PAGE_SIZE;
  loadLogs();
});
logRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-log-id]");
  if (!row) return;
  showLogDetail(row.dataset.logId);
});
logRows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-log-id]");
  if (!row) return;
  event.preventDefault();
  showLogDetail(row.dataset.logId);
});
for (const details of logDetailSections) {
  details.addEventListener("toggle", () => {
    if (details.open) {
      renderLogDetailSection(details);
    }
  });
}
logDetailClose.addEventListener("click", closeLogDetailDialog);
logDetailDialog.addEventListener("click", (event) => {
  if (event.target === logDetailDialog) {
    closeLogDetailDialog();
  }
});

balanceClose.addEventListener("click", closeBalanceDialog);
balanceDialog.addEventListener("click", (event) => {
  if (event.target === balanceDialog) {
    closeBalanceDialog();
  }
});

adminTokenDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
});

adminTokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = adminTokenInput.value.trim();
  if (!token) {
    showAdminTokenError("请输入 Token。");
    return;
  }
  setAdminToken(token);
  const submitButton = adminTokenForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  showAdminTokenError("验证中...");
  try {
    await api("/api/admin/upstreams");
    closeAdminTokenDialog();
    initApp();
  } catch (error) {
    if (adminTokenDialog.open) {
      showAdminTokenError(error.message);
    }
  } finally {
    submitButton.disabled = false;
  }
});

adminLogoutButton.addEventListener("click", () => {
  clearAdminToken();
  location.reload();
});

function initApp() {
  resetForm();
  switchView(currentViewFromHash());
  if (currentViewFromHash() === "tokens") {
    loadTokens();
  }
  loadUpstreams();
}

// ── 令牌 CRUD ────────────────────────────────────────────────

function startTokenRefresh() {
  if (tokenRefreshTimer !== null) return;
  tokenRefreshTimer = window.setInterval(loadTokens, TOKEN_REFRESH_MS);
}

function stopTokenRefresh() {
  if (tokenRefreshTimer === null) return;
  window.clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = null;
}

function renderTokenRows() {
  if (tokens.length === 0) {
    tokenRows.innerHTML = '<tr><td colspan="5" class="empty">暂无令牌。点击「新增令牌」创建。</td></tr>';
    return;
  }
  tokenRows.innerHTML = tokens
    .map(
      (t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td class="muted">${escapeHtml(t.description || "—")}</td>
      <td>
        <button
          type="button"
          class="token-preview-button"
          data-token-action="copy"
          data-token-id="${t.id}"
          title="点击复制完整令牌"
          aria-label="复制 ${escapeHtml(t.name)} 的完整令牌"
        ><code class="token-preview-code">${escapeHtml(t.token_preview)}</code></button>
      </td>
      <td><span class="badge ${t.enabled ? "on" : "off"}">${t.enabled ? "启用" : "停用"}</span></td>
      <td class="action-cell">
        <button type="button" class="secondary small" data-token-action="edit" data-token-id="${t.id}">编辑</button>
        <button type="button" class="secondary small" data-token-action="${t.enabled ? "disable" : "enable"}" data-token-id="${t.id}">${t.enabled ? "停用" : "启用"}</button>
        <button type="button" class="secondary small danger" data-token-action="delete" data-token-id="${t.id}">删除</button>
      </td>
    </tr>`,
    )
    .join("");
}

async function loadTokens() {
  try {
    tokens = await api("/api/admin/tokens");
    renderTokenRows();
  } catch (error) {
    setStatus(`加载令牌失败：${error.message}`, "error");
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function resetTokenForm() {
  tokenIdInput.value = "";
  tokenNameInput.value = "";
  tokenDescriptionInput.value = "";
  tokenCustomInput.value = "";
  tokenCustomRow.hidden = false;
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
  tokenEnabledCheckbox.checked = token.enabled;
  tokenValueRow.hidden = true;
  tokenFormTitle.textContent = `编辑令牌：${token.name}`;
  openTokenDialog("edit");
}

async function handleTokenAction(button) {
  const id = Number(button.dataset.tokenId);
  const token = tokens.find((t) => t.id === id);
  if (!token && button.dataset.tokenAction !== "delete") {
    setStatus("令牌已不存在，请刷新页面后重试。", "error");
    return;
  }

  if (button.dataset.tokenAction === "edit") {
    await editToken(token);
    return;
  }

  if (button.dataset.tokenAction === "copy") {
    button.disabled = true;
    try {
      const detail = await api(`/api/admin/tokens/${id}`);
      const copied = await copyTextToClipboard(detail.token);
      if (!copied) {
        throw new Error("浏览器拒绝复制，请手动复制。");
      }
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
      setStatus(`令牌 ${detail.name} 已复制。`, "ok");
    } catch (error) {
      setStatus(`复制失败：${error.message}`, "error");
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (button.dataset.tokenAction === "enable" || button.dataset.tokenAction === "disable") {
    const nextEnabled = button.dataset.tokenAction === "enable";
    button.disabled = true;
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
      setStatus(`切换令牌状态失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.tokenAction === "delete") {
    if (!confirm(`删除令牌 ${token ? escapeHtml(token.name) : id}？`)) return;
    try {
      await api(`/api/admin/tokens/${id}`, { method: "DELETE" });
      await loadTokens();
      setStatus("令牌已删除。", "ok");
    } catch (error) {
      setStatus(`删除失败：${error.message}`, "error");
    }
    return;
  }
}

// ── Token events ──────────────────────────────────────────

tokenRows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-token-action]");
  if (!button) return;
  handleTokenAction(button);
});

tokenDialog.addEventListener("click", (event) => {
  if (event.target === tokenDialog) closeTokenDialog();
});

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

tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = tokenIdInput.value;
  const payload = {
    name: tokenNameInput.value.trim(),
    description: tokenDescriptionInput.value.trim(),
  };
  if (id) {
    // 编辑时不要 enabled（由单独的 enabled toggle 控制）
    payload.enabled = undefined;
  } else {
    payload.enabled = tokenEnabledCheckbox.checked;
    payload.token = tokenCustomInput.value.trim() || null;
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

if (getAdminToken()) {
  initApp();
} else {
  openAdminTokenDialog();
}
