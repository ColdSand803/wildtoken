// ── Themes (registry-driven; switching saves immediately) ──
const THEME_KEY = "wildtoken_theme";
const THEME_CSS_KEY = "wildtoken_theme_css";
const THEME_CSS_ID_KEY = "wildtoken_theme_css_id";
const THEME_PACK_LINK_ID = "theme-pack-css";
const themeToggle = document.querySelector("#theme-toggle");
const themeMenu = document.querySelector("#theme-menu");

const BUILT_IN_THEMES = Object.freeze([
  { id: "dark", label: "深色", swatch: ["#020617", "#22d3ee"] },
  { id: "light", label: "浅色", swatch: ["#f4f6fb", "#0891b2"] },
]);

const BUNDLED_THEME_PACKS = Object.freeze([
  { id: "ark", label: "Ark", swatch: ["#080a0b", "#18d1ff"], css: "/theme-packs/ark/theme.css" },
  { id: "win95", label: "Win95", swatch: ["#c0c0c0", "#000080"], css: "/theme-packs/win95/theme.css" },
  { id: "animal-island", label: "动物岛", swatch: ["#f8f8f0", "#19c8b9"], css: "/theme-packs/animal-island/theme.css" },
  { id: "cyberpunk", label: "赛博朋克", swatch: ["#0a0612", "#ff2bd6"], css: "/theme-packs/cyberpunk/theme.css" },
  { id: "nes", label: "像素", swatch: ["#0f0f1b", "#e52521"], css: "/theme-packs/nes/theme.css" },
  { id: "crt", label: "CRT", swatch: ["#020b05", "#39ff14"], css: "/theme-packs/crt/theme.css" },
  { id: "minecraft", label: "我的世界", swatch: ["#38373f", "#5ec639"], css: "/theme-packs/minecraft/theme.css" },
  { id: "bleach", label: "Bleach", swatch: ["#fff7ed", "#f97316"], css: "/theme-packs/bleach/theme.css" },
  { id: "endfield", label: "Endfield", swatch: ["#f2f2f0", "#fffa00"], css: "/theme-packs/endfield/theme.css" },
  { id: "sakura-mist", label: "樱雾灰紫", swatch: ["#ffe3ee", "#535369"], css: "/theme-packs/sakura-mist/theme.css" },
]);
let THEMES = [...BUILT_IN_THEMES, ...BUNDLED_THEME_PACKS];

const ARK_THEME_CONFIG = {
  ark: { family: "ark", depth: "complex", optionLabel: "OPS SYSTEM / 03" },
  endfield: { family: "endfield", depth: "complex", optionLabel: "FIELD SYSTEM / 03" },
};

// 旧 id "animal" 迁移为 "animal-island"
function normalizeThemeId(value) {
  return value === "animal" ? "animal-island" : value;
}

function isSafeThemeId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value);
}

function isSafeThemeCssHref(value) {
  return typeof value === "string"
    && value.indexOf("..") === -1
    && /^\/theme-packs\/[a-z][a-z0-9-]{0,47}\/[A-Za-z0-9._/-]+\.css$/.test(value);
}

function findTheme(value) {
  const id = normalizeThemeId(value);
  return THEMES.find((theme) => theme.id === id) || null;
}

function isKnownTheme(value) {
  return Boolean(findTheme(value));
}

function themeLabel(id) {
  return findTheme(id)?.label || id;
}

function themeMenuChoices() {
  return Array.from(themeMenu?.querySelectorAll("[data-theme-choice]") || []);
}

function focusThemeMenuChoice(position = "selected") {
  const choices = themeMenuChoices();
  if (!choices.length) return;
  const selectedIndex = Math.max(0, choices.findIndex((button) => button.classList.contains("is-selected")));
  const index = position === "first"
    ? 0
    : position === "last"
      ? choices.length - 1
      : selectedIndex;
  choices[index]?.focus();
}

