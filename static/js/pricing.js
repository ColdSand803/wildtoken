// Model pricing management: list, add versioned rules, delete, rate conversions.

/**
 * 将用户输入的每百万 Token 单价（主货币单位，如 2.50）转换为整数微单位 (micros)。
 * 严格使用整数运算，避免浮点数精度丢失。
 */
function unitPriceToMicros(val, microUnitsPerUnit = 1_000_000) {
  if (val === null || val === undefined || val === "") {
    return 0;
  }
  const str = String(val).trim();
  if (!str) return 0;

  const num = Number(str);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }

  // 区分整数与小数部分进行高精度换算
  const parts = str.split(".");
  const intPart = BigInt(parts[0] || "0");
  const fracRaw = (parts[1] || "").slice(0, 6);
  const fracPadded = fracRaw.padEnd(6, "0");
  const fracPart = BigInt(fracPadded);

  const microUnits = BigInt(microUnitsPerUnit);
  const totalMicros = intPart * microUnits + fracPart;

  const maxVal = BigInt(1_000_000) * microUnits;
  if (totalMicros > maxVal) {
    return Number(maxVal);
  }
  return Number(totalMicros);
}

/**
 * 格式化模型费率展示，输出如 "$2.50 / 1M" 或 "¥0.000250 / 1M"。
 */
function formatPricingRate(micros, currency = "USD", microUnitsPerUnit = 1_000_000) {
  if (micros === null || micros === undefined) {
    return "-";
  }
  const num = Number(micros);
  if (!Number.isFinite(num)) {
    return "-";
  }

  const curr = String(currency || "USD").toUpperCase();
  const symbol = curr === "USD" ? "$" : curr === "CNY" ? "¥" : `${curr} `;

  const negative = num < 0;
  const absMicros = Math.abs(num);
  let whole = Math.floor(absMicros / microUnitsPerUnit);
  const fraction = absMicros % microUnitsPerUnit;

  let digits = 2;
  if (whole === 0 && fraction > 0 && fraction < 10_000) {
    digits = 6;
  }

  const scale = Math.pow(10, digits);
  let scaled = Math.round((fraction * scale) / microUnitsPerUnit);
  if (scaled >= scale) {
    whole += 1;
    scaled = 0;
  }

  return `${negative ? "-" : ""}${symbol}${whole}.${String(scaled).padStart(digits, "0")} / 1M`;
}

/**
 * 加载模型定价规则列表。
 */
async function loadPricingRules() {
  if (pricingLoading) return;
  pricingLoading = true;

  if (pricingRuleRows && (!pricingRules || pricingRules.length === 0)) {
    pricingRuleRows.innerHTML = skeletonRowsMarkup(8, 3);
  }

  try {
    const data = await api("/api/admin/pricing");
    pricingRules = Array.isArray(data.rules) ? data.rules : [];
    pricingTableInfo = data;
    renderPricingRules();
  } catch (error) {
    if (pricingRuleRows) {
      pricingRuleRows.innerHTML = `
        <tr>
          <td colspan="8" class="empty empty-state">
            <div class="empty-state-inner">
              <p class="empty-state-title">无法加载模型定价规则</p>
              <p class="empty-state-copy">${escapeHtml(error.message || "请检查网络连接后重试。")}</p>
              <div class="empty-state-actions">
                <button type="button" data-empty-action="reload-pricing">重试加载</button>
              </div>
            </div>
          </td>
        </tr>
      `;
    }
  } finally {
    pricingLoading = false;
  }
}

/**
 * 渲染模型定价规则列表。
 */
