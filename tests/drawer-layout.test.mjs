import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("三种导入导出窗口共用完整抽屉骨架", () => {
  const source = read("web/src/components/ImportExportDialogs.tsx");
  assert.equal([...source.matchAll(/<TransferDialog\b/g)].length, 3);
  assert.equal([...source.matchAll(/<dialog\b/g)].length, 1);
  for (const name of ["quick-import-panel", "upstream-modal-head", "upstream-dialog-body", "modal-footer", "icon-close"]) {
    assert.ok(source.includes(name), `共用骨架缺少 ${name}`);
  }
});

test("内容型抽屉将正文放进独立滚动区", () => {
  for (const file of [
    "components/ImportExportDialogs.tsx",
    "components/UpstreamDialog.tsx",
    "components/TokenDialog.tsx",
    "components/ModelDialog.tsx",
    "components/ModelTestDialog.tsx",
    "components/LogDetailDialog.tsx",
    "components/BalanceDialog.tsx",
    "pages/GroupsPage.tsx",
  ]) {
    const source = read(`web/src/${file}`);
    assert.match(source, /className="[^"]*\bupstream-dialog-body\b/, `${file} 缺少滚动正文`);
    assert.match(source, /className="[^"]*\bupstream-modal-head\b/, `${file} 缺少固定标题栏`);
  }
});

test("抽屉高度跟随动态视口，外层不滚动", () => {
  const css = read("static/css/drawer.css");
  const shell = css.match(/:root dialog\.dialog--drawer\s*\{([^}]+)\}/)?.[1];
  assert.ok(shell, "抽屉几何须压过后加载的主题规则");
  assert.match(shell, /height:\s*100dvh/);
  assert.match(shell, /overflow:\s*hidden/);
  assert.match(css, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /align-content:\s*start/);
  assert.match(css, /safe-area-inset-bottom/);
});

test("短分组表单使用紧凑抽屉，确认和登录仍居中", () => {
  assert.match(read("web/src/pages/GroupsPage.tsx"), /className="upstream-dialog group-dialog dialog--drawer"/);
  assert.match(read("static/css/drawer.css"), /\.group-dialog\s*\{[^}]*--drawer-width:\s*560px/s);
  for (const file of ["AdminTokenDialog.tsx", "CommandPalette.tsx", "feedback.tsx"]) {
    assert.doesNotMatch(read(`web/src/components/${file}`), /className="[^"]*dialog--drawer/, `${file} 不应改成抽屉`);
  }
});