function getStoredTheme() {
  try {
    const value = normalizeThemeId(localStorage.getItem(THEME_KEY));
    return isKnownTheme(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

function setThemePackStylesheet(theme) {
  const css = theme?.css || "";
  let link = document.getElementById(THEME_PACK_LINK_ID);
  if (!isSafeThemeCssHref(css)) {
    link?.remove();
    return;
  }

  if (!link) {
    link = document.createElement("link");
    link.id = THEME_PACK_LINK_ID;
    link.rel = "stylesheet";
  }
  const appStyles = document.querySelector('link[href="/static/styles.css"]');
  if (appStyles && appStyles.nextSibling !== link && typeof appStyles.after === "function") {
    appStyles.after(link);
  } else if (!link.parentNode) {
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== css) {
    link.setAttribute("href", css);
  }
}

function rememberTheme(next, theme) {
  try {
    localStorage.setItem(THEME_KEY, next);
    if (isSafeThemeCssHref(theme?.css || "")) {
      localStorage.setItem(THEME_CSS_ID_KEY, next);
      localStorage.setItem(THEME_CSS_KEY, theme.css);
    } else {
      localStorage.removeItem(THEME_CSS_ID_KEY);
      localStorage.removeItem(THEME_CSS_KEY);
    }
  } catch {
    /* ignore quota / private mode */
  }
}

function applyTheme(theme) {
  const themeDef = findTheme(theme) || findTheme("dark");
  const next = themeDef.id;
  const arkTheme = ARK_THEME_CONFIG[next];
  setThemePackStylesheet(themeDef);
  document.documentElement.setAttribute("data-theme", next);
  if (arkTheme) {
    document.documentElement.setAttribute("data-ark-theme", arkTheme.family);
    document.documentElement.setAttribute("data-ark-depth", arkTheme.depth);
  } else {
    document.documentElement.removeAttribute("data-ark-theme");
    document.documentElement.removeAttribute("data-ark-depth");
  }
  rememberTheme(next, themeDef);
  if (themeToggle) {
    const label = `选择主题（当前：${themeLabel(next)}）`;
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
  }
  themeMenuChoices().forEach((button) => {
    const selected = button.dataset.themeChoice === next;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  if (typeof updatePreferenceControls === "function") updatePreferenceControls();
}

function cycleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || getStoredTheme();
  const index = THEMES.findIndex((theme) => theme.id === current);
  const nextIndex = index >= 0 ? (index + 1) % THEMES.length : 0;
  applyTheme(THEMES[nextIndex].id);
}

function renderThemeChoices() {
  if (themeMenu) {
    const fragment = document.createDocumentFragment();
    THEMES.forEach((theme) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", "false");
      button.dataset.themeChoice = theme.id;

      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      swatch.style.setProperty("--swatch-bg", theme.swatch[0]);
      swatch.style.setProperty("--swatch-accent", theme.swatch[1]);
      swatch.setAttribute("aria-hidden", "true");

      const label = document.createElement("span");
      label.textContent = theme.label;

      button.append(swatch, label);
      fragment.append(button);
    });
    themeMenu.replaceChildren(fragment);
  }
  if (settingsTheme) {
    const fragment = document.createDocumentFragment();
    THEMES.forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = `${theme.label}${ARK_THEME_CONFIG[theme.id] ? ` · ${ARK_THEME_CONFIG[theme.id].optionLabel}` : ""}`;
      fragment.append(option);
    });
    settingsTheme.replaceChildren(fragment);
  }
}

function normalizeHexColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())
    ? value.trim()
    : fallback;
}

function normalizeExternalTheme(theme) {
  if (!theme || typeof theme !== "object") return null;
  const id = normalizeThemeId(String(theme.id || "").trim());
  const css = String(theme.css || "").trim();
  if (!isSafeThemeId(id) || !isSafeThemeCssHref(css)) return null;

  const rawLabel = String(theme.label || theme.name || id).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const swatch = Array.isArray(theme.swatch) ? theme.swatch : [];
  return {
    id,
    label: rawLabel.slice(0, 64) || id,
    swatch: [
      normalizeHexColor(swatch[0], "#f8fafc"),
      normalizeHexColor(swatch[1], "#f97316"),
    ],
    css,
    external: true,
  };
}

