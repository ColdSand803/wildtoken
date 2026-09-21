import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  title: string;
  subtitle: string;
  /** 显示用的快捷键。只写真的绑了的——标一个按下去没反应的键比不标更糟。 */
  keys?: string;
  run: () => void;
}

/**
 * 命令面板。Ctrl/Cmd+K 唤起。
 *
 * 唤起与关闭的键盘监听在这里，而不是散在各页：面板是全局的，监听也应该
 * 只有一处。
 */
export function CommandPalette({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.title} ${command.subtitle} ${command.id}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (event.key === "Escape" && dialogRef.current?.open) {
        // 面板开着时 Esc 归它，别让底下的对话框也跟着关。
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  /* 筛完之后高亮可能落在列表外面。夹回最后一项，而不是让回车什么都不做。 */
  const index = visible.length === 0 ? 0 : Math.min(active, visible.length - 1);

  function run(command: Command) {
    setOpen(false);
    command.run();
  }

  return (
    <dialog className="command-palette-dialog" ref={dialogRef} onCancel={() => setOpen(false)}>
      <div className="command-palette-panel">
        <div className="command-palette-head">
          <input
            ref={inputRef}
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="输入命令或跳转…"
            aria-label="命令面板"
            aria-autocomplete="list"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (visible.length > 0) setActive((current) => (current + 1) % visible.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (visible.length > 0) {
                  setActive((current) => (current - 1 + visible.length) % visible.length);
                }
              } else if (event.key === "Enter") {
                event.preventDefault();
                const command = visible[index];
                if (command) run(command);
              }
            }}
          />
          <kbd className="command-palette-hint">Esc</kbd>
        </div>
        <div className="command-palette-list" role="listbox" aria-label="命令列表">
          {visible.length === 0 ? (
            <div className="command-palette-empty">无匹配命令</div>
          ) : (
            visible.map((command, position) => (
              <button
                key={command.id}
                type="button"
                className={
                  position === index ? "command-palette-item is-active" : "command-palette-item"
                }
                role="option"
                data-command-id={command.id}
                aria-selected={position === index}
                onClick={() => run(command)}
              >
                <span className="command-palette-item-title">{command.title}</span>
                {/* 第二格固定占位：没快捷键也要给一个空 span，否则第三格会向前塌。 */}
                {command.keys ? (
                  <span className="command-palette-item-keys">{command.keys}</span>
                ) : (
                  <span />
                )}
                <span className="command-palette-item-subtitle">{command.subtitle}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
}
