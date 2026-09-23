let activeSelect: HTMLSelectElement | null = null;
let selectActiveIndex = -1;
let selectOptionButtons: HTMLButtonElement[] = [];
let selectPanelElement: HTMLElement | null = null;
let selectPanelHome: HTMLElement | null = null;

function getSelectPanel(): HTMLElement | null {
  if (!selectPanelElement && typeof document !== "undefined") {
    let panel = document.getElementById("select-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "select-panel";
      panel.className = "select-panel";
      panel.setAttribute("role", "listbox");
      panel.setAttribute("aria-label", "选项列表");
      panel.hidden = true;
      try {
        panel.setAttribute("popover", "manual");
      } catch {}
      document.body.appendChild(panel);
    }
    selectPanelElement = panel;
    selectPanelHome = panel.parentElement;
  }
  return selectPanelElement;
}

function isNativeSelect(element: unknown): element is HTMLSelectElement {
  if (!element || typeof element !== "object") return false;
  const isSelect =
    (typeof (globalThis as any).HTMLSelectElement !== "undefined" &&
      element instanceof (globalThis as any).HTMLSelectElement) ||
    (typeof window !== "undefined" &&
      (window as any).HTMLSelectElement &&
      element instanceof (window as any).HTMLSelectElement) ||
    (element as any).tagName === "SELECT";
  return Boolean(
    isSelect &&
      !(element as HTMLSelectElement).disabled &&
      !(element as HTMLSelectElement).multiple &&
      !(element as HTMLSelectElement).size,
  );
}

interface OptionEntry {
  option: HTMLOptionElement;
  index: number;
  value: string;
  label: string;
  disabled: boolean;
  selected: boolean;
}
function selectOptionEntries(select: HTMLSelectElement): OptionEntry[] {
  return Array.from(select.options || []).map((option, index) => ({
    option,
    index,
    value: option.value,
    label: option.label || option.textContent || "",
    disabled: option.disabled,
    selected: option.selected || select.selectedIndex === index,
  }));
}

function modalDialogForSelect(select: HTMLElement): HTMLDialogElement | null {
  const dialog = select.closest?.("dialog");
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return null;
  return dialog;
}

function popoverIsOpen(element: HTMLElement): boolean {
  try {
    return (
      typeof (element as any).showPopover === "function" &&
      element.matches?.(":popover-open")
    );
  } catch {
    return false;
  }
}

function showPopoverLayer(element: HTMLElement) {
  element.hidden = false;
  if (typeof (element as any).showPopover !== "function") return;
  try {
    if (!popoverIsOpen(element)) {
      (element as any).showPopover();
    }
  } catch {}
}

function hidePopoverLayer(element: HTMLElement) {
  if (popoverIsOpen(element)) {
    try {
      (element as any).hidePopover();
    } catch {}
  }
  element.hidden = true;
}

function placeSelectPanelFor(select: HTMLSelectElement) {
  const panel = getSelectPanel();
  if (!panel) return;
  const host = modalDialogForSelect(select) || selectPanelHome || document.body;
  if (!host || panel.parentElement === host) return;
  if (popoverIsOpen(panel)) {
    hidePopoverLayer(panel);
  }
  host.appendChild(panel);
}

function restoreSelectPanelHost() {
  const panel = getSelectPanel();
  if (!panel || !selectPanelHome || panel.parentElement === selectPanelHome) return;
  if (popoverIsOpen(panel)) {
    hidePopoverLayer(panel);
  }
  selectPanelHome.appendChild(panel);
}

export function closeCustomSelect(restoreFocus = false) {
  const select = activeSelect;
  activeSelect = null;
  selectActiveIndex = -1;
  selectOptionButtons = [];
  const panel = getSelectPanel();
  if (panel && !panel.hidden) {
    panel.innerHTML = "";
    panel.style.visibility = "";
    panel.style.width = "";
    panel.style.left = "";
    panel.style.top = "";
    panel.removeAttribute("aria-activedescendant");
    hidePopoverLayer(panel);
  }
  restoreSelectPanelHost();
  if (restoreFocus && select?.isConnected) {
    select.focus();
  }
}

function setSelectActiveIndex(nextIndex: number) {
  const panel = getSelectPanel();
  if (!selectOptionButtons.length) {
    selectActiveIndex = -1;
    return;
  }
  const clamped = Math.max(0, Math.min(selectOptionButtons.length - 1, nextIndex));
  selectActiveIndex = clamped;
  selectOptionButtons.forEach((button, index) => {
    const active = index === clamped;
    button.classList.toggle("is-active", active);
    button.tabIndex = active ? 0 : -1;
    if (active) {
      panel?.setAttribute("aria-activedescendant", button.id);
      button.scrollIntoView({ block: "nearest" });
    }
  });
}

function chooseCustomSelectOption(index: number) {
  if (!activeSelect || !Number.isInteger(index)) return;
  const option = activeSelect.options[index];
  if (!option || option.disabled) return;

  if (activeSelect.selectedIndex !== index || activeSelect.value !== option.value) {
    activeSelect.selectedIndex = index;
    // Dispatch value update using prototype descriptor so React controlled input tracks it
    try {
      const proto =
        ((globalThis as any).HTMLSelectElement || (globalThis as any).window?.HTMLSelectElement)
          ?.prototype;
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor?.set) {
        descriptor.set.call(activeSelect, option.value);
      } else {
        activeSelect.value = option.value;
      }
    } catch {
      activeSelect.value = option.value;
    }
    activeSelect.dispatchEvent(new Event("input", { bubbles: true }));
    activeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeCustomSelect(true);
}