function mergeThemePacks(rawThemes) {
  const knownIds = new Set(BUILT_IN_THEMES.map((theme) => theme.id));
  const rawThemeById = new Map();
  rawThemes
    .map(normalizeExternalTheme)
    .forEach((theme) => {
      if (!theme || knownIds.has(theme.id) || rawThemeById.has(theme.id)) return;
      rawThemeById.set(theme.id, theme);
    });

  const externalThemes = [];
  BUNDLED_THEME_PACKS.forEach((theme) => {
    if (knownIds.has(theme.id)) return;
    knownIds.add(theme.id);
    externalThemes.push(rawThemeById.get(theme.id) || theme);
    rawThemeById.delete(theme.id);
  });

  rawThemeById.forEach((theme) => {
    if (knownIds.has(theme.id)) return;
    knownIds.add(theme.id);
    externalThemes.push(theme);
  });
  return externalThemes;
}

async function loadExternalThemes() {
  let rawThemes = [];
  try {
    const response = await fetch("/api/themes", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    rawThemes = Array.isArray(payload) ? payload : Array.isArray(payload?.themes) ? payload.themes : [];
  } catch (error) {
    console.warn("Unable to load theme packs", error);
  }

  const externalThemes = mergeThemePacks(rawThemes);
  THEMES = [...BUILT_IN_THEMES, ...externalThemes];
}

function refreshThemeCommandSubtitle() {
  try {
    const command = COMMANDS.find((item) => item.id === "theme");
    if (command) command.subtitle = THEMES.map((theme) => theme.label).join(" / ");
  } catch {
    // COMMANDS is declared later in this file; it will be available after startup yields.
  }
}

async function initializeThemes() {
  renderThemeChoices();
  await loadExternalThemes();
  refreshThemeCommandSubtitle();
  renderThemeChoices();
  applyTheme(getStoredTheme());
}

function setThemeMenuOpen(open, { focus = false, position = "selected" } = {}) {
  if (!themeMenu || !themeToggle) return;
  themeMenu.hidden = !open;
  themeToggle.setAttribute("aria-expanded", String(open));
  if (open && focus) focusThemeMenuChoice(position);
}

initializeThemes();
if (themeToggle) {
  themeToggle.addEventListener("click", () => setThemeMenuOpen(Boolean(themeMenu?.hidden), { focus: true }));
  themeToggle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setThemeMenuOpen(true, { focus: true, position: event.key === "ArrowUp" ? "last" : "first" });
  });
}
themeMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button) return;
  applyTheme(button.dataset.themeChoice);
  setThemeMenuOpen(false);
  themeToggle?.focus();
});
themeMenu?.addEventListener("keydown", (event) => {
  const choices = themeMenuChoices();
  if (!choices.length) return;
  const currentIndex = Math.max(0, choices.indexOf(document.activeElement));
  let nextIndex = null;
  if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % choices.length;
  if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + choices.length) % choices.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = choices.length - 1;
  if (nextIndex !== null) {
    event.preventDefault();
    choices[nextIndex].focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setThemeMenuOpen(false);
    themeToggle?.focus();
  }
});
themeMenu?.addEventListener("focusout", () => {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (!themeMenu?.contains(active) && !themeToggle?.contains(active)) setThemeMenuOpen(false);
  }, 0);
});
document.addEventListener("click", (event) => {
  if (
    themeMenu && !themeMenu.hidden
    && !themeMenu.contains(event.target)
    && !themeToggle?.contains(event.target)
  ) {
    setThemeMenuOpen(false);
  }
});

// ── Density toggle ───────────────────────────────────────
applyDensity(getDensity());
if (densityToggle) {
  densityToggle.addEventListener("click", cycleDensity);
}

