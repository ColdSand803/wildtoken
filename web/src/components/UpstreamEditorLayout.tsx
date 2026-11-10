import { UPSTREAM_FIELD_TABS } from "../upstreamEditing";
import type { UpstreamTab } from "../upstreamEditing";
import type { UpstreamEditorController, UpstreamEditorProps } from "../useUpstreamEditor";
import { UpstreamConnectionPanel, UpstreamModelsPanel, UpstreamTrafficPanel } from "./UpstreamPanels";
import { UpstreamModelsWorkspace } from "./UpstreamModelsWorkspace";

const tabs: Array<{ id: UpstreamTab; label: string }> = [
  { id: "connection", label: "连接与认证" }, { id: "models", label: "模型规则" }, { id: "traffic", label: "流量策略" },
];

export function UpstreamEditorLayout({ editor, upstream, groups, busy }: UpstreamEditorProps & { editor: UpstreamEditorController }) {
  const { form, errors, changes } = editor;
  const title = upstream && upstream.id > 0 ? `编辑渠道 #${upstream.id}` : "新增渠道";
  const panelProps = { form, errors, busy, set: editor.set };
  return <dialog className={["upstream-dialog dialog--drawer upstream-editor", editor.workspace && "ue-workspace-open"].filter(Boolean).join(" ")} ref={editor.dialogRef}
    aria-labelledby="ue-title" onCancel={(event) => { event.preventDefault(); editor.escape(); }}>
    <form className="upstream-dialog-panel" noValidate onSubmit={(event) => { event.preventDefault(); editor.submit(); }}
      onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); editor.submit(); } }}>
      <div className="modal-head upstream-modal-head">
        <div><span className="ue-eyebrow">{title}</span><h2 id="ue-title">{form.name.trim() || "新渠道"}</h2><p>{upstream?.archived ? "已归档，恢复时回到归档前的启用状态。" : "配置连接、模型与流量，保存后统一生效。"}</p></div>
        <div className="modal-head-actions"><label className="ue-enabled"><input type="checkbox" role="switch" checked={form.enabled} disabled={busy || Boolean(upstream?.archived)} onChange={(event) => editor.set("enabled", event.currentTarget.checked)} />启用</label><button type="button" className="secondary ghost icon-close" disabled={busy} aria-label="关闭渠道编辑" title="关闭" onClick={editor.close}><svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4L4 12" /></svg></button></div>
      </div>
      <div className="ue-tabs" role="tablist" aria-label="渠道配置">
        {tabs.map(({ id, label }, index) => {
          const changed = changes.some((change) => change.tab === id);
          const invalid = Object.keys(errors).some((field) => UPSTREAM_FIELD_TABS[field as keyof typeof UPSTREAM_FIELD_TABS] === id);
          return <button key={id} id={`ue-tab-${id}`} type="button" role="tab" className={["ue-tab", changed && "has-change", invalid && "has-error"].filter(Boolean).join(" ")} aria-controls={`ue-panel-${id}`} aria-selected={editor.tab === id} tabIndex={editor.tab === id ? 0 : -1}
            title={invalid ? "本页有待修正的配置" : changed ? "本页有未保存修改" : undefined}
            onClick={() => editor.selectTab(id)} onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault(); editor.selectTab(tabs[next].id, true);
            }}>{label}{id === "models" ? <span className="ue-count">{form.modelNames.length}</span> : null}{invalid || changed ? <span className="ue-sr-only">{invalid ? "有待修正的配置" : "有未保存修改"}</span> : null}</button>;
        })}
      </div>
      <div className="upstream-dialog-body" ref={editor.bodyRef} onPointerDown={() => editor.hideReview()}>
        <section id="ue-panel-connection" role="tabpanel" aria-labelledby="ue-tab-connection" hidden={editor.tab !== "connection"} key={`connection-${editor.session}`}>
          <UpstreamConnectionPanel {...panelProps} upstreamId={upstream?.id ?? 0} onKeys={editor.setKeys} />
        </section>
        <section id="ue-panel-models" role="tabpanel" aria-labelledby="ue-tab-models" hidden={editor.tab !== "models"} key={`models-${editor.session}`}>
          <div hidden={editor.workspace}><UpstreamModelsPanel {...panelProps} onManage={editor.manageModels} /></div>
          <UpstreamModelsWorkspace active={editor.workspace} names={form.modelNames} knownNames={editor.knownNames} catalog={editor.catalog} stale={editor.stale}
            fetching={editor.fetching} fetchError={editor.fetchError} notice={editor.notice} busy={busy} manual={form.manual} manualError={errors.manual}
            onBack={editor.backToRules} onFetch={() => void editor.fetchCatalog()} onManual={(value) => editor.set("manual", value)} onAdd={editor.addManual}
            onChange={(names) => editor.set("modelNames", names)} />
        </section>
        <section id="ue-panel-traffic" role="tabpanel" aria-labelledby="ue-tab-traffic" hidden={editor.tab !== "traffic"} key={`traffic-${editor.session}`}>
          <UpstreamTrafficPanel {...panelProps} groups={groups} />
        </section>
      </div>
      <div className="modal-footer ue-footer">
        {editor.review && changes.length ? <section id="ue-change-panel" className="ue-change-panel" aria-labelledby="ue-change-title"><div className="ue-section-head"><h3 id="ue-change-title">本次修改 · {changes.length} 项</h3><button type="button" className="ghost small" aria-label="关闭变更摘要" onClick={editor.hideReview}>×</button></div>{changes.map((change) => <div className="ue-change" key={change.field}><strong>{change.label}</strong><p><span>{change.before}</span><span aria-hidden="true"> → </span><span className="ue-sr-only">改为</span>{change.after}</p>{change.note ? <small>{change.note}</small> : null}</div>)}</section> : null}
        <div className="ue-save-state"><span className={editor.dirty ? "has-change" : ""} role="status">{busy ? "保存中…" : editor.dirty ? `${changes.length} 项未保存修改` : "尚未修改"}</span>{editor.dirty ? <button id="ue-review-changes" type="button" className="ghost small" aria-expanded={editor.review} aria-controls="ue-change-panel" onClick={editor.toggleReview}>查看变更</button> : null}</div>
        <div className="ue-actions"><button type="button" className="secondary" disabled={busy} onClick={editor.close}>取消</button><button type="submit" className="primary" disabled={busy} title="保存渠道（Ctrl / ⌘ + Enter）" aria-keyshortcuts="Control+Enter Meta+Enter">{busy ? "保存中…" : "保存渠道"}</button></div>
      </div>
    </form>
  </dialog>;
}
