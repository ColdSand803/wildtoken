import { useCallback, useEffect, useState } from "react";
import { api, rawApi } from "../api";
import { backupFileName, downloadBlob, parseBackup } from "../archiveTools";
import { ConfigMigration } from "./ConfigMigration";
import { useConfirm } from "./feedback";

interface BackupInfo { app_version: string; schema_version: number; schema_fingerprint: string; size_bytes: number; encrypted: boolean; compatible: boolean; incompatibility?: string }
interface RecoveryInfo { current: BackupInfo; pending_restore: { pending: boolean; staged_at?: string; size_bytes?: number } }
interface RestoreResult { dry_run: boolean; verified: boolean; backup: BackupInfo; current: BackupInfo; staged: boolean; requires_restart: boolean; rollback_path?: string; warnings: string[] }
export function DataManagement({ onChanged }: { onChanged: () => Promise<void> }) {
  const [info, setInfo] = useState<RecoveryInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [file, setRestoreFile] = useState<File | null>(null);
  const [fileEpoch, setFileEpoch] = useState(0);
  const [password, setPassword] = useState("");
  const [allowMismatch, setAllowMismatch] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [archive, setArchive] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const confirm = useConfirm();
  const reload = useCallback(async () => { const next = await api<RecoveryInfo>("/api/admin/disaster-recovery/info"); setInfo(next); }, []);
  useEffect(() => { void reload().catch(() => setMessage("数据库恢复状态暂不可用，请刷新后重试。")); }, [reload]);
  const pending = info?.pending_restore.pending ?? false;
  const locked = busy || pending || info === null;
  const invalidate = () => { setVerified(false); setArchive(null); setResult(null); setConfirmation(""); setMessage(""); };
  async function backup() {
    if (busy) return;
    if (backupPassword && backupPassword.trim().length < 8) { setMessage("备份密码至少 8 位，留空表示不加密。"); return; }
    setBusy(true); setMessage("正在生成一致性数据库快照…");
    try {
      const response = await rawApi("/api/admin/disaster-recovery/backup", { method: "POST", body: JSON.stringify({ password: backupPassword }) });
      downloadBlob(await response.blob(), backupFileName(response)); setBackupPassword(""); setMessage("数据库备份已下载，请安全保存。");
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function restore(dryRun: boolean) {
    if (locked || !file || (!dryRun && (!verified || !archive || confirmation.trim() !== "restore"))) return;
    setBusy(true); setMessage(dryRun ? "正在验证备份，不修改当前数据库…" : "正在暂存恢复…");
    try {
      const source = dryRun ? parseBackup(new Uint8Array(await file.arrayBuffer())).archive : archive;
      const next = await api<RestoreResult>("/api/admin/disaster-recovery/restore", { method: "POST", body: JSON.stringify({ archive: source, password, dry_run: dryRun, allow_schema_mismatch: allowMismatch, ...(!dryRun ? { confirm: "restore" } : {}) }) });
      setResult(next); setVerified(dryRun && next.verified); setArchive(dryRun && next.verified ? source : null);
      if (!dryRun && next.staged) {
        // Lock immediately, even if the subsequent info refresh fails.
        setInfo((current) => current ? { ...current, pending_restore: { pending: true } } : current);
        setPassword(""); setConfirmation(""); setRestoreFile(null); setFileEpoch((value) => value + 1);
        setMessage("恢复已暂存，需要手动重启服务后生效；重启会替换全部数据和管理员令牌。");
        await reload().catch(() => {});
      } else setMessage(next.verified ? "校验通过，未写入。输入 restore 后可暂存恢复。" : "校验未通过。请检查报告。");
    } catch (err) { setVerified(false); setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function cancelRestore() {
    if (busy || !pending || !await confirm({ title: "取消暂存恢复？", message: "当前运行数据库不受影响，服务器上的恢复前副本会保留。", confirmLabel: "取消恢复", danger: false })) return;
    setBusy(true);
    try { await api("/api/admin/disaster-recovery/restore", { method: "DELETE" }); invalidate(); await reload(); setMessage("暂存恢复已取消，当前数据库不变。"); }
    catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <>
    <ConfigMigration locked={locked} onChanged={onChanged} />
    <section className="settings-card disaster-recovery-card">
      <div className="settings-card-head"><div><h3>数据库备份与灾备恢复</h3><p>完整备份包含请求日志、所有密钥和管理员凭证，不等同于配置归档。</p></div><button type="button" className="secondary" disabled={busy} onClick={() => void reload().catch(() => { setInfo(null); setMessage("恢复状态刷新失败。"); })}>刷新恢复状态</button></div>
      {info && <dl className="backup-info-grid"><div><dt>当前版本</dt><dd>{info.current.app_version}</dd></div><div><dt>数据库大小</dt><dd>{(info.current.size_bytes / 1048576).toFixed(1)} MiB</dd></div><div><dt>结构指纹</dt><dd title={info.current.schema_fingerprint}>{info.current.schema_fingerprint.slice(0, 16)}…</dd></div></dl>}
      {pending && <div className="restore-pending" role="status"><strong>已有恢复暂存，等待重启</strong><p>{info?.pending_restore.staged_at}。重启后全部数据与管理员令牌将来自备份。</p><button type="button" className="danger" disabled={busy} onClick={() => void cancelRestore()}>取消暂存恢复</button></div>}
      <fieldset className="settings-fields-grid" disabled={busy}><legend>创建备份</legend><label className="field"><span>备份密码（建议设置）</span><input type="password" autoComplete="new-password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="至少 8 位；留空不加密" /></label><p className="field-hint">未加密文件包含全部凭证，切勿公开分享。</p><button type="button" className="secondary" onClick={() => void backup()}>下载数据库备份</button></fieldset>
      <fieldset className="settings-fields-grid" disabled={locked}><legend>恢复备份</legend>
        <label className="field"><span>数据库备份文件</span><input key={fileEpoch} type="file" accept=".wtbak,application/octet-stream" onChange={(event) => { invalidate(); setRestoreFile(event.target.files?.[0] ?? null); }} /></label>
        <label className="field"><span>备份解密密码</span><input type="password" autoComplete="off" value={password} onChange={(event) => { invalidate(); setPassword(event.target.value); }} /></label>
        <label className="field span-2"><span><input type="checkbox" checked={allowMismatch} onChange={(event) => { invalidate(); setAllowMismatch(event.target.checked); }} />允许结构指纹不一致（仅灾备排障时使用，可能无法启动）</span></label>
        <button type="button" className="secondary" disabled={!file} onClick={() => void restore(true)}>验证数据库备份</button>
        <label className="field"><span>覆盖确认：输入 restore</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <button type="button" className="danger" disabled={!verified || confirmation.trim() !== "restore"} onClick={() => void restore(false)}>暂存恢复（重启后覆盖全部数据）</button>
      </fieldset>
      <p role="status">{message}</p>
      {result && <div className="restore-report"><h4>{result.dry_run ? "校验结果（未写入）" : "恢复结果"}</h4><p>备份版本 {result.backup.app_version} · {(result.backup.size_bytes / 1048576).toFixed(1)} MiB · {result.backup.encrypted ? "加密" : "未加密"} · {result.backup.compatible ? "结构兼容" : result.backup.incompatibility ?? "结构不匹配"}</p>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{result.rollback_path && <p>恢复前副本：<code>{result.rollback_path}</code></p>}</div>}
    </section>
  </>;
}