settingsTheme?.addEventListener("change", () => {
  applyTheme(settingsTheme.value);
});
settingsDensity?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-density-choice]");
  if (!button) return;
  applyDensity(button.dataset.densityChoice);
  updatePreferenceControls();
});
settingsLogRefresh?.addEventListener("change", () => {
  try { localStorage.setItem(LOG_REFRESH_KEY, settingsLogRefresh.value); } catch { /* ignore */ }
  stopLogRefresh();
  if (currentViewFromHash() === "logs") startLogRefresh();
});
settingsDefaultHome?.addEventListener("change", () => {
  try { localStorage.setItem(DEFAULT_HOME_KEY, settingsDefaultHome.value); } catch { /* ignore */ }
});
serverSettingsForm?.addEventListener("submit", saveServerSettings);
routingSettingsForm?.addEventListener("submit", saveRoutingSettings);
newModelTestTemplateButton?.addEventListener("click", () => openModelTestTemplateDialog());
modelTestTemplateList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-model-template-action]");
  if (!button) return;
  const template = modelTestTemplates.find((item) => item.id === Number(button.dataset.templateId));
  if (!template) return;
  if (button.dataset.modelTemplateAction === "edit") {
    openModelTestTemplateDialog(template);
    return;
  }
  const confirmed = await requestConfirm({ title: "删除测试模板", message: `确定删除模板「${template.name}」？`, confirmLabel: "删除模板", danger: true });
  if (!confirmed) return;
  try {
    await api(`/api/admin/settings/model-test-templates/${template.id}`, { method: "DELETE" });
    modelTestTemplates = modelTestTemplates.filter((item) => item.id !== template.id);
    renderModelTestTemplates();
    setStatus("测试模板已删除。", "ok");
  } catch (error) {
    setStatus(`删除模板失败：${error.message}`, "error");
  }
});
modelTestTemplateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = modelTestTemplateId.value;
  const payload = {
    name: modelTestTemplateName.value.trim(),
    request_kind: modelTestTemplateKind.value,
    prompt: modelTestTemplatePrompt.value.trim(),
  };
  try {
    const saved = await api(id ? `/api/admin/settings/model-test-templates/${id}` : "/api/admin/settings/model-test-templates", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    modelTestTemplates = id
      ? modelTestTemplates.map((item) => item.id === saved.id ? saved : item)
      : [...modelTestTemplates, saved];
    renderModelTestTemplates();
    closeModelTestTemplateDialog();
    setStatus("测试模板已保存。", "ok");
  } catch (error) {
    setStatus(`保存模板失败：${error.message}`, "error");
  }
});
modelTestTemplateClose?.addEventListener("click", closeModelTestTemplateDialog);
modelTestTemplateCancel?.addEventListener("click", closeModelTestTemplateDialog);
dismissOnBackdropClick(modelTestTemplateDialog, closeModelTestTemplateDialog);
modelTestTemplate?.addEventListener("change", updateModelTestTemplateHint);
modelTestPromptTemplate?.addEventListener("change", updateModelTestTemplateHint);
modelTestClose?.addEventListener("click", closeModelTestDialog);
modelTestRefreshModels?.addEventListener("click", refreshModelTestModels);
modelTestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!modelTestUpstream) return;
  modelTestSubmit.disabled = true;
  modelTestSubmit.textContent = "测试中";
  modelTestResult.hidden = true;
  try {
    const result = await api(`/api/admin/upstreams/${modelTestUpstream.id}/test-model`, {
      method: "POST",
      body: JSON.stringify({ model: modelTestModel.value, wrapper_id: Number(modelTestTemplate.value), prompt_template_id: Number(modelTestPromptTemplate.value), prompt: modelTestPrompt.value.trim() }),
    });
    modelTestResult.hidden = false;
    modelTestResultStatus.textContent = result.ok ? `测试成功 · HTTP ${result.status_code}` : `测试失败${result.status_code ? ` · HTTP ${result.status_code}` : ""}`;
    modelTestResultMeta.textContent = result.content_type || "";
    modelTestPrompt.value = result.prompt || modelTestPrompt.value;
    modelTestResultBody.textContent = result.reply || result.preview || result.message || "渠道未返回正文。";
    modelTestRequestBody.textContent = formatHttpRequest(result.request || { url: "http://invalid/", headers: {}, body: {} });
    modelTestResponseBody.textContent = formatHttpResponse(result);
  } catch (error) {
    modelTestResult.hidden = false;
    modelTestResultStatus.textContent = "测试失败";
    modelTestResultMeta.textContent = "";
    modelTestResultBody.textContent = error.message;
    modelTestRequestBody.textContent = "";
    modelTestResponseBody.textContent = "";
  } finally {
    modelTestSubmit.disabled = false;
    modelTestSubmit.textContent = "发送测试";
  }
});
systemRefreshButton?.addEventListener("click", async () => {
  systemRefreshButton.disabled = true;
  try { await loadSettingsPage(); } finally { systemRefreshButton.disabled = false; }
});
rotateAdminTokenButton?.addEventListener("click", rotateAdminToken);

