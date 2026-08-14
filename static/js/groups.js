/* 分组把令牌能访问的渠道范围隔离开：一个令牌属于一个分组，一个渠道可以同时
   服务多个分组。这里只管分组自身的增删改查，以及把可选分组喂给渠道表单和令牌
   表单——真正的路由约束在服务端，前端拿到的列表只是给操作者看的。 */

const groupTableBody = document.querySelector("#group-rows");
const groupDialog = document.querySelector("#group-dialog");
const groupForm = document.querySelector("#group-form");
const groupDialogTitle = document.querySelector("#group-dialog-title");
const groupIdInput = document.querySelector("#group-id");
const groupNameInput = document.querySelector("#group-name");
const groupDescriptionInput = document.querySelector("#group-description");
const groupCreateButton = document.querySelector("#group-create");
const groupCancelButton = document.querySelector("#group-cancel");
const groupDialogCloseButton = document.querySelector("#group-dialog-close");

const tokenGroupSelect = document.querySelector("#token-group");
const upstreamGroupList = document.querySelector("#upstream-groups");

/** 最近一次拿到的分组列表，供渠道/令牌表单直接复用，避免每次开弹窗都请求。 */
let groupCache = [];

const DEFAULT_GROUP_ID = 1;

function groupById(id) {
  return groupCache.find((group) => group.id === Number(id)) || null;
}

async function loadGroups({ render = true } = {}) {
  try {
    groupCache = await api("/api/admin/groups");
  } catch (error) {
    if (render) {
      setStatus(`加载分组失败：${error.message}`, "error");
    }
    return groupCache;
  }
  if (render) {
    renderGroups();
  }
  return groupCache;
}

function renderGroups() {
  if (!groupTableBody) {
    return;
  }
  if (groupCache.length === 0) {
    groupTableBody.innerHTML = `<tr><td colspan="5" class="empty">暂无分组</td></tr>`;
    return;
  }

  groupTableBody.innerHTML = groupCache
    .map((group) => {
      /* default 分组是所有令牌和渠道的兜底，删掉它会让引用它的令牌无处可去，
         所以这里连按钮都不给。 */
      const actions = group.is_default
        ? `<button type="button" class="secondary ghost" data-group-edit="${group.id}">编辑</button>`
        : `<button type="button" class="secondary ghost" data-group-edit="${group.id}">编辑</button>
           <button type="button" class="secondary ghost danger" data-group-delete="${group.id}">删除</button>`;
      /* 「默认」是名称的附注，不是状态，所以用中性徽章：比名称小一号、灰调填充，
         扫一眼能认出兜底分组，又不会盖过名称本身。 */
      const badge = group.is_default ? `<span class="badge neutral">默认</span>` : "";
      const name = escapeHtml(group.name);
      return `<tr>
        <td><div class="name-inline"><strong title="${name}">${name}</strong>${badge}</div></td>
        ${renderDescriptionCell(group.description)}
        <td class="numeric">${group.upstream_count}</td>
        <td class="numeric">${group.token_count}</td>
        <td class="actions-col">${actions}</td>
      </tr>`;
    })
    .join("");
}

function openGroupDialog(group) {
  const editing = Boolean(group);
  groupDialogTitle.textContent = editing ? "编辑分组" : "新增分组";
  groupIdInput.value = editing ? String(group.id) : "";
  groupNameInput.value = editing ? group.name : "";
  groupDescriptionInput.value = editing ? group.description || "" : "";
  // default 分组的名字被文档和运维习惯引用，改名会让人对不上号。
  groupNameInput.disabled = editing && group.is_default;
  groupDialog.showModal();
  groupNameInput.focus();
}

async function submitGroup(event) {
  event.preventDefault();
  const id = groupIdInput.value.trim();
  const payload = {
    name: groupNameInput.value.trim(),
    description: groupDescriptionInput.value.trim(),
  };
  if (!payload.name) {
    setStatus("分组名称不能为空", "error");
    return;
  }

  try {
    if (id) {
      await api(`/api/admin/groups/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await api("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    groupDialog.close();
    await loadGroups();
    setStatus(id ? "分组已更新" : "分组已创建", "ok");
  } catch (error) {
    setStatus(`保存分组失败：${error.message}`, "error");
  }
}

async function deleteGroup(id) {
  const group = groupById(id);
  if (!group) {
    return;
  }
  /* 删除会把该分组的令牌移回 default，渠道则只是退出这个分组。说清楚再问，
     免得操作者以为令牌会一起没。 */
  const warning =
    group.token_count > 0
      ? `\n该分组下有 ${group.token_count} 个令牌，删除后会移入 default 分组。`
      : "";
  if (!window.confirm(`确认删除分组「${group.name}」？${warning}`)) {
    return;
  }

  try {
    await api(`/api/admin/groups/${id}`, { method: "DELETE" });
    await loadGroups();
    setStatus("分组已删除", "ok");
  } catch (error) {
    setStatus(`删除分组失败：${error.message}`, "error");
  }
}

/** 把分组列表填进令牌表单的下拉框，selectedId 缺省时选中 default。 */
async function fillTokenGroupOptions(selectedId) {
  if (!tokenGroupSelect) {
    return;
  }
  const groups = groupCache.length > 0 ? groupCache : await loadGroups({ render: false });
  const target = Number(selectedId) || DEFAULT_GROUP_ID;
  tokenGroupSelect.innerHTML = groups
    .map(
      (group) =>
        `<option value="${group.id}"${group.id === target ? " selected" : ""}>${escapeHtml(
          group.name,
        )}</option>`,
    )
    .join("");
}

/** 把分组列表填进渠道表单的多选框，selectedIds 缺省时勾上 default。 */
async function fillUpstreamGroupOptions(selectedIds) {
  if (!upstreamGroupList) {
    return;
  }
  const groups = groupCache.length > 0 ? groupCache : await loadGroups({ render: false });
  const selected = new Set(
    Array.isArray(selectedIds) && selectedIds.length > 0
      ? selectedIds.map(Number)
      : [DEFAULT_GROUP_ID],
  );
  upstreamGroupList.innerHTML = groups
    .map(
      (group) =>
        `<label class="group-checkbox"><input type="checkbox" value="${group.id}"${
          selected.has(group.id) ? " checked" : ""
        } /> <span>${escapeHtml(group.name)}</span></label>`,
    )
    .join("");
}

/** 读回渠道表单里勾选的分组。空数组交给服务端兜底成 default。 */
function readUpstreamGroupSelection() {
  if (!upstreamGroupList) {
    return [];
  }
  return [...upstreamGroupList.querySelectorAll("input[type=checkbox]:checked")].map((input) =>
    Number(input.value),
  );
}

groupForm?.addEventListener("submit", submitGroup);
groupCreateButton?.addEventListener("click", () => openGroupDialog(null));
groupCancelButton?.addEventListener("click", () => groupDialog.close());
groupDialogCloseButton?.addEventListener("click", () => groupDialog.close());

groupTableBody?.addEventListener("click", (event) => {
  const editId = event.target.closest("[data-group-edit]")?.dataset.groupEdit;
  if (editId) {
    openGroupDialog(groupById(editId));
    return;
  }
  const deleteId = event.target.closest("[data-group-delete]")?.dataset.groupDelete;
  if (deleteId) {
    deleteGroup(deleteId);
  }
});