function positionCustomSelect() {
  const panel = getSelectPanel();
  if (!activeSelect || !panel || panel.hidden) return;
  const triggerRect = activeSelect.getBoundingClientRect();
  const menuRect = panel.getBoundingClientRect();
  const gap = 4;
  const viewportGap = 8;
  let left = triggerRect.left;
  let top = triggerRect.bottom + gap;
  const width = Math.max(triggerRect.width, menuRect.width, 120);

  if (left + width > window.innerWidth - viewportGap) {
    left = Math.max(viewportGap, window.innerWidth - width - viewportGap);
  }
  left = Math.max(viewportGap, left);

  if (top + menuRect.height > window.innerHeight - viewportGap) {
    const alternativeTop = triggerRect.top - menuRect.height - gap;
    if (alternativeTop >= viewportGap) {
      top = alternativeTop;
    }
  }
  if (top < viewportGap) {
    top = viewportGap;
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.width = `${Math.round(width)}px`;
}

export function openCustomSelect(select: HTMLSelectElement) {
  const panel = getSelectPanel();
  if (!panel || !isNativeSelect(select)) return;
  if (activeSelect === select && !panel.hidden) {
    closeCustomSelect(true);
    return;
  }

  closeCustomSelect();
  activeSelect = select;
  select.focus({ preventScroll: true });
  const entries = selectOptionEntries(select);
  panel.innerHTML = "";
  selectOptionButtons = [];

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "select-panel-empty";
    empty.textContent = "无可选项";
    panel.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `select-option-${entry.index}`;
      button.setAttribute("role", "option");
      button.dataset.optionIndex = String(entry.index);
      button.textContent = entry.label;
      button.disabled = entry.disabled;
      button.classList.toggle("is-selected", entry.selected);
      button.setAttribute("aria-selected", String(entry.selected));
      button.tabIndex = -1;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseCustomSelectOption(entry.index);
      });
      fragment.appendChild(button);
      if (!entry.disabled) selectOptionButtons.push(button);
    });
    panel.appendChild(fragment);
  }

  panel.style.visibility = "hidden";
  placeSelectPanelFor(select);
  showPopoverLayer(panel);
  window.requestAnimationFrame(() => {
    if (activeSelect !== select) return;
    positionCustomSelect();
    panel.style.visibility = "visible";
    const selectedPos = selectOptionButtons.findIndex((button) =>
      button.classList.contains("is-selected"),
    );
    setSelectActiveIndex(selectedPos >= 0 ? selectedPos : 0);
  });
}

function handleSelectKeydown(event: KeyboardEvent): boolean {
  const panel = getSelectPanel();
  if (!activeSelect || panel?.hidden) return false;
  const key = event.key;
  if (key === "Escape") {
    event.preventDefault();
    closeCustomSelect(true);
    return true;
  }
  if (key === "ArrowDown") {
    event.preventDefault();
    setSelectActiveIndex(selectActiveIndex < 0 ? 0 : selectActiveIndex + 1);
    return true;
  }
  if (key === "ArrowUp") {
    event.preventDefault();
    setSelectActiveIndex(
      selectActiveIndex < 0
        ? selectOptionButtons.length - 1
        : selectActiveIndex - 1,
    );
    return true;
  }
  if (key === "Home") {
    event.preventDefault();
    setSelectActiveIndex(0);
    return true;
  }
  if (key === "End") {
    event.preventDefault();
    setSelectActiveIndex(selectOptionButtons.length - 1);
    return true;
  }
  if (key === "Enter" || key === " ") {
    event.preventDefault();
    if (selectActiveIndex >= 0) {
      const button = selectOptionButtons[selectActiveIndex];
      const index = Number(button?.dataset.optionIndex);
      chooseCustomSelectOption(index);
    }
    return true;
  }
  if (key === "Tab") {
    closeCustomSelect();
    return false;
  }
  return false;
}

let initialized = false;

export function initCustomSelect(): () => void {
  if (typeof document === "undefined" || initialized) return () => {};
  initialized = true;

  const onMouseDown = (event: MouseEvent) => {
    const select = (event.target as HTMLElement | null)?.closest?.("select");
    if (isNativeSelect(select)) {
      // Block native select dropdown
      event.preventDefault();
      openCustomSelect(select);
      return;
    }
    const panel = getSelectPanel();
    if (activeSelect && panel && !panel.hidden) {
      const target = event.target as Node;
      if (!panel.contains(target) && !activeSelect.contains(target)) {
        closeCustomSelect();
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (handleSelectKeydown(event)) return;
    const select = event.target as HTMLElement | null;
    const panel = getSelectPanel();
    if (!isNativeSelect(select) || !panel?.hidden) return;
    if (
      event.key === " " ||
      event.key === "Enter" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowUp"
    ) {
      event.preventDefault();
      openCustomSelect(select);
    }
  };

  const onWindowResize = () => closeCustomSelect();
  const onWindowScroll = (event: Event) => {
    const panel = getSelectPanel();
    if (panel?.contains(event.target as Node)) return;
    closeCustomSelect();
  };

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("scroll", onWindowScroll, true);

  return () => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("scroll", onWindowScroll, true);
    initialized = false;
  };
}