// ── Dashboard controls ───────────────────────────────────
if (dashboardRefreshButton) {
  dashboardRefreshButton.addEventListener("click", () => {
    loadDashboardData();
  });
}
if (dashboardChannelNameToggle) {
  updateDashboardChannelNameToggle();
  dashboardChannelNameToggle.addEventListener("click", () => {
    setDashboardChannelNameHidden(!dashboardChannelNameHidden);
  });
}

if (dashboardTopWindowSelect) {
  dashboardTopWindowSelect.addEventListener("change", () => {
    const nextWindow = DASHBOARD_TOP_WINDOW_VALUES.has(dashboardTopWindowSelect.value)
      ? dashboardTopWindowSelect.value
      : "today";
    dashboardTopWindow = nextWindow;
    dashboardTopWindowSelect.value = nextWindow;
    try {
      localStorage.setItem(DASHBOARD_TOP_WINDOW_KEY, nextWindow);
    } catch {
      // Ignore storage failures; the selection still applies to the current page.
    }
    loadDashboardData();
  });
}
if (dashboardErrorRows) {
  dashboardErrorRows.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-log-id]");
    if (!row) return;
    showLogDetail(row.dataset.logId);
  });
  dashboardErrorRows.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr[data-log-id]");
    if (!row) return;
    event.preventDefault();
    showLogDetail(row.dataset.logId);
  });
}

// ── Column menus ─────────────────────────────────────────
if (upstreamColMenuBtn) {
  upstreamColMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleColMenu(upstreamColMenu, upstreamColMenuBtn);
  });
}
if (logColMenuBtn) {
  logColMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleColMenu(logColMenu, logColMenuBtn);
  });
}
applyAllColumnVisibility();
updateUpstreamSortControls();
upstreamTable?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-upstream-sort]");
  if (button) setUpstreamSort(button.dataset.upstreamSort);
});

// ── Batch enable/disable ─────────────────────────────────
if (upstreamSelectAll) {
  upstreamSelectAll.addEventListener("change", () => {
    const filtered = getFilteredUpstreams();
    if (upstreamSelectAll.checked) {
      for (const item of filtered) {
        selectedUpstreamIds.add(item.id);
      }
    } else {
      for (const item of filtered) {
        selectedUpstreamIds.delete(item.id);
      }
    }
    // Sync visible checkboxes without full re-render when possible
    for (const input of rows.querySelectorAll("input[data-upstream-check]")) {
      const id = Number(input.dataset.upstreamCheck);
      input.checked = selectedUpstreamIds.has(id);
    }
    updateBatchToolbar();
  });
}
if (batchEnableBtn) {
  batchEnableBtn.addEventListener("click", () => batchSetEnabled(true));
}
if (batchDisableBtn) {
  batchDisableBtn.addEventListener("click", () => batchSetEnabled(false));
}

// ── Page Visibility smart polling ────────────────────────
document.addEventListener("visibilitychange", () => {
  pageVisible = document.visibilityState !== "hidden";
  if (pageVisible) {
    resumeAutoRefreshForCurrentView();
    refreshCurrentView();
  } else {
    pauseAllAutoRefresh();
  }
});

// ── Filters: upstreams / tokens ───────────────────────────
if (upstreamSearchInput) {
  upstreamSearchInput.addEventListener(
    "input",
    debounce(() => {
      upstreamSearchQuery = upstreamSearchInput.value || "";
      if (!priorityEditorIsOpen()) {
        renderRows();
      }
    }, 150),
  );
}
if (upstreamStatusFilter) {
  upstreamStatusFilter.addEventListener("change", () => {
    upstreamStatusFilterValue = upstreamStatusFilter.value || "";
    if (!priorityEditorIsOpen()) {
      renderRows();
    }
  });
}
if (tokenSearchInput) {
  tokenSearchInput.addEventListener(
    "input",
    debounce(() => {
      tokenSearchQuery = tokenSearchInput.value || "";
      renderTokenRows();
    }, 150),
  );
}

