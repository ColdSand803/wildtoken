// Navigation, dialogs, API access, settings, and model-test workflows.
function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) {
    return false;
  }
  if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
    return true;
  }
  return Boolean(target.isContentEditable);
}

function openDialogs() {
  return [...document.querySelectorAll("dialog[open]")];
}

function topOpenDialog() {
  const dialogs = openDialogs();
  return dialogs.length ? dialogs[dialogs.length - 1] : null;
}

function dialogMaximizeButton(dialog) {
  return dialog?.querySelector?.("[data-dialog-maximize]") || null;
}

function setDialogMaximized(dialog, maximized) {
  if (!dialog) return false;
  const next = Boolean(maximized);
  dialog.classList.toggle("is-maximized", next);
  const button = dialogMaximizeButton(dialog);
  if (button) {
    button.setAttribute("aria-pressed", String(next));
    button.setAttribute("aria-label", next ? "还原" : "最大化");
    button.title = next ? "还原" : "最大化";
  }
  return next;
}

function clearDialogMaximized(dialog) {
  return setDialogMaximized(dialog, false);
}

function toggleDialogMaximized(dialog) {
  if (!dialog) return false;
  return setDialogMaximized(dialog, !dialog.classList.contains("is-maximized"));
}

function closeDialogElement(dialog) {
  if (!dialog) return false;
  if (dialog === commandPalette) {
    closeCommandPalette();
    return true;
  }
  if (dialog === upstreamDialog) {
    cancelUpstreamDialog();
    return true;
  }
  if (dialog === tokenDialog) {
    closeTokenDialog();
    return true;
  }
  if (dialog === quickImportDialog) {
    closeQuickImportDialog();
    return true;
  }
  if (dialog === channelExportDialog) {
    closeChannelExportDialog();
    return true;
  }
  if (dialog === channelImportDialog) {
    closeChannelImportDialog();
    return true;
  }
  if (dialog === modelDialog) {
    closeModelDialog();
    return true;
  }
  if (dialog === logDetailDialog) {
    closeLogDetailDialog();
    return true;
  }
  if (dialog === balanceDialog) {
    closeBalanceDialog();
    return true;
  }
  if (dialog === confirmDialog) {
    clearDialogMaximized(confirmDialog);
    if (typeof confirmDialog.close === "function") {
      confirmDialog.close();
    } else {
      confirmDialog.removeAttribute("open");
    }
    return true;
  }
  if (dialog === adminTokenDialog) {
    return false;
  }
  clearDialogMaximized(dialog);
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
  return true;
}

function skeletonRowsMarkup(colspan, count = 5) {
  const widths = ["w-md", "w-lg", "w-sm", "w-xs", "w-md", "w-sm", "w-lg"];
  return Array.from({ length: count }, (_, rowIndex) => {
    const cells = Array.from({ length: colspan }, (__, colIndex) => {
      const width = widths[(rowIndex + colIndex) % widths.length];
      return `<td><span class="skeleton-block ${width}"></span></td>`;
    }).join("");
    return `<tr class="skeleton-row" aria-hidden="true">${cells}</tr>`;
  }).join("");
}