function renderPricingRules() {
  if (!pricingRuleRows) return;

  if (!pricingRules || pricingRules.length === 0) {
    pricingRuleRows.innerHTML = emptyStateCell(8, {
      title: "暂无模型定价规则",
      copy: "按每百万 Token 设置各模型的输入、输出及缓存单价；请求将按发生时的规则版本精确折算成本。",
      actionLabel: "新增定价规则",
      actionId: "new-pricing-rule",
    });
    return;
  }

  const microUnits = pricingTableInfo?.micro_units_per_unit || 1_000_000;

  pricingRuleRows.innerHTML = pricingRules
    .map((rule) => {
      const isWildcard = rule.model_pattern.endsWith("*");
      const wildcardBadge = isWildcard
        ? `<span class="badge badge-wildcard" title="通配符规则，匹配此前缀的所有模型">通配</span>`
        : "";
      const currencyBadge = `<span class="badge ${rule.currency === "USD" ? "badge-usd" : "badge-cny"}">${escapeHtml(rule.currency)}</span>`;

      const promptRate = formatPricingRate(rule.prompt_micros, rule.currency, microUnits);
      const completionRate = formatPricingRate(rule.completion_micros, rule.currency, microUnits);
      const cacheReadRate = formatPricingRate(rule.cache_read_micros, rule.currency, microUnits);
      const cacheCreateRate = formatPricingRate(rule.cache_create_micros, rule.currency, microUnits);

      const effectiveText = rule.effective_from ? formatLogTimestamp(rule.effective_from) : "立即生效";
      const versionTitle = `规则版本 #${rule.id} · 创建于 ${rule.created_at ? formatLogTimestamp(rule.created_at) : "-"}`;

      return `
        <tr data-pricing-id="${rule.id}">
          <td>
            <div class="pricing-model-cell">
              <span class="pricing-model-code" title="${escapeHtml(rule.model_pattern)}">${escapeHtml(rule.model_pattern)}</span>
              ${wildcardBadge}
            </div>
          </td>
          <td>${currencyBadge}</td>
          <td><span class="pricing-rate-val">${escapeHtml(promptRate)}</span></td>
          <td><span class="pricing-rate-val">${escapeHtml(completionRate)}</span></td>
          <td><span class="pricing-rate-val">${escapeHtml(cacheReadRate)}</span></td>
          <td><span class="pricing-rate-val">${escapeHtml(cacheCreateRate)}</span></td>
          <td><span class="pricing-effective-time" title="${escapeHtml(versionTitle)}">${escapeHtml(effectiveText)}</span></td>
          <td class="col-actions">
            <button type="button" class="danger small" data-pricing-action="delete" data-pricing-id="${rule.id}">删除</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

/**
 * 打开新增定价规则弹窗。
 */
function openPricingRuleDialog() {
  if (!pricingRuleDialog) return;

  if (pricingRuleIdInput) pricingRuleIdInput.value = "";
  if (pricingModelPatternInput) pricingModelPatternInput.value = "";
  if (pricingCurrencySelect) pricingCurrencySelect.value = "USD";
  if (pricingEffectiveFromInput) pricingEffectiveFromInput.value = "";
  if (pricingPromptInput) pricingPromptInput.value = "";
  if (pricingCompletionInput) pricingCompletionInput.value = "";
  if (pricingCacheReadInput) pricingCacheReadInput.value = "0";
  if (pricingCacheCreateInput) pricingCacheCreateInput.value = "0";

  if (pricingRuleStatus) {
    pricingRuleStatus.textContent = "";
    pricingRuleStatus.className = "settings-inline-status";
  }

  if (typeof pricingRuleDialog.showModal === "function") {
    pricingRuleDialog.showModal();
  } else {
    pricingRuleDialog.setAttribute("open", "");
  }

  pricingModelPatternInput?.focus();
}

/**
 * 关闭新增定价规则弹窗。
 */
function closePricingRuleDialog() {
  if (!pricingRuleDialog) return;
  clearDialogMaximized(pricingRuleDialog);
  if (typeof pricingRuleDialog.close === "function") {
    pricingRuleDialog.close();
  } else {
    pricingRuleDialog.removeAttribute("open");
  }
}

/**
 * 提交新增定价规则表单。
 */
async function handlePricingRuleSubmit(event) {
  event.preventDefault();

  const pattern = (pricingModelPatternInput?.value || "").trim();
  if (!pattern) {
    if (pricingRuleStatus) {
      pricingRuleStatus.textContent = "模型匹配模式不能为空。";
      pricingRuleStatus.className = "settings-inline-status error";
    }
    pricingModelPatternInput?.focus();
    return;
  }

  if (pattern.length > 200) {
    if (pricingRuleStatus) {
      pricingRuleStatus.textContent = "模型匹配模式长度不能超过 200 字符。";
      pricingRuleStatus.className = "settings-inline-status error";
    }
    pricingModelPatternInput?.focus();
    return;
  }

  if (/[\x00-\x1f\x7f]/.test(pattern)) {
    if (pricingRuleStatus) {
      pricingRuleStatus.textContent = "模型匹配模式不能包含控制字符。";
      pricingRuleStatus.className = "settings-inline-status error";
    }
    pricingModelPatternInput?.focus();
    return;
  }

  const withoutTrailingStars = pattern.replace(/\*+$/, "");
  if (withoutTrailingStars.includes("*")) {
    if (pricingRuleStatus) {
      pricingRuleStatus.textContent = "通配符仅支持作为尾部后缀（如 claude-3-*），不支持内部通配。";
      pricingRuleStatus.className = "settings-inline-status error";
    }
    pricingModelPatternInput?.focus();
    return;
  }

  const microUnits = pricingTableInfo?.micro_units_per_unit || 1_000_000;
  const promptMicros = unitPriceToMicros(pricingPromptInput?.value, microUnits);
  const completionMicros = unitPriceToMicros(pricingCompletionInput?.value, microUnits);
  const cacheReadMicros = unitPriceToMicros(pricingCacheReadInput?.value, microUnits);
  const cacheCreateMicros = unitPriceToMicros(pricingCacheCreateInput?.value, microUnits);

  const effRaw = (pricingEffectiveFromInput?.value || "").trim();
  let effectiveFrom = undefined;
  if (effRaw) {
    effectiveFrom = effRaw;
  }

  const payload = {
    model_pattern: pattern,
    currency: pricingCurrencySelect?.value || "USD",
    prompt_micros: promptMicros,
    completion_micros: completionMicros,
    cache_read_micros: cacheReadMicros,
    cache_create_micros: cacheCreateMicros,
    effective_from: effectiveFrom,
  };

  try {
    const res = await api("/api/admin/pricing", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    closePricingRuleDialog();
    await loadPricingRules();
    setStatus(`已添加模型「${res.model_pattern}」的定价规则（版本 #${res.id}）。`, "ok");
  } catch (error) {
    if (pricingRuleStatus) {
      pricingRuleStatus.textContent = `保存失败：${error.message}`;
      pricingRuleStatus.className = "settings-inline-status error";
    }
  }
}

/**
 * 处理价格表格内部的点击事件（删除、空状态重试等）。
 */
async function handlePricingTableAction(event) {
  const emptyAction = event.target.closest("[data-empty-action]");
  if (emptyAction) {
    const action = emptyAction.dataset.emptyAction;
    if (action === "new-pricing-rule") {
      openPricingRuleDialog();
    } else if (action === "reload-pricing") {
      await loadPricingRules();
    }
    return;
  }

  const deleteBtn = event.target.closest("[data-pricing-action='delete']");
  if (!deleteBtn) return;

  const id = Number(deleteBtn.dataset.pricingId);
  if (!id) return;

  const rule = pricingRules.find((r) => r.id === id);
  const patternName = rule ? rule.model_pattern : `#${id}`;
  const effTime = rule?.effective_from ? formatLogTimestamp(rule.effective_from) : "当前";

  const accepted = await requestConfirm({
    title: "删除模型定价规则",
    message: `确认要删除模型「${patternName}」（生效时间：${effTime}）的定价版本 #${id} 吗？`
      + `\n\n删除后不会修改已记录的历史请求账单，但后续匹配该规则的请求将不再按此版本计算。`,
    confirmLabel: "删除规则",
    cancelLabel: "取消",
  });

  if (!accepted) return;

  try {
    await api(`/api/admin/pricing/${id}`, {
      method: "DELETE",
    });
    await loadPricingRules();
    setStatus(`定价规则 #${id} 已删除。`, "ok");
  } catch (error) {
    setStatus(`删除定价规则失败：${error.message}`, "error");
  }
}

// 绑定事件
newPricingRuleBtn?.addEventListener("click", openPricingRuleDialog);
pricingRuleDialogClose?.addEventListener("click", closePricingRuleDialog);
pricingRuleCancel?.addEventListener("click", closePricingRuleDialog);
pricingRuleForm?.addEventListener("submit", handlePricingRuleSubmit);
pricingRuleRows?.addEventListener("click", handlePricingTableAction);
dismissOnBackdropClick(pricingRuleDialog, closePricingRuleDialog);