// ── Command palette + keyboard shortcuts ─────────────────
let commandPaletteActiveIndex = 0;
let commandPaletteVisible = [];

function commandDefinitions() {
  return [
    {
      id: "view-dashboard",
      title: "切换到看板",
      subtitle: "查看运营概览与近窗指标",
      keys: "G D",
      run: () => switchView("dashboard"),
    },
    {
      id: "view-upstreams",
      title: "切换到渠道",
      subtitle: "查看与管理上游渠道",
      keys: "G C",
      run: () => switchView("upstreams"),
    },
    {
      id: "view-logs",
      title: "切换到日志",
      subtitle: "查看代理请求日志",
      keys: "G L",
      run: () => switchView("logs"),
    },
    {
      id: "view-tokens",
      title: "切换到令牌",
      subtitle: "管理下游 API 令牌",
      keys: "G T",
      run: () => switchView("tokens"),
    },
    {
      id: "view-settings",
      title: "切换到设置",
      subtitle: "管理控制台偏好与网关策略",
      keys: "G S",
      run: () => switchView("settings"),
    },
    {
      id: "refresh-dashboard",
      title: "刷新看板",
      subtitle: "重新加载近窗日志与渠道快照",
      keys: "",
      run: () => {
        switchView("dashboard");
        loadDashboardData();
      },
    },
    {
      id: "new-upstream",
      title: "新增渠道",
      subtitle: "打开渠道创建表单",
      keys: "N",
      run: () => {
        switchView("upstreams");
        resetForm();
        openUpstreamDialog();
      },
    },
    {
      id: "new-token",
      title: "新增令牌",
      subtitle: "打开令牌创建表单",
      keys: "N",
      run: () => {
        switchView("tokens");
        openTokenDialog("new");
      },
    },
    {
      id: "refresh",
      title: "刷新当前视图",
      subtitle: "重新加载当前页数据",
      keys: "R",
      run: () => refreshCurrentView(),
    },
    {
      id: "theme",
      title: "切换主题",
      subtitle: THEMES.map((theme) => theme.label).join(" / "),
      keys: "",
      run: () => cycleTheme(),
    },
    {
      id: "density",
      title: "切换密度",
      subtitle: "舒适 / 紧凑",
      keys: "",
      run: () => cycleDensity(),
    },
    {
      id: "focus-search",
      title: "聚焦搜索",
      subtitle: "跳到当前视图搜索框",
      keys: "/",
      run: () => focusCurrentSearch(),
    },
    {
      id: "logout",
      title: "退出登录",
      subtitle: "清除 Admin Token 并刷新",
      keys: "",
      run: () => {
        clearAdminToken();
        location.reload();
      },
    },
  ];
}

function renderCommandPaletteList(query = "") {
  if (!commandPaletteList) return;
  const q = query.trim().toLowerCase();
  commandPaletteVisible = commandDefinitions().filter((cmd) => {
    if (!q) return true;
    return `${cmd.title} ${cmd.subtitle} ${cmd.id}`.toLowerCase().includes(q);
  });
  if (commandPaletteActiveIndex >= commandPaletteVisible.length) {
    commandPaletteActiveIndex = Math.max(0, commandPaletteVisible.length - 1);
  }
  if (commandPaletteVisible.length === 0) {
    commandPaletteList.innerHTML = `<div class="command-palette-empty">无匹配命令</div>`;
    return;
  }
  commandPaletteList.innerHTML = commandPaletteVisible
    .map((cmd, index) => `
      <button
        type="button"
        class="command-palette-item${index === commandPaletteActiveIndex ? " is-active" : ""}"
        role="option"
        data-command-id="${escapeHtml(cmd.id)}"
        aria-selected="${index === commandPaletteActiveIndex}"
      >
        <span class="command-palette-item-title">${escapeHtml(cmd.title)}</span>
        ${cmd.keys ? `<span class="command-palette-item-keys">${escapeHtml(cmd.keys)}</span>` : "<span></span>"}
        <span class="command-palette-item-subtitle">${escapeHtml(cmd.subtitle)}</span>
      </button>
    `)
    .join("");
}