function emptyStateCell(colspan, { title, copy, actionLabel, actionId }) {
  return `
    <tr>
      <td colspan="${colspan}" class="empty empty-state">
        <div class="empty-state-inner">
          <p class="empty-state-title">${escapeHtml(title)}</p>
          <p class="empty-state-copy">${escapeHtml(copy)}</p>
          <div class="empty-state-actions">
            <button type="button" data-empty-action="${escapeHtml(actionId)}">${escapeHtml(actionLabel)}</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function noMatchStateCell(colspan, { title, copy, actionLabel, actionId }) {
  return `
    <tr>
      <td colspan="${colspan}" class="empty no-match-state">
        <div class="empty-state-inner">
          <p class="no-match-state-title">${escapeHtml(title)}</p>
          <p class="no-match-state-copy">${escapeHtml(copy)}</p>
          <div class="no-match-state-actions">
            <button type="button" class="secondary" data-empty-action="${escapeHtml(actionId)}">${escapeHtml(actionLabel)}</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function getFilteredUpstreams() {
  const query = upstreamSearchQuery.trim().toLowerCase();
  const status = upstreamStatusFilterValue;
  return upstreams.filter((upstream) => {
    if (status === "enabled" && !upstream.enabled) return false;
    if (status === "disabled" && upstream.enabled) return false;
    if (status === "effective-zero" && Number(upstream.effective_weight) > 0) return false;
    if (!query) return true;
    const haystack = [
      upstream.name,
      upstream.base_url,
      String(upstream.id),
      ...(upstream.model_names || []),
      ...(upstream.model_prefixes || []),
      ...Object.keys(upstream.model_mappings || {}),
      ...Object.values(upstream.model_mappings || {}),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }).sort(compareUpstreams);
}

function upstreamStatusRank(upstream) {
  if (!upstream.enabled) return 2;
  return Number(upstream.effective_weight) <= 0 ? 1 : 0;
}

function compareUpstreams(left, right) {
  let comparison;
  switch (upstreamSort.key) {
    case "id":
      comparison = left.id - right.id;
      break;
    case "name":
      comparison = String(left.name || "").localeCompare(String(right.name || ""), "zh-CN");
      break;
    case "status":
      comparison = upstreamStatusRank(left) - upstreamStatusRank(right);
      break;
    case "priority":
    default:
      comparison = left.priority - right.priority;
      break;
  }
  if (comparison !== 0) {
    return upstreamSort.direction === "asc" ? comparison : -comparison;
  }
  return left.id - right.id;
}

function updateUpstreamSortControls() {
  if (!upstreamTable) return;
  for (const button of upstreamTable.querySelectorAll("button[data-upstream-sort]")) {
    const key = button.dataset.upstreamSort;
    const direction = key === upstreamSort.key ? upstreamSort.direction : null;
    button.closest("th")?.setAttribute(
      "aria-sort",
      direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none",
    );
    const indicator = button.querySelector("span");
    if (indicator) indicator.textContent = direction === "asc" ? "↑" : direction === "desc" ? "↓" : "";
  }
}

function setUpstreamSort(key) {
  upstreamSort = {
    key,
    direction: upstreamSort.key === key && upstreamSort.direction === "asc" ? "desc" : "asc",
  };
  updateUpstreamSortControls();
  renderRows();
}

function upstreamFiltersActive() {
  return Boolean(upstreamSearchQuery.trim() || upstreamStatusFilterValue);
}

function getFilteredTokens() {
  const query = tokenSearchQuery.trim().toLowerCase();
  if (!query) return tokens;
  return tokens.filter((token) => {
    const haystack = [
      token.name,
      token.description || "",
      token.token_preview || "",
      String(token.id),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function tokenFiltersActive() {
  return Boolean(tokenSearchQuery.trim());
}

function clearUpstreamFilters() {
  if (upstreamSearchInput) upstreamSearchInput.value = "";
  if (upstreamStatusFilter) upstreamStatusFilter.value = "";
  upstreamSearchQuery = "";
  upstreamStatusFilterValue = "";
  renderRows();
}

function clearTokenFilters() {
  if (tokenSearchInput) tokenSearchInput.value = "";
  tokenSearchQuery = "";
  renderTokenRows();
}

function clearLogFilters() {
  if (typeof logSearchInput !== "undefined" && logSearchInput) logSearchInput.value = "";
  if (typeof logUpstreamFilter !== "undefined" && logUpstreamFilter) logUpstreamFilter.value = "";
  if (typeof logStatusFilter !== "undefined" && logStatusFilter) logStatusFilter.value = "";
  if (typeof logClientFilter !== "undefined" && logClientFilter) logClientFilter.value = "";
  if (typeof logStreamFilter !== "undefined" && logStreamFilter) logStreamFilter.value = "";
  if (typeof logMinDurationInput !== "undefined" && logMinDurationInput) logMinDurationInput.value = "";
  if (typeof clearLogTimeRange === "function") clearLogTimeRange();
  if (typeof setLogDownstreamTokenId === "function") setLogDownstreamTokenId(null);
  if (typeof resetLogPagination === "function") resetLogPagination();
  if (typeof loadLogs === "function") loadLogs();
  if (typeof restartLogStream === "function") restartLogStream();
}

function currentViewName() {
  return currentViewFromHash();
}

function focusCurrentSearch() {
  const view = currentViewName();
  if (view === "upstreams" && upstreamSearchInput) {
    upstreamSearchInput.focus();
    upstreamSearchInput.select?.();
    return;
  }
  if (view === "logs" && logSearchInput) {
    logSearchInput.focus();
    logSearchInput.select?.();
    return;
  }
  if (view === "tokens" && tokenSearchInput) {
    tokenSearchInput.focus();
    tokenSearchInput.select?.();
  }
}

function refreshCurrentView() {
  const view = currentViewName();
  if (view === "dashboard") {
    loadDashboardData();
  } else if (view === "logs") {
    loadLogs();
  } else if (view === "tokens") {
    loadTokens();
  } else if (view === "settings") {
    loadSettingsPage();
  } else {
    loadUpstreams();
  }
}


function validView(value) {
  return [...views].some((view) => view.dataset.view === value);
}

function getDefaultHome() {
  try {
    const value = localStorage.getItem(DEFAULT_HOME_KEY);
    return validView(value) ? value : FALLBACK_VIEW;
  } catch {
    return FALLBACK_VIEW;
  }
}

function getLogRefreshMs() {
  try {
    const seconds = Number(localStorage.getItem(LOG_REFRESH_KEY) || "5");
    return [0, 5, 10, 30].includes(seconds) ? seconds * 1000 : 5000;
  } catch {
    return 5000;
  }
}

function currentViewFromHash() {
  const name = location.hash.replace("#", "");
  return validView(name) ? name : getDefaultHome();
}

// 当前已切到的视图。switchView 自己会补写 location.hash，那次改写又会派发
// hashchange，处理器如果无条件再切一次，同一个视图就被加载两遍——后一次的
// loadDashboardData 会 abort 前一次，首次打开不带 hash 的地址必然撞上。
// hashchange 靠这个值区分"用户真的换页了"和"我们刚补的 hash"。
let activeViewName = null;

function switchView(name) {
  activeViewName = name;
  for (const view of views) {
    view.hidden = view.dataset.view !== name;
  }
  for (const link of navLinks) {
    link.classList.toggle("active", link.dataset.view === name);
  }
  if (document.documentElement.dataset.theme === "endfield" && window.matchMedia("(min-width: 761px)").matches) {
    document.querySelector(".content")?.scrollTo({ top: 0, behavior: "auto" });
  }
  if (location.hash !== `#${name}`) {
    location.hash = name;
  }
  if (name === "dashboard") {
    loadDashboardData();
    startDashboardRefresh();
  } else {
    stopDashboardRefresh();
  }
  if (name === "logs") {
    loadLogs();
    startLogRefresh();
    startLogStream();
  } else {
    stopLogRefresh();
    stopLogStream();
  }
  if (name === "upstreams") {
    loadUpstreams();
    startUpstreamRefresh();
    startEffectiveWeightTick();
  } else {
    stopUpstreamRefresh();
    stopEffectiveWeightTick();
  }
  if (name === "tokens") {
    loadTokens();
    startTokenRefresh();
  } else {
    stopTokenRefresh();
  }
  if (name === "groups") {
    loadGroups();
  }
  if (name === "settings") {
    loadSettingsPage();
    startSystemUptimeTicker();
  } else {
    stopSystemUptimeTicker();
  }
}

function updateLiveIndicator() {
  if (!liveIndicator) return;
  const active = Boolean(
    logRefreshTimer
      || logStreamController
      || logStreamReconnectTimer
      || upstreamRefreshTimer
      || tokenRefreshTimer
      || dashboardRefreshTimer,
  );
  liveIndicator.hidden = !active || !pageVisible;
}

function startLogRefresh() {
  const interval = getLogRefreshMs();
  if (
    logRefreshTimer !== null
    || !pageVisible
    || interval === 0
    || logStreamController !== null
  ) {
    updateLiveIndicator();
    return;
  }
  logRefreshTimer = window.setInterval(loadLogs, interval);
  updateLiveIndicator();
}

function startUpstreamRefresh() {
  if (upstreamRefreshTimer !== null || !pageVisible) {
    updateLiveIndicator();
    return;
  }
  upstreamRefreshTimer = window.setInterval(loadUpstreams, DEFAULT_REFRESH_MS);
  updateLiveIndicator();
}

function stopUpstreamRefresh() {
  if (upstreamRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(upstreamRefreshTimer);
  upstreamRefreshTimer = null;
  updateLiveIndicator();
}

function startEffectiveWeightTick() {
  if (effectiveWeightTickTimer !== null || !pageVisible) {
    return;
  }
  effectiveWeightTickTimer = window.setInterval(updateEffectiveWeightNotes, EFFECTIVE_WEIGHT_TICK_MS);
}

function stopEffectiveWeightTick() {
  if (effectiveWeightTickTimer === null) {
    return;
  }
  window.clearInterval(effectiveWeightTickTimer);
  effectiveWeightTickTimer = null;
}

function stopLogRefresh() {
  if (logRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(logRefreshTimer);
  logRefreshTimer = null;
  updateLiveIndicator();
}

function startDashboardRefresh() {
  if (dashboardRefreshTimer !== null || !pageVisible) {
    updateLiveIndicator();
    return;
  }
  const interval = Number(dashboardRefreshIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) {
    updateLiveIndicator();
    return;
  }
  dashboardRefreshTimer = window.setInterval(loadDashboardData, interval);
  updateLiveIndicator();
}

function updateDashboardRefreshInterval(newInterval) {
  const val = Number(newInterval);
  dashboardRefreshIntervalMs = Number.isFinite(val) ? val : DASHBOARD_DEFAULT_REFRESH_MS;
  try {
    localStorage.setItem(DASHBOARD_REFRESH_KEY, String(dashboardRefreshIntervalMs));
  } catch {
    // storage fallback
  }
  stopDashboardRefresh();
  if (currentViewFromHash() === "dashboard") {
    startDashboardRefresh();
  }
}

function stopDashboardRefresh() {
  if (dashboardRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = null;
  updateLiveIndicator();
}

function pauseAllAutoRefresh() {
  stopLogRefresh();
  stopLogStream();
  stopUpstreamRefresh();
  stopTokenRefresh();
  stopEffectiveWeightTick();
  stopDashboardRefresh();
  stopSystemUptimeTicker();
  updateLiveIndicator();
}

function resumeAutoRefreshForCurrentView() {
  if (!pageVisible) {
    updateLiveIndicator();
    return;
  }
  const name = currentViewFromHash();
  if (name === "dashboard") {
    startDashboardRefresh();
  } else if (name === "logs") {
    startLogRefresh();
    startLogStream();
  } else if (name === "upstreams") {
    startUpstreamRefresh();
    startEffectiveWeightTick();
  } else if (name === "tokens") {
    startTokenRefresh();
  } else if (name === "settings") {
    startSystemUptimeTicker();
  }
  updateLiveIndicator();
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

// rawApi performs the request and hands back the response itself.
//
// Split out of api() because one endpoint's body is not JSON: the database backup
// answers with the snapshot as a byte stream, and reading it as JSON would turn a
// working backup into a parse error. Everything about the request — the admin
// credential, the 401 handling, the structured rejection body — is shared, so the
// two paths cannot drift apart on how a failure is reported.
async function rawApi(path, options = {}) {
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
    let payload = null;
    try {
      const data = await response.json();
      payload = data;
      message = data.detail || data.error?.message || data.error || message;
    } catch (_) {
      // Keep the HTTP status message.
    }
    if (response.status === 401) {
      clearAdminToken();
      showAdminTokenError(message);
      openAdminTokenDialog();
    }
    const error = new Error(message);
    error.status = response.status;
    // Kept because some endpoints answer a rejection with a structured report
    // rather than only a message: a refused configuration import returns 400 with
    // the item list naming which entry was at fault, which is the part an operator
    // acts on. Callers that only read .message are unaffected.
    error.payload = payload;
    if (payload && Array.isArray(payload.items)) {
      error.report = payload;
    }
    throw error;
  }
  return response;
}

async function api(path, options = {}) {
  const response = await rawApi(path, options);
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

let loadedServerSettings = null;
let systemUptimeBaseSeconds = null;
let systemUptimeSyncedAt = 0;
let systemUptimeTimer = null;
let systemServerTimeBaseMs = null;
let systemServerTimeOffsetMinutes = 0;

function setSettingsStatus(message = "", tone = "") {
  if (!serverSettingsStatus) return;
  serverSettingsStatus.textContent = message;
  serverSettingsStatus.dataset.tone = tone;
}

function setRoutingSettingsStatus(message = "", tone = "") {
  if (!routingSettingsStatus) return;
  routingSettingsStatus.textContent = message;
  routingSettingsStatus.dataset.tone = tone;
}

function setProxySettingsStatus(message = "", tone = "") {
  if (!proxySettingsStatus) return;
  proxySettingsStatus.textContent = message;
  proxySettingsStatus.dataset.tone = tone;
}

function updatePreferenceControls() {
  const theme = document.documentElement.getAttribute("data-theme") || getStoredTheme();
  const density = getDensity();
  if (settingsTheme) settingsTheme.value = theme;
  settingsDensity?.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.densityChoice === density);
    button.setAttribute("aria-pressed", String(button.dataset.densityChoice === density));
  });
  if (settingsLogRefresh) settingsLogRefresh.value = String(getLogRefreshMs() / 1000);
  if (settingsDefaultHome) settingsDefaultHome.value = getDefaultHome();
}

function fillServerSettings(settings) {
  loadedServerSettings = settings;
  settingsBodyKeepCount.value = settings.log_body_keep_count;
  settingsRetentionDays.value = settings.log_retention_days;
  settingsBodyMaxBytes.value = settings.log_body_max_bytes;
  if (settingsLoadBalanceStrategy) settingsLoadBalanceStrategy.value = settings.load_balance_strategy || "weighted";
  settingsMaxRetries.value = settings.max_retries;
  settingsSameUpstreamRetryMs.value = settings.same_upstream_retry_interval_ms;
  settingsFailurePenalty.value = settings.auto_weight_failure_penalty;
  settingsSuccessIncrement.value = settings.auto_weight_success_increment;
  settingsRecoveryIncrement.value = settings.auto_weight_recovery_increment;
  settingsRecoveryInterval.value = settings.auto_weight_recovery_interval_seconds;
  if (settingsProxyEnabled) settingsProxyEnabled.checked = Boolean(settings.proxy_enabled);
  if (settingsProxyUrl) settingsProxyUrl.value = settings.proxy_url || "";
  settingsRevision.textContent = `修订 ${settings.revision} · ${settings.updated_at || "刚刚更新"}`;
  setSettingsStatus("");
  setRoutingSettingsStatus("");
  setProxySettingsStatus("");
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  // GB is reached here, unlike where this started: a database backup is measured
  // against the disk an operator has to fit it on, and "4096.0 MB" is a size they
  // have to convert by hand before it means anything.
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatUptime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainderSeconds = Math.floor(seconds % 60);
  return `${days ? `${days} 天 ` : ""}${hours} 小时 ${minutes} 分钟 ${remainderSeconds} 秒`;
}

function currentSystemUptimeSeconds() {
  if (!Number.isFinite(systemUptimeBaseSeconds)) return null;
  return systemUptimeBaseSeconds + Math.max(0, Math.floor((Date.now() - systemUptimeSyncedAt) / 1000));
}

function parseRfc3339OffsetMinutes(value) {
  const match = String(value || "").match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = (Number(match[2]) * 60) + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

function formatServerRfc3339(timestampMs, offsetMinutes) {
  const date = new Date(timestampMs + (offsetMinutes * 60_000));
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = Math.abs(offsetMinutes);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

function refreshSystemUptime() {
  const value = currentSystemUptimeSeconds();
  const uptimeValue = systemInfoGrid?.querySelector("[data-system-uptime]");
  if (uptimeValue && value !== null) {
    uptimeValue.textContent = formatUptime(value);
  }
  const serverTimeValue = systemInfoGrid?.querySelector("[data-system-server-time]");
  if (serverTimeValue && Number.isFinite(systemServerTimeBaseMs)) {
    const elapsedMs = Math.max(0, Date.now() - systemUptimeSyncedAt);
    serverTimeValue.textContent = formatServerRfc3339(
      systemServerTimeBaseMs + elapsedMs,
      systemServerTimeOffsetMinutes,
    );
  }
}

function formatMetricDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
}

function startSystemUptimeTicker() {
  if (systemUptimeTimer !== null || currentViewFromHash() !== "settings" || !pageVisible) return;
  systemUptimeTimer = window.setInterval(refreshSystemUptime, 1000);
}

function stopSystemUptimeTicker() {
  if (systemUptimeTimer === null) return;
  window.clearInterval(systemUptimeTimer);
  systemUptimeTimer = null;
}

// renderMetricsEndpointStatus shows whether /metrics is exposed and how it is
// guarded.
//
// Only the access policy is rendered. The Prometheus series themselves are not
// mirrored here: the console already has its own JSON metrics endpoint, and two
// panels sourced from different contracts would disagree the moment either
// changed.
function renderMetricsEndpointStatus(status) {
  if (!metricsEndpointStatusEl) return;

  // An absent field means a gateway older than this panel. Saying so beats
  // rendering the default-false as a deliberate "disabled".
  if (!status || typeof status !== "object") {
    metricsEndpointStatusEl.innerHTML = `<strong>端点状态不可用</strong><p>当前服务端未提供监控端点状态字段，请升级网关后再查看。</p>`;
    return;
  }

  const path = typeof status.path === "string" && status.path ? status.path : "/metrics";
  if (!status.enabled) {
    metricsEndpointStatusEl.innerHTML = `<strong>状态：已关闭（默认）</strong><p><code>${escapeHtml(path)}</code> 当前返回 404，与未编译该功能无法区分。需在启动配置 <code>[metrics]</code> 段设置 <code>enabled = true</code>（或环境变量 <code>APP__METRICS__ENABLED=true</code>）后重启生效。</p>`;
    return;
  }

  // The open configuration is called out rather than merely described: the
  // endpoint reports traffic volumes and channel health, so an unguarded one is
  // the case an operator most needs to notice.
  const guard = status.token_required
    ? `<p>访问策略：需携带独立的 <code>Authorization: Bearer &lt;token&gt;</code>。该令牌与管理员令牌相互独立，控制台不显示其内容。</p>`
    : `<p class="metrics-endpoint-warn">访问策略：<strong>未设置令牌</strong>，任何能访问该端口的调用方都可读取流量规模与渠道健康。仅在监听地址本身不可从外部访问时才适用；否则请配置 <code>[metrics] token</code>。</p>`;
  metricsEndpointStatusEl.innerHTML = `<strong>状态：已启用</strong><p>抓取路径：<code>${escapeHtml(path)}</code>（Prometheus 文本格式）。</p>${guard}<p>指标标签仅含渠道 ID、状态类别与协议；不含令牌 ID、令牌名称或模型名称，因此标签基数不随模型与令牌数量增长。</p>`;
}

// ── Configuration migration ──────────────────────────────
//
// The uploaded archive is held here rather than re-read from the file input on
// apply: the preview and the apply must be the same bytes, and a file the operator
// swapped between the two clicks would otherwise be applied against a plan they
// never saw.
let stagedConfigArchive = null;

const CONFIG_SCOPE_LABELS = {
  groups: "分组",
  channels: "渠道",
  tokens: "令牌策略",
  settings: "系统设置",
};

const CONFIG_ACTION_LABELS = {
  create: "新建",
  update: "覆盖",
  skip: "跳过",
  fail: "拒绝",
};

function setConfigExportStatus(message = "", tone = "") {
  if (!configExportStatus) return;
  configExportStatus.textContent = message;
  configExportStatus.dataset.tone = tone;
}

function setConfigImportStatus(message = "", tone = "") {
  if (!configImportStatus) return;
  configImportStatus.textContent = message;
  configImportStatus.dataset.tone = tone;
}

function selectedExportScopes() {
  return Array.from(document.querySelectorAll("[data-export-scope]"))
    .filter((box) => box.checked)
    .map((box) => box.dataset.exportScope);
}

// downloadArchive hands the archive to the browser as a file.
//
// Written to a blob URL rather than a data: URL because an archive with many
// channels exceeds what some browsers accept in a URL, and the failure there is a
// silently truncated download.
function downloadArchive(archive) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = archive.encryption ? "encrypted" : "plain";
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `wildtoken-config-${stamp}-${suffix}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked so the archive is not reachable from the page for the rest of the
  // session; it may contain credentials.
  URL.revokeObjectURL(url);
}

async function runConfigExport() {
  if (!configExportRun) return;
  const scopes = selectedExportScopes();
  if (!scopes.length) {
    setConfigExportStatus("请至少选择一个导出范围。", "error");
    return;
  }
  const includeSecrets = Boolean(configExportSecrets?.checked);
  const password = configExportPassword?.value || "";
  if (includeSecrets && password.trim().length < 8) {
    setConfigExportStatus("包含密钥时必须设置至少 8 位的归档密码。", "error");
    return;
  }

  configExportRun.disabled = true;
  setConfigExportStatus("正在生成归档…", "");
  try {
    const archive = await api("/api/admin/config/export", {
      method: "POST",
      body: JSON.stringify({ scopes, include_secrets: includeSecrets, password }),
    });
    downloadArchive(archive);
    const labels = scopes.map((scope) => CONFIG_SCOPE_LABELS[scope] || scope).join("、");
    setConfigExportStatus(
      `已导出：${labels}${archive.encryption ? "（已加密）" : "（未加密，不含密钥）"}。`,
      "ok",
    );
    // Cleared on success so the password does not sit in the DOM for the rest of
    // the session, where it would be readable by anything that can read the page.
    if (configExportPassword) configExportPassword.value = "";
  } catch (error) {
    setConfigExportStatus(error.message || "导出失败。", "error");
  } finally {
    configExportRun.disabled = false;
  }
}

function renderConfigImportReport(report, { dryRun }) {
  if (!configImportReport) return;
  if (!report) {
    configImportReport.innerHTML = "";
    return;
  }

  const heading = dryRun ? "预览结果（未写入）" : "导入结果";
  const source = [];
  if (report.app_version) source.push(`来源版本 ${escapeHtml(report.app_version)}`);
  if (report.exported_at) source.push(`导出于 ${escapeHtml(report.exported_at)}`);
  if (report.schema_version) source.push(`格式 v${escapeHtml(String(report.schema_version))}`);
  if (report.includes_secrets) source.push("<strong>含密钥与令牌明文</strong>");

  const counts = `<span class="config-count">新建 ${Number(report.created || 0)}</span>`
    + `<span class="config-count">覆盖 ${Number(report.updated || 0)}</span>`
    + `<span class="config-count">跳过 ${Number(report.skipped || 0)}</span>`;

  const errors = Array.isArray(report.errors) ? report.errors : [];
  const errorBlock = errors.length
    ? `<div class="config-import-errors"><strong>未写入任何内容，以下条目被拒绝：</strong><ul>${
        errors.map((message) => `<li>${escapeHtml(message)}</li>`).join("")
      }</ul></div>`
    : "";

  const items = Array.isArray(report.items) ? report.items : [];
  const rows = items.map((item) => {
    const action = CONFIG_ACTION_LABELS[item.action] || item.action || "";
    const scope = CONFIG_SCOPE_LABELS[item.scope] || item.scope || "";
    return `<tr data-action="${escapeHtml(item.action || "")}"><td>${escapeHtml(scope)}</td>`
      + `<td>${escapeHtml(item.name || "")}</td><td>${escapeHtml(action)}</td>`
      + `<td>${escapeHtml(item.detail || "")}</td></tr>`;
  }).join("");
  const table = rows
    ? `<table class="config-import-table"><thead><tr><th>范围</th><th>名称</th><th>处理</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="settings-note">归档中没有需要处理的条目。</p>`;

  configImportReport.innerHTML = `<div class="config-import-head"><strong>${heading}</strong>`
    + `<div class="config-counts">${counts}</div></div>`
    + (source.length ? `<p class="settings-note">${source.join(" · ")}</p>` : "")
    + errorBlock + table;
}

// readArchiveFile parses the chosen file without sending it anywhere.
//
// A file that is not this format is refused here, so the operator hears about it
// before a password is typed.
async function readArchiveFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("该文件不是 JSON，请选择导出得到的归档文件。");
  }
  if (!parsed || typeof parsed !== "object" || parsed.kind !== "wildtoken.config") {
    throw new Error("该文件不是 WildToken 配置归档。");
  }
  return parsed;
}

async function submitConfigImport({ dryRun }) {
  const file = configImportFile?.files?.[0];
  if (!file && !stagedConfigArchive) {
    setConfigImportStatus("请先选择归档文件。", "error");
    return;
  }

  const button = dryRun ? configImportPreview : configImportApply;
  if (button) button.disabled = true;
  setConfigImportStatus(dryRun ? "正在校验归档…" : "正在导入…", "");
  try {
    if (file) stagedConfigArchive = await readArchiveFile(file);

    const body = {
      archive: stagedConfigArchive,
      password: configImportPassword?.value || "",
      on_conflict: configImportConflict?.value || "skip",
      dry_run: dryRun,
    };
    const report = await api("/api/admin/config/import", {
      method: "POST",
      body: JSON.stringify(body),
    });

    renderConfigImportReport(report, { dryRun });
    if (dryRun) {
      setConfigImportStatus("校验通过，未写入任何内容。确认后再执行导入。", "ok");
      // Only a successful preview unlocks the apply: the operator has to have seen
      // what the import would do before they can commit it.
      if (configImportApply) configImportApply.disabled = false;
    } else {
      setConfigImportStatus("导入完成，配置已生效。", "ok");
      if (configImportApply) configImportApply.disabled = true;
      if (configImportPassword) configImportPassword.value = "";
      stagedConfigArchive = null;
      if (configImportFile) configImportFile.value = "";
      // Refreshed because an import can have replaced the settings this page shows.
      await loadSettingsPage();
    }
  } catch (error) {
    setConfigImportStatus(error.message || "导入失败。", "error");
    // A refused import is answered with the full report, which names the entry at
    // fault — the operator needs that far more than the message alone.
    renderConfigImportReport(error.report || null, { dryRun });
    if (configImportApply) configImportApply.disabled = true;
  } finally {
    if (button) button.disabled = false;
  }
}

function resetConfigImportState() {
  stagedConfigArchive = null;
  if (configImportApply) configImportApply.disabled = true;
  renderConfigImportReport(null, { dryRun: true });
  setConfigImportStatus("");
}

// ── Disaster recovery ────────────────────────────────────
//
// Deliberately a separate card from configuration migration above, for the same
// reason the endpoints are separate route groups: an import writes named settings
// into a running instance, a restore replaces every row it has — request logs,
// usage counters and the admin credential included. Presenting the two as
// variations of one operation would let approval of the smaller read as approval
// of the larger.

// The uploaded backup is held here so the bytes that were verified are the bytes
// that get staged, exactly as the configuration import does. It also avoids
// re-reading and re-encoding a database-sized file on the second click.
let stagedBackupFile = null;
// Set by a successful verification and cleared by anything that changes what would
// be restored. The apply is gated on it, so nothing is staged that the operator has
// not seen checked first.
let restoreVerified = false;
// True while a request is in flight, and true while a restore sits staged. Both
// lock the same controls, for different reasons: one because a second click would
// duplicate the work, the other because the database is already scheduled to be
// replaced.
let disasterRecoveryBusy = false;
let restoreStagedAndPending = false;

// The container's magic ends in two NUL bytes. Built rather than written as a
// literal: a source file carrying raw NULs reads as binary to half the tools that
// touch it, and an escape is easy to lose to a well-meaning reformat.
const BACKUP_MAGIC = `WTBAK1${String.fromCharCode(0, 0)}`;
const BACKUP_KIND = "wildtoken.backup";
// Mirrors MaxBackupHeaderBytes on the server, so a file that would be refused there
// is refused here before it is uploaded.
const MAX_BACKUP_HEADER_BYTES = 64 * 1024;

function setBackupStatus(message = "", tone = "") {
  if (!backupStatus) return;
  backupStatus.textContent = message;
  backupStatus.dataset.tone = tone;
}

function setRestoreStatus(message = "", tone = "") {
  if (!restoreStatus) return;
  restoreStatus.textContent = message;
  restoreStatus.dataset.tone = tone;
}

// shortFingerprint keeps a digest readable. The full value is of no use to a person
// comparing two instances by eye, and the leading bytes are enough to see that two
// differ.
function shortFingerprint(value) {
  const text = String(value || "");
  if (!text) return "—";
  return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

// applyDisasterRecoveryLocks is the one place that decides what is clickable.
//
// It also locks the configuration import, which is not this card's control: an
// import written now would land in a database that is about to be replaced by the
// staged restore, so it would be silently lost at the next start.
function applyDisasterRecoveryLocks() {
  const locked = disasterRecoveryBusy || restoreStagedAndPending;
  if (backupRun) backupRun.disabled = disasterRecoveryBusy;
  if (restoreVerify) restoreVerify.disabled = locked;
  if (restoreFile) restoreFile.disabled = locked;
  if (restorePassword) restorePassword.disabled = locked;
  if (restoreConfirm) restoreConfirm.disabled = locked;
  if (restoreAllowSchemaMismatch) restoreAllowSchemaMismatch.disabled = locked;
  if (restoreCancel) restoreCancel.disabled = disasterRecoveryBusy;
  if (restoreApply) {
    const confirmed = (restoreConfirm?.value || "").trim() === "restore";
    restoreApply.disabled = locked || !restoreVerified || !confirmed;
  }
  if (restoreStagedAndPending && configImportApply) {
    configImportApply.disabled = true;
  }
}

function setDisasterRecoveryBusy(busy) {
  disasterRecoveryBusy = Boolean(busy);
  applyDisasterRecoveryLocks();
}

// resetRestoreState is what any change to the input runs: a new file, a different
// password or a toggled schema override all describe a different restore than the
// one that was verified.
function resetRestoreState() {
  stagedBackupFile = null;
  restoreVerified = false;
  renderRestoreReport(null, { dryRun: true });
  setRestoreStatus("");
  applyDisasterRecoveryLocks();
}

function renderBackupInfo(info) {
  if (!backupCurrentInfo) return;
  if (!info) {
    backupCurrentInfo.innerHTML = `<p class="settings-note">数据库信息暂不可用。</p>`;
    return;
  }
  const pages = info.page_count
    ? `${Number(info.page_count).toLocaleString("zh-CN")} 页 × ${formatBytes(info.page_size)}`
    : "—";
  const entries = [
    ["当前版本", info.app_version || "—"],
    ["备份格式", `v${Number(info.schema_version || 1)}`],
    ["结构指纹", shortFingerprint(info.schema_fingerprint)],
    ["数据库大小", formatBytes(info.size_bytes)],
    ["页面", pages],
  ];
  backupCurrentInfo.innerHTML = `<dl class="backup-info-grid">${
    entries.map(([label, value]) =>
      `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")
  }</dl>`;
}

function renderPendingRestore(pending) {
  restoreStagedAndPending = Boolean(pending && pending.pending);
  if (restorePending) restorePending.hidden = !restoreStagedAndPending;
  if (restorePendingDetail) {
    restorePendingDetail.innerHTML = restoreStagedAndPending
      ? `<strong>已有一份恢复在等待重启生效</strong>`
        + `<p>暂存于 ${escapeHtml(pending.staged_at || "—")} · ${escapeHtml(formatBytes(pending.size_bytes))}`
        + ` · 校验和 ${escapeHtml(shortFingerprint(pending.checksum))}</p>`
        + `<p><strong>需要重启服务</strong>才会用该备份替换当前数据库。在此之前，恢复与配置导入已锁定；如果改了主意，可以取消暂存，当前数据库不受影响。</p>`
      : "";
  }
  applyDisasterRecoveryLocks();
}

// renderRestoreReport shows the uploaded file beside this instance, because "can I
// restore this here" is a comparison, not a property of the file alone.
function renderRestoreReport(result, { dryRun }) {
  if (!restoreReport) return;
  if (!result) {
    restoreReport.innerHTML = "";
    return;
  }

  const backup = result.backup || {};
  const current = result.current || {};
  const rows = [
    ["应用版本", backup.app_version || "—", current.app_version || "—"],
    ["创建时间", backup.created_at || "—", "—"],
    ["结构指纹", shortFingerprint(backup.schema_fingerprint), shortFingerprint(current.schema_fingerprint)],
    ["快照大小", formatBytes(backup.size_bytes), "—"],
    ["加密", backup.encrypted ? "是" : "否", "—"],
  ];
  const table = `<table class="restore-compare"><thead><tr><th>项目</th><th>备份文件</th><th>当前实例</th></tr></thead><tbody>${
    rows.map(([label, left, right]) =>
      `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(left))}</td><td>${escapeHtml(String(right))}</td></tr>`).join("")
  }</tbody></table>`;

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const warningBlock = warnings.length
    ? `<div class="restore-warnings"><ul>${
        warnings.map((message) => `<li>${escapeHtml(message)}</li>`).join("")
      }</ul></div>`
    : "";

  const heading = dryRun ? "校验结果（未写入）" : "恢复结果";
  const verdict = result.verified
    ? `<span class="restore-verdict" data-verified="true">校验通过</span>`
    : `<span class="restore-verdict" data-verified="false">未通过校验</span>`;
  // The restart requirement is stated in the report, not only in the status line:
  // the status line is one sentence that the next action overwrites, and "staged
  // but not applied" is the part an operator most needs to still be on screen.
  const staged = result.staged
    ? `<div class="restore-staged"><strong>已暂存，尚未生效。</strong>`
      + `<p>当前进程正持有数据库，替换会在<strong>下次启动</strong>时发生，请重启服务。</p>`
      + (result.rollback_path
        ? `<p>被替换的数据库已另存为 <code>${escapeHtml(result.rollback_path)}</code>，恢复错了可以用它回退。</p>`
        : "")
      + `</div>`
    : "";

  restoreReport.innerHTML = `<div class="config-import-head"><strong>${heading}</strong>${verdict}</div>`
    + warningBlock + staged + table;
}

// bytesToBase64 encodes in chunks.
//
// String.fromCharCode applied to a whole database at once exceeds the argument
// limit and throws, which would report a perfectly good backup as a broken one.
function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

// readBackupFile parses the container's header locally, without uploading anything.
//
// The header is plaintext by design, so the console can say what a file is — and
// refuse one that is not a backup at all — before the operator types a password or
// waits for a database-sized upload. Everything here is checked again on the server;
// nothing is trusted from this side.
async function readBackupFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < BACKUP_MAGIC.length + 4) {
    throw new Error("该文件不是 WildToken 数据库备份。");
  }
  const magic = String.fromCharCode(...bytes.subarray(0, BACKUP_MAGIC.length));
  if (magic !== BACKUP_MAGIC) {
    throw new Error("该文件不是 WildToken 数据库备份；如果这是配置归档，请用上方的“配置迁移”卡片导入。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(BACKUP_MAGIC.length, false);
  const bodyStart = BACKUP_MAGIC.length + 4 + headerLength;
  if (headerLength === 0 || headerLength > MAX_BACKUP_HEADER_BYTES || bodyStart > bytes.length) {
    throw new Error("备份文件已损坏：文件头长度不合法。");
  }
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(BACKUP_MAGIC.length + 4, bodyStart)));
  } catch (_) {
    throw new Error("备份文件已损坏：无法解析文件头。");
  }
  if (!header || typeof header !== "object" || header.kind !== BACKUP_KIND) {
    throw new Error("该文件不是 WildToken 数据库备份。");
  }
  return { header, archive: bytesToBase64(bytes) };
}

function backupFileName(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  return match ? match[1] : "wildtoken-backup.wtbak";
}

function downloadBackupBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked immediately: this blob is the whole database, credentials included, and
  // an object URL stays fetchable from the page until it is released.
  URL.revokeObjectURL(url);
}

async function runDatabaseBackup() {
  if (!backupRun) return;
  const password = backupPassword?.value || "";
  if (password && password.trim().length < 8) {
    setBackupStatus("备份密码至少 8 位；留空则生成不加密的备份。", "error");
    return;
  }

  setDisasterRecoveryBusy(true);
  setBackupStatus("正在生成一致性快照…", "");
  try {
    // rawApi rather than api: the response body is the database, not JSON.
    const response = await rawApi("/api/admin/disaster-recovery/backup", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    const blob = await response.blob();
    downloadBackupBlob(blob, backupFileName(response));
    setBackupStatus(
      `备份已生成并下载（${formatBytes(blob.size)}${password ? "，已加密" : "，未加密"}）。`,
      "ok",
    );
    // Cleared on success so the password does not sit in the DOM for the rest of
    // the session, where anything that can read the page can read it.
    if (backupPassword) backupPassword.value = "";
  } catch (error) {
    setBackupStatus(error.message || "备份失败。", "error");
  } finally {
    setDisasterRecoveryBusy(false);
  }
}

async function submitRestore({ dryRun }) {
  const file = restoreFile?.files?.[0];
  if (!file && !stagedBackupFile) {
    setRestoreStatus("请先选择备份文件。", "error");
    return;
  }
  if (!dryRun && (restoreConfirm?.value || "").trim() !== "restore") {
    // Also enforced by the server, which requires the same phrase. Checked here so
    // the operator is told what is missing rather than being handed a rejection.
    setRestoreStatus("请在覆盖确认中输入 restore，确认用备份覆盖当前数据库的全部数据。", "error");
    return;
  }

  setDisasterRecoveryBusy(true);
  setRestoreStatus(dryRun ? "正在校验备份…" : "正在暂存恢复…", "");
  try {
    if (file) stagedBackupFile = await readBackupFile(file);

    const body = {
      archive: stagedBackupFile.archive,
      password: restorePassword?.value || "",
      dry_run: dryRun,
      allow_schema_mismatch: Boolean(restoreAllowSchemaMismatch?.checked),
    };
    if (!dryRun) body.confirm = "restore";

    const result = await api("/api/admin/disaster-recovery/restore", {
      method: "POST",
      body: JSON.stringify(body),
    });
    renderRestoreReport(result, { dryRun });

    if (dryRun) {
      restoreVerified = true;
      setRestoreStatus("校验通过，未写入任何内容。填写覆盖确认后再执行恢复。", "ok");
    } else {
      restoreVerified = false;
      stagedBackupFile = null;
      if (restorePassword) restorePassword.value = "";
      if (restoreConfirm) restoreConfirm.value = "";
      if (restoreFile) restoreFile.value = "";
      setRestoreStatus("恢复已暂存，需要重启服务后才会生效。", "ok");
      await loadDisasterRecoveryInfo();
    }
  } catch (error) {
    // Nothing on this instance has been touched at this point: the server verifies
    // the whole file before it writes anything, so a wrong password or a damaged
    // file leaves the database exactly as it was.
    restoreVerified = false;
    renderRestoreReport(null, { dryRun });
    setRestoreStatus(`${error.message || "恢复失败。"}（当前数据库未被修改）`, "error");
  } finally {
    setDisasterRecoveryBusy(false);
  }
}

async function cancelStagedRestore() {
  setDisasterRecoveryBusy(true);
  setRestoreStatus("正在取消暂存的恢复…", "");
  try {
    const result = await api("/api/admin/disaster-recovery/restore", { method: "DELETE" });
    renderPendingRestore({ pending: false });
    renderRestoreReport(null, { dryRun: true });
    setRestoreStatus(
      result?.rollback_kept
        ? "已取消暂存的恢复，当前数据库不受影响；恢复前的副本已保留在服务器上。"
        : "已取消暂存的恢复，当前数据库不受影响。",
      "ok",
    );
    await loadDisasterRecoveryInfo();
  } catch (error) {
    setRestoreStatus(error.message || "取消失败。", "error");
  } finally {
    setDisasterRecoveryBusy(false);
  }
}

async function loadDisasterRecoveryInfo() {
  if (!backupCurrentInfo) return;
  try {
    const info = await api("/api/admin/disaster-recovery/info");
    renderBackupInfo(info?.current);
    renderPendingRestore(info?.pending_restore);
  } catch (error) {
    // Left as unavailable rather than as "no restore pending": a failed load says
    // nothing about whether one is staged, and reporting none would be a claim this
    // console cannot make.
    renderBackupInfo(null);
    setBackupStatus(error.message || "无法读取数据库信息。", "error");
  }
}

function renderSystemInfo(system) {
  renderMetricsEndpointStatus(system.metrics_endpoint);
  const uptimeSeconds = Number(system.uptime_seconds);
  systemUptimeBaseSeconds = Number.isFinite(uptimeSeconds) ? Math.max(0, uptimeSeconds) : null;
  systemUptimeSyncedAt = Date.now();
  const serverTimeMs = Date.parse(system.current_server_time || "");
  systemServerTimeBaseMs = Number.isFinite(serverTimeMs) ? serverTimeMs : null;
  systemServerTimeOffsetMinutes = parseRfc3339OffsetMinutes(system.current_server_time);
  const metrics = system.runtime_metrics || {};
  const cleanup = metrics.cleanup || {};
  const entries = [
    ["服务", system.service || "WildToken"],
    ["版本", system.version || "—"],
    ["运行时长", formatUptime(systemUptimeBaseSeconds)],
    ["当前服务器时间", system.current_server_time || "—"],
    ["数据库", system.database_ok ? "连接正常" : "不可用"],
    ["数据库已分配", system.database_allocated_bytes == null ? "—" : formatBytes(system.database_allocated_bytes)],
    ["日志总数", Number(system.total_log_count || 0).toLocaleString("zh-CN")],
    ["近 24 小时日志", Number(system.log_count_24h || 0).toLocaleString("zh-CN")],
    ["启用渠道", `${system.enabled_upstream_count || 0} / ${system.total_upstream_count || 0}`],
    ["近 1 分钟成功请求", Number(system.recent_one_minute_log_count || 0).toLocaleString("zh-CN")],
    ["活跃 SSE", Number(metrics.active_sse_streams || 0).toLocaleString("zh-CN")],
    ["10 分钟 SSE 断连", Number(metrics.sse_recent_disconnects_10m || 0).toLocaleString("zh-CN")],
    ["SSE 断连总数", Number(metrics.sse_client_disconnects_total || 0).toLocaleString("zh-CN")],
    ["SSE 上游错误", Number(metrics.sse_upstream_errors_total || 0).toLocaleString("zh-CN")],
    ["日志队列", Number(metrics.log_queue_depth || 0).toLocaleString("zh-CN")],
    ["日志写入", Number(metrics.log_written_total || 0).toLocaleString("zh-CN")],
    ["日志写批次", Number(metrics.log_write_batches_total || 0).toLocaleString("zh-CN")],
    ["日志丢弃", Number(metrics.log_dropped_total || 0).toLocaleString("zh-CN")],
    ["日志写失败", Number(metrics.log_write_failures_total || 0).toLocaleString("zh-CN")],
    ["慢 DB 操作", Number(metrics.slow_db_operations_total || 0).toLocaleString("zh-CN")],
    ["清理任务", cleanup.active ? "运行中" : "空闲"],
    ["清理进度", cleanup.active
      ? `${Number(cleanup.current_rows_cleared || 0).toLocaleString("zh-CN")} 行 / ${Number(cleanup.current_batches || 0).toLocaleString("zh-CN")} 批`
      : `${Number(cleanup.last_rows_cleared || 0).toLocaleString("zh-CN")} 行 · ${formatMetricDuration(cleanup.last_duration_ms)}`],
  ];
  systemInfoGrid.innerHTML = entries.map(([label, value]) => `<div class="system-info-item"><span>${escapeHtml(label)}</span><strong${label === "运行时长" ? " data-system-uptime" : ""}${label === "当前服务器时间" ? " data-system-server-time" : ""}>${escapeHtml(String(value))}</strong></div>`).join("");
  const timeout = Number(system.default_upstream_timeout_seconds);
  const timeoutEl = document.querySelector("#settings-default-timeout");
  if (timeoutEl && Number.isFinite(timeout)) timeoutEl.textContent = `${timeout} 秒`;
  refreshSystemUptime();
  startSystemUptimeTicker();
}

async function loadSettingsPage() {
  updatePreferenceControls();
  try {
    const [settings, system, prompts] = await Promise.all([
      api("/api/admin/settings"),
      api("/api/admin/system"),
      api("/api/admin/settings/model-test-prompts"),
    ]);
    fillServerSettings(settings);
    renderSystemInfo(system);
    modelTestPromptTemplates = prompts;
    renderModelTestPromptList();
  } catch (error) {
    if (currentViewFromHash() === "settings") {
      setSettingsStatus("无法加载设置，请检查连接后重试。", "error");
      setRoutingSettingsStatus("无法加载路由策略，请检查连接后重试。", "error");
      if (systemInfoGrid) systemInfoGrid.innerHTML = `<p class="settings-loading">运行信息暂不可用。</p>`;
      // Left as unknown rather than as "disabled": a failed load says nothing
      // about whether the endpoint is exposed.
      if (metricsEndpointStatusEl) metricsEndpointStatusEl.innerHTML = `<strong>端点状态暂不可用</strong><p>无法读取运行信息，请检查连接后重试。</p>`;
    }
  }
  // Loaded separately from the block above so a failure there does not leave a
  // staged restore unreported: an operator who cannot see one waiting would restart
  // into a replaced database without knowing why.
  await loadDisasterRecoveryInfo();
}

function closeModelTestDialog() {
  modelTestUpstream = null;
  clearDialogMaximized(modelTestDialog);
  if (modelTestDialog.open && typeof modelTestDialog.close === "function") modelTestDialog.close();
  else modelTestDialog.removeAttribute("open");
}

function renderModelTestPromptTemplateOptions() {
  const randomTemplate = modelTestPromptTemplates[Math.floor(Math.random() * modelTestPromptTemplates.length)];
  modelTestPromptTemplate.innerHTML = modelTestPromptTemplates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  if (randomTemplate) modelTestPromptTemplate.value = String(randomTemplate.id);
}

function syncModelTestPrompt() {
  const prompt = modelTestPromptTemplates.find((item) => item.id === Number(modelTestPromptTemplate.value));
  modelTestPrompt.value = prompt?.prompt || "";
}

function formatHttpRequest(request) {
  const url = new URL(request.url);
  const headers = { host: url.host, ...(request.headers || {}) };
  const lines = [`POST ${url.pathname}${url.search} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${JSON.stringify(request.body || {}, null, 2)}`;
}

function formatHttpResponse(result) {
  const status = result.status_code || 0;
  const lines = [`HTTP/1.1 ${status}`];
  for (const [name, value] of Object.entries(result.response_headers || {}).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${result.preview || result.message || ""}`;
}

function configuredModels(upstream) {
  return [...new Set([
    ...(upstream.model_names || []),
    ...Object.values(upstream.model_mappings || {}),
  ].filter(Boolean))];
}

function renderModelTestModelOptions(models, selected = "") {
  const normalized = [...new Set(models)].sort((a, b) => a.localeCompare(b));
  modelTestModel.innerHTML = normalized.length
    ? normalized.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")
    : `<option value="" disabled selected>此渠道尚未配置模型</option>`;
  if (selected && normalized.includes(selected)) modelTestModel.value = selected;
  modelTestSubmit.disabled = normalized.length === 0;
}

async function openModelTestDialog(upstream) {
  modelTestUpstream = upstream;
  modelTestTitle.textContent = `测试模型：${upstream.name}`;
  modelTestSummary.textContent = "向当前渠道发送一次实际模型请求。";
  modelTestResult.hidden = true;
  modelTestResultBody.textContent = "";
  modelTestRequestBody.textContent = "";
  modelTestResponseBody.textContent = "";
  try {
    modelTestPromptTemplates = await api("/api/admin/settings/model-test-prompts");
    renderModelTestPromptTemplateOptions();
    syncModelTestPrompt();
    renderModelTestModelOptions(configuredModels(upstream));
    if (typeof modelTestDialog.showModal === "function") modelTestDialog.showModal();
    else modelTestDialog.setAttribute("open", "");
    if (configuredModels(upstream).length > 0) modelTestModel.focus();
  } catch (error) {
    setStatus(`无法打开模型测试：${error.message}`, "error");
  }
}

async function refreshModelTestModels() {
  if (!modelTestUpstream) return;
  const previous = modelTestModel.value;
  modelTestRefreshModels.disabled = true;
  modelTestRefreshModels.textContent = "刷新中";
  try {
    const result = await api(`/api/admin/upstreams/${modelTestUpstream.id}/models`, { method: "POST" });
    renderModelTestModelOptions(result.models || [], previous);
  } catch (error) {
    setStatus(`拉取模型失败：${error.message}`, "error");
  } finally {
    modelTestRefreshModels.disabled = false;
    modelTestRefreshModels.textContent = "刷新模型";
  }
}

function renderModelTestPromptList() {
  if (!modelTestPromptList) return;
  if (modelTestPromptTemplates.length === 0) {
    modelTestPromptList.innerHTML = `<p class="settings-loading">暂无 Prompt。</p>`;
    return;
  }
  modelTestPromptList.innerHTML = modelTestPromptTemplates.map((template) => `
    <div class="model-test-template-item">
      <div><strong>${escapeHtml(template.name)}</strong><p title="${escapeHtml(template.prompt)}">${escapeHtml(template.prompt)}</p></div>
      <div class="model-test-template-actions"><button type="button" class="secondary small" data-model-prompt-action="edit" data-prompt-id="${template.id}">编辑</button><button type="button" class="secondary small danger" data-model-prompt-action="delete" data-prompt-id="${template.id}">删除</button></div>
    </div>`).join("");
}

function openModelTestPromptDialog(template = null) {
  modelTestPromptForm.reset();
  modelTestPromptId.value = template?.id || "";
  modelTestPromptName.value = template?.name || "";
  modelTestPromptContent.value = template?.prompt || "";
  document.querySelector("#model-test-prompt-title").textContent = template ? `编辑 Prompt：${template.name}` : "新增 Prompt";
  if (typeof modelTestPromptDialog.showModal === "function") modelTestPromptDialog.showModal();
  else modelTestPromptDialog.setAttribute("open", "");
  modelTestPromptName.focus();
}

function closeModelTestPromptDialog() {
  clearDialogMaximized(modelTestPromptDialog);
  if (modelTestPromptDialog.open && typeof modelTestPromptDialog.close === "function") modelTestPromptDialog.close();
  else modelTestPromptDialog.removeAttribute("open");
}

/* 测试窗口的 Prompt 下拉只在打开时填一次，所以设置页改完要主动同步一遍，
   否则窗口还开着的人会选到一个已经改名或删掉的模板。 */
async function refreshModelTestPromptDropdown() {
  modelTestPromptTemplates = await api("/api/admin/settings/model-test-prompts");
  renderModelTestPromptList();
  if (!modelTestPromptTemplate) return;
  const previous = Number(modelTestPromptTemplate.value);
  modelTestPromptTemplate.innerHTML = modelTestPromptTemplates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  // 原来选的还在就留着，不打断正在编辑的一次测试；没了才让浏览器落到第一项。
  if (modelTestPromptTemplates.some((template) => template.id === previous)) {
    modelTestPromptTemplate.value = String(previous);
  }
  // 选中项的正文可能刚被改过，正文框跟着走一遍。
  if (modelTestDialog?.open) syncModelTestPrompt();
}

function runtimeSettingsPayload() {
  return {
    log_body_keep_count: Number(settingsBodyKeepCount.value),
    log_retention_days: Number(settingsRetentionDays.value),
    log_body_max_bytes: Number(settingsBodyMaxBytes.value),
    max_retries: Number(settingsMaxRetries.value),
    same_upstream_retry_interval_ms: Number(settingsSameUpstreamRetryMs.value),
    auto_weight_failure_penalty: Number(settingsFailurePenalty.value),
    auto_weight_success_increment: Number(settingsSuccessIncrement.value),
    auto_weight_recovery_increment: Number(settingsRecoveryIncrement.value),
    auto_weight_recovery_interval_seconds: Number(settingsRecoveryInterval.value),
    proxy_enabled: Boolean(settingsProxyEnabled?.checked),
    proxy_url: (settingsProxyUrl?.value || "").trim(),
    load_balance_strategy: (settingsLoadBalanceStrategy?.value || loadedServerSettings?.load_balance_strategy || "weighted").trim(),
    revision: loadedServerSettings.revision,
  };
}

const nonIntegerSettingsKeys = new Set(["revision", "proxy_enabled", "proxy_url", "load_balance_strategy"]);

function runtimeSettingsAreIntegers(payload) {
  return Object.entries(payload).every(([key, value]) => nonIntegerSettingsKeys.has(key) || Number.isInteger(value));
}

async function saveServerSettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = runtimeSettingsPayload();
  if (!runtimeSettingsAreIntegers(payload)) {
    setSettingsStatus("请填写有效的整数。", "error");
    return;
  }
  const lowersRetention = payload.log_body_keep_count < loadedServerSettings.log_body_keep_count || payload.log_retention_days < loadedServerSettings.log_retention_days;
  if (lowersRetention && !await requestConfirm({ title: "确认缩短日志保留", message: "降低正文保留数量或日志保留天数会在下一轮清理周期移除更多历史内容，且不能恢复。", confirmLabel: "确认保存", danger: true })) return;
  const saveButton = document.querySelector("#server-settings-save");
  saveButton.disabled = true;
  setSettingsStatus("正在保存…");
  try {
    const updated = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    fillServerSettings(updated);
    setSettingsStatus("日志策略已保存。", "ok");
  } catch (error) {
    if (error.status === 409) {
      await loadSettingsPage();
      setSettingsStatus("设置已被其他操作更新，已重新加载最新值；请确认后再保存。", "error");
    } else {
      setSettingsStatus("保存失败，请稍后重试。", "error");
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function saveRoutingSettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = runtimeSettingsPayload();
  if (!runtimeSettingsAreIntegers(payload)) {
    setRoutingSettingsStatus("请填写有效的整数。", "error");
    return;
  }
  const saveButton = document.querySelector("#routing-settings-save");
  saveButton.disabled = true;
  setRoutingSettingsStatus("正在保存…");
  try {
    const updated = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    fillServerSettings(updated);
    setRoutingSettingsStatus("路由策略已保存。", "ok");
    await loadUpstreams();
  } catch (error) {
    if (error.status === 409) {
      await loadSettingsPage();
      setRoutingSettingsStatus("设置已被其他操作更新，已重新加载最新值；请确认后再保存。", "error");
    } else {
      setRoutingSettingsStatus("保存失败，请检查参数后重试。", "error");
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function saveProxySettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = runtimeSettingsPayload();
  if (payload.proxy_enabled && !payload.proxy_url) {
    setProxySettingsStatus("启用代理时必须填写代理地址。", "error");
    return;
  }
  if (payload.proxy_url && !/^(https?|socks5h?):\/\/.+/i.test(payload.proxy_url)) {
    setProxySettingsStatus("代理地址必须以 http://、https://、socks5:// 或 socks5h:// 开头。", "error");
    return;
  }
  const saveButton = document.querySelector("#proxy-settings-save");
  saveButton.disabled = true;
  setProxySettingsStatus("正在保存…");
  try {
    const updated = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    fillServerSettings(updated);
    setProxySettingsStatus(updated.proxy_enabled ? "代理设置已保存，出站请求将经过代理。" : "代理设置已保存，出站请求不走代理。", "ok");
  } catch (error) {
    if (error.status === 409) {
      await loadSettingsPage();
      setProxySettingsStatus("设置已被其他操作更新，已重新加载最新值；请确认后再保存。", "error");
    } else {
      setProxySettingsStatus("保存失败，请检查代理地址后重试。", "error");
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function rotateAdminToken() {
  const token = await requestRotationConfirm();
  if (!token) return;
  rotateAdminTokenButton.disabled = true;
  try {
    await api("/api/admin/settings/admin-token/rotate", {
      method: "POST",
      body: JSON.stringify({ confirm: true, token }),
    });
    setAdminToken(token);
    setStatus("管理员令牌已更换，当前控制台已改用新令牌。", "ok");
  } catch (error) {
    setStatus(error.status === 409 ? "令牌已被其他操作轮换，请重新登录。" : "轮换失败，请稍后重试。", "error");
  } finally {
    rotateAdminTokenButton.disabled = false;
  }
}

function requestRotationConfirm() {
  return new Promise((resolve) => {
    if (!rotateConfirmDialog) { resolve(null); return; }
    rotateAdminTokenInput.value = "";
    rotateConfirmCheck.checked = false;
    rotateConfirmSubmit.disabled = true;
    const finish = (token) => {
      rotateAdminTokenForm.removeEventListener("submit", approve);
      rotateConfirmCancel.removeEventListener("click", cancel);
      rotateConfirmCheck.removeEventListener("change", toggle);
      rotateAdminTokenInput.removeEventListener("input", toggle);
      rotateConfirmDialog.removeEventListener("cancel", cancelEvent);
      if (rotateConfirmDialog.open) rotateConfirmDialog.close();
      resolve(token);
    };
    const validToken = () => /^[\x21-\x7E]{8,256}$/.test(rotateAdminTokenInput.value.trim());
    const approve = (event) => {
      event.preventDefault();
      const token = rotateAdminTokenInput.value.trim();
      if (!rotateConfirmCheck.checked || !validToken()) {
        rotateAdminTokenInput.reportValidity();
        return;
      }
      finish(token);
    };
    const cancel = () => finish(null);
    const cancelEvent = (event) => { event.preventDefault(); finish(null); };
    const toggle = () => { rotateConfirmSubmit.disabled = !rotateConfirmCheck.checked || !validToken(); };
    rotateAdminTokenForm.addEventListener("submit", approve);
    rotateConfirmCancel.addEventListener("click", cancel);
    rotateConfirmCheck.addEventListener("change", toggle);
    rotateAdminTokenInput.addEventListener("input", toggle);
    rotateConfirmDialog.addEventListener("cancel", cancelEvent);
    if (typeof rotateConfirmDialog.showModal === "function") rotateConfirmDialog.showModal(); else rotateConfirmDialog.setAttribute("open", "");
    rotateAdminTokenInput.focus();
  });
}

const NON_OVERRIDABLE_CHANNEL_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "x-wildtoken-upstream",
]);
const DOWNSTREAM_CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CLIENT_HEADER_PLACEHOLDER_PATTERN = /^\{client_header:([^{}]+)\}$/;
