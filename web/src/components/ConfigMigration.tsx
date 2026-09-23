import { useState } from "react";
import { api } from "../api";
import { downloadBlob, parseConfigArchive } from "../archiveTools";
import type { ConfigArchive } from "../archiveTools";
import { useConfirm } from "./feedback";

const SCOPES: Record<string, string> = { groups: "分组", channels: "渠道", tokens: "令牌策略", settings: "系统设置" };
const ACTIONS: Record<string, string> = { create: "新建", update: "覆盖", skip: "跳过", fail: "拒绝" };
export interface ConfigReport { dry_run: boolean; applied: boolean; app_version: string; exported_at: string; created: number; updated: number; skipped: number; failed: number; errors?: string[]; items: Array<{ scope: string; name: string; action: string; detail?: string }> }
export function ConfigMigration({ locked, onChanged }: { locked: boolean; onChanged: () => Promise<void> }) {
  const [scopes, setScopes] = useState(Object.keys(SCOPES));
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState("skip");
  const [archive, setArchive] = useState<ConfigArchive | null>(null);
  const [report, setReport] = useState<ConfigReport | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const confirm = useConfirm();
  const invalidate = () => { setVerified(false); setArchive(null); setReport(null); setMessage(""); };
  async function exportConfig() {
    if (busy || !scopes.length) return;
    if (includeSecrets && exportPassword.trim().length < 8) { setMessage("包含密钥时必须设置至少 8 位归档密码。"); return; }
    setBusy(true); setMessage("正在生成配置归档…");
    try {
      const data = await api<ConfigArchive>("/api/admin/config/export", { method: "POST", body: JSON.stringify({ scopes, include_secrets: includeSecrets, password: exportPassword }) });
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `wildtoken-config-${Date.now()}-${data.encryption ? "encrypted" : "plain"}.json`);
      setExportPassword(""); setMessage("配置归档已下载。");
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function importConfig(dryRun: boolean) {
    if (busy || locked || !file || (!dryRun && (!verified || !archive))) return;
    if (!dryRun && !await confirm({ title: "导入配置？", message: "将按预览结果更新配置。此操作不会导入日志或替换数据库；同名条目按所选冲突策略处理。", confirmLabel: "执行导入", danger: conflict === "overwrite" })) return;
    setBusy(true); setMessage(dryRun ? "正在校验，暂不写入…" : "正在导入…");
    try {
      const input = dryRun ? parseConfigArchive(await file.text()) : archive;
      const result = await api<ConfigReport>("/api/admin/config/import", { method: "POST", body: JSON.stringify({ archive: input, password, on_conflict: conflict, dry_run: dryRun }) });
      setReport(result); setArchive(input);
      const valid = result.failed === 0 && !result.errors?.length;
      setVerified(dryRun && valid);
      setMessage(dryRun ? valid ? "校验通过，未写入。确认预览后再导入。" : "校验未通过，未写入。" : result.applied ? "配置已导入。" : "导入未执行，请检查报告。");
      if (!dryRun && result.applied) { setPassword(""); setArchive(null); await onChanged(); }
    } catch (err) { setVerified(false); setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <section className="settings-card config-migration-card">
    <div className="settings-card-head"><div><h3>配置迁移</h3><p>按名称迁移分组、渠道、令牌策略与系统设置；不含日志与管理员凭证。</p></div></div>
    <fieldset className="settings-fields-grid" disabled={busy}>
      <legend>导出配置</legend><div className="config-scope-list">{Object.entries(SCOPES).map(([key, label]) => <label key={key}><input type="checkbox" checked={scopes.includes(key)} onChange={(e) => setScopes((current) => e.target.checked ? [...current, key] : current.filter((item) => item !== key))} />{label}</label>)}</div>
      <label className="field"><span>包含密钥及令牌明文</span><input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} /></label>
      <label className="field"><span>归档密码</span><input type="password" autoComplete="new-password" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} placeholder="包含密钥时至少 8 位" /></label>
      <button type="button" className="secondary" disabled={!scopes.length} onClick={() => void exportConfig()}>导出配置归档</button>
    </fieldset>
    <fieldset className="settings-fields-grid" disabled={busy || locked}>
      <legend>导入配置</legend>
      <label className="field"><span>配置归档文件</span><input type="file" accept=".json,application/json" onChange={(e) => { invalidate(); setFile(e.target.files?.[0] ?? null); }} /></label>
      <label className="field"><span>解密密码</span><input type="password" autoComplete="off" value={password} onChange={(e) => { invalidate(); setPassword(e.target.value); }} /></label>
      <label className="field"><span>同名冲突</span><select value={conflict} onChange={(e) => { invalidate(); setConflict(e.target.value); }}><option value="skip">跳过</option><option value="overwrite">覆盖</option><option value="fail">拒绝整个导入</option></select></label>
      <div className="settings-action-row"><button type="button" className="secondary" disabled={!file} onClick={() => void importConfig(true)}>预览配置导入</button><button type="button" className="primary" disabled={!verified} onClick={() => void importConfig(false)}>执行配置导入</button></div>
    </fieldset>
    {locked && <p className="field-hint">恢复状态尚未确认、正在处理或已有恢复待重启，暂不可导入配置。</p>}
    <p role="status">{message}</p>
    {report && <div className="config-import-report"><p>{report.dry_run ? "预览（未写入）" : "导入结果"} · 来源 {report.app_version} · {report.exported_at}</p><p>新建 {report.created} · 覆盖 {report.updated} · 跳过 {report.skipped} · 拒绝 {report.failed}</p>{report.errors?.map((error, index) => <p role="alert" key={index}>{error}</p>)}<div className="table-wrap"><table className="admin-table"><thead><tr><th>范围</th><th>名称</th><th>处理</th><th>说明</th></tr></thead><tbody>{report.items.map((item, index) => <tr key={index}><td>{SCOPES[item.scope] ?? item.scope}</td><td>{item.name}</td><td>{ACTIONS[item.action] ?? item.action}</td><td>{item.detail}</td></tr>)}</tbody></table></div></div>}
  </section>;
}