function openCommandPalette() {
  if (!commandPalette) return;
  commandPaletteActiveIndex = 0;
  if (commandPaletteInput) {
    commandPaletteInput.value = "";
  }
  renderCommandPaletteList("");
  if (typeof commandPalette.showModal === "function") {
    if (!commandPalette.open) {
      commandPalette.showModal();
    }
  } else {
    commandPalette.setAttribute("open", "");
  }
  commandPaletteInput?.focus();
}

function closeCommandPalette() {
  if (!commandPalette) return;
  if (commandPalette.open && typeof commandPalette.close === "function") {
    commandPalette.close();
  } else {
    commandPalette.removeAttribute("open");
  }
}

function runCommandById(id) {
  const cmd = commandDefinitions().find((item) => item.id === id);
  if (!cmd) return;
  closeCommandPalette();
  cmd.run();
}

function runActiveCommand() {
  const cmd = commandPaletteVisible[commandPaletteActiveIndex];
  if (!cmd) return;
  runCommandById(cmd.id);
}

if (commandPaletteList) {
  commandPaletteList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-command-id]");
    if (!item) return;
    runCommandById(item.dataset.commandId);
  });
}
if (commandPaletteInput) {
  commandPaletteInput.addEventListener("input", () => {
    commandPaletteActiveIndex = 0;
    renderCommandPaletteList(commandPaletteInput.value);
  });
  commandPaletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!commandPaletteVisible.length) return;
      commandPaletteActiveIndex = (commandPaletteActiveIndex + 1) % commandPaletteVisible.length;
      renderCommandPaletteList(commandPaletteInput.value);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!commandPaletteVisible.length) return;
      commandPaletteActiveIndex =
        (commandPaletteActiveIndex - 1 + commandPaletteVisible.length) % commandPaletteVisible.length;
      renderCommandPaletteList(commandPaletteInput.value);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runActiveCommand();
    }
  });
}
if (commandPalette) {
  dismissOnBackdropClick(commandPalette, closeCommandPalette);
  commandPalette.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCommandPalette();
  });
}

document.addEventListener("keydown", (event) => {
  const key = event.key;
  const meta = event.metaKey || event.ctrlKey;
  const target = event.target;

  if (themeMenu && !themeMenu.hidden) {
    if (key === "Escape") {
      event.preventDefault();
      setThemeMenuOpen(false);
      themeToggle?.focus();
    }
    return;
  }

  if (selectPanel && !selectPanel.hidden) {
    // Keyboard navigation for the custom select popup lives in bootstrap.js.
    return;
  }

  if (meta && (key === "k" || key === "K")) {
    event.preventDefault();
    if (commandPalette?.open) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }

  if (key === "Escape") {
    if (commandPalette?.open) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    const top = topOpenDialog();
    if (top) {
      const closed = closeDialogElement(top);
      if (closed) {
        event.preventDefault();
      }
      return;
    }
    if (activeActionMenuButton && !upstreamActionMenu.hidden) {
      event.preventDefault();
      closeUpstreamActionMenu(true);
    }
    return;
  }

  if (commandPalette?.open) {
    return;
  }

  if (isEditableTarget(target) || openDialogs().length > 0) {
    return;
  }

  if (key === "/") {
    event.preventDefault();
    focusCurrentSearch();
    return;
  }

  if (key === "n" || key === "N") {
    const view = currentViewName();
    if (view === "tokens") {
      event.preventDefault();
      openTokenDialog("new");
    } else if (view === "upstreams") {
      event.preventDefault();
      resetForm();
      openUpstreamDialog();
    }
  }
});

// Dialog maximize / restore (shared chrome next to close buttons).
document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-dialog-maximize]");
  if (!button) return;
  const dialog = button.closest("dialog");
  if (!dialog) return;
  event.preventDefault();
  toggleDialogMaximized(dialog);
});

// Start only after every classic script has registered its globals and listeners.
if (getAdminToken()) {
  initApp();
} else {
  openAdminTokenDialog();
}
