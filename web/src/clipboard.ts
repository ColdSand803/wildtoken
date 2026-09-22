/**
 * 复制文本。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS 或 localhost）里存在，走 http 的
 * 内网地址访问控制台时它直接是 undefined，或者调用就被拒。所以不能只用它。
 *
 * 退路是老掉牙的 `document.execCommand("copy")`：它没有安全上下文限制，但必须
 * 跑在用户手势的同步调用栈里。所以先同步判断能不能用新接口，不能用就立刻走老
 * 路，而不是 await 失败之后再回头——那时手势已经过期了。
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒时还能再试一次老接口，但成功率取决于浏览器怎么算手势。
    }
  }
  if (!legacyCopy(text)) throw new Error("浏览器拒绝了剪贴板访问");
}

/** 选中一个临时 textarea 再执行复制命令。返回是否成功。 */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;

  // 不能用 display:none 或 visibility:hidden——那样选不中，复制就是空的。
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";

  /* 对话框是 <dialog>，顶层元素之外的节点选不中，所以挂到当前打开的对话框里，
     没有对话框时才挂 body。 */
  const host = document.querySelector("dialog[open]") ?? document.body;
  host.append(area);

  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
