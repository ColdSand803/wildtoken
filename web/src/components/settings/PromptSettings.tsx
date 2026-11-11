import { useState } from "react";

import { createPromptTemplate, deletePromptTemplate, listPromptTemplates, updatePromptTemplate } from "../../api";
import type { PromptTemplate } from "../../types";
import { useFailure } from "../../useFailure";
import { useKeyedActions } from "../../useKeyedActions";
import { useRemoteResource } from "../../useRemoteResource";
import { useConfirm, useToast } from "../feedback";
import { LoadError } from "../LoadError";
import { PromptDialog } from "./PromptDialog";

export function PromptSettings({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const resource = useRemoteResource(listPromptTemplates, onUnauthorized);
  const templates = resource.data ?? [];
  const [editing, setEditing] = useState<{ template: PromptTemplate | null } | null>(null);
  const { pendingIds, run } = useKeyedActions<number | "save">();
  const fail = useFailure(onUnauthorized);
  const toast = useToast();
  const confirm = useConfirm();

  async function save(name: string, prompt: string) {
    const target = editing?.template;
    await run("save", async () => {
      try {
        if (target) await updatePromptTemplate(target.id, { name, prompt });
        else await createPromptTemplate({ name, prompt });
        setEditing(null);
        await resource.reload();
        toast(`Prompt「${name}」已${target ? "保存" : "创建"}。`, { tone: "ok" });
      } catch (error) {
        fail(error, { prefix: "保存失败" });
      }
    });
  }

  async function remove(template: PromptTemplate) {
    if (!await confirm({ title: "删除 Prompt？", message: `「${template.name}」将被删除。`, confirmLabel: "删除" })) return;
    await run(template.id, async () => {
      try {
        await deletePromptTemplate(template.id);
        await resource.reload();
        toast(`Prompt「${template.name}」已删除。`, { tone: "ok" });
      } catch (error) {
        fail(error, { prefix: "删除失败" });
      }
    });
  }

  return (
    <>
      <section className="settings-card">
        <div className="settings-card-head">
          <div><h3>模型测试 Prompt</h3><p>测试窗口选择的 Prompt 模板；编辑后下次测试立即生效。</p></div>
          <button type="button" className="secondary" onClick={() => setEditing({ template: null })}>新增 Prompt</button>
        </div>
        <LoadError error={resource.error} label="Prompt" onRetry={resource.reload} />
        <div className="model-test-template-list" aria-live="polite">
          {resource.loading ? <p className="settings-loading">加载 Prompt…</p>
            : resource.error && templates.length === 0 ? null
            : templates.length === 0 ? <p className="settings-loading">暂无 Prompt。</p>
            : templates.map((template) => (
              <div key={template.id} className="model-test-template-item">
                <div><strong>{template.name}</strong><p title={template.prompt}>{template.prompt}</p></div>
                <div className="model-test-template-actions">
                  <button type="button" className="secondary small" disabled={pendingIds.has(template.id)} onClick={() => setEditing({ template })}>编辑</button>
                  <button type="button" className="secondary small danger" disabled={pendingIds.has(template.id)} onClick={() => void remove(template)}>删除</button>
                </div>
              </div>
            ))}
        </div>
      </section>
      <PromptDialog open={editing !== null} template={editing?.template ?? null} busy={pendingIds.has("save")}
        onSubmit={(name, prompt) => void save(name, prompt)} onClose={() => setEditing(null)} />
    </>
  );
}
