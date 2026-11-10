import type { ReactNode } from "react";

import { isQuickImportUrl, maskQuickImportKey, quickImportUrlLabel } from "../quickImport";
import type { QuickImportController } from "../useQuickImport";
import { ModelChecklist } from "./ModelChecklist";

function Icon({ name }: { name: "arrow" | "eye" | "info" | "shield" }) {
  return <svg className="qi-icon" viewBox="0 0 24 24" aria-hidden="true">
    {name === "arrow" ? <path d="M4 12h16m-6-6 6 6-6 6" /> : null}
    {name === "eye" ? <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></> : null}
    {name === "info" ? <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></> : null}
    {name === "shield" ? <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6" /> : null}
  </svg>;
}

function Badge({ children, tone }: { children: ReactNode; tone?: "warning" | "ok" }) {
  return <span className={`qi-badge${tone ? ` qi-badge--${tone}` : ""}`}>{children}</span>;
}

export function QuickImportActions({ editor }: { editor: QuickImportController }) {
  // 什么都没填时按钮已是禁用，不必再亮一条警告。
  const problem = editor.pristine ? "" : editor.submitProblem;

  return <>
    <p className={["qi-footer-note", problem && "has-warning"].filter(Boolean).join(" ")} role="status">
      <Icon name="shield" />
      <span>{problem || "只填入新增表单，尚不创建渠道。"}</span>
    </p>
    <div className="qi-actions">
      <button type="button" className="secondary" onClick={editor.view === "models" ? editor.showConnection : editor.close}>
        {editor.view === "models" ? "返回连接" : "关闭"}
      </button>
      <button type="button" className="primary" disabled={Boolean(editor.submitProblem)} onClick={editor.submit}>
        继续配置<Icon name="arrow" />
      </button>
    </div>
  </>;
}

function SourceInput({ editor }: { editor: QuickImportController }) {
  const { form, candidates, rawChanged, parseError } = editor;
  const message = parseError || (rawChanged ? "原文有修改，识别结果暂保留上次内容。请重新识别后继续。"
    : form.connectionManual ? "结果已由你手动确认；重新识别会重填地址和 Key。"
    : editor.parsed ? `识别到 ${candidates.urls.length} 个地址、${candidates.keys.length} 把 Key。${candidates.urls.length > 1 || candidates.keys.length > 1 ? "请在识别结果中确认候选。" : "结果可修改，尚未检查连接可用性。"}`
    : "粘贴后自动识别，也可直接填写连接字段。不执行原文中的命令。");
  return <section className="qi-source" aria-labelledby="quick-import-source-title">
    <div className="qi-section-head">
      <h3 id="quick-import-source-title">粘贴连接信息</h3>
      {parseError || rawChanged || editor.parsed ? <Badge tone={parseError || rawChanged ? "warning" : "ok"}>
        {parseError ? "需要处理" : rawChanged ? "原文有更新" : "已识别"}
      </Badge> : null}
    </div>
    <textarea id="quick-import-source" rows={8} spellCheck={false} value={editor.raw} hidden={editor.rawHidden}
      aria-label="原始连接文本" aria-describedby="quick-import-source-note"
      placeholder={"接口地址：https://api.example.com/v1\nAPI Key：YOUR_API_KEY\n\n也支持 cURL 或包含连接信息的配置文本。"}
      onChange={(event) => editor.writeRaw(event.currentTarget.value)} onPaste={editor.paste} />
    <div className="qi-source-mask" hidden={!editor.rawHidden}>
      <Icon name="shield" /><span>原文可能包含密钥，已隐藏。</span>
      <small>{editor.raw.length} 个字符；显示后可继续编辑。</small>
    </div>
    <div className="qi-source-actions">
      <p id="quick-import-source-note" className={["qi-source-note", parseError && "has-error"].filter(Boolean).join(" ")} role="status">{message}</p>
      <button type="button" className="secondary" disabled={!editor.raw.trim() && !rawChanged}
        title="重新填充地址和 Key，保留手动命名" onClick={() => editor.parseRaw()}>
        {editor.parsed ? "重新识别" : "识别内容"}<Icon name="arrow" />
      </button>
    </div>
    <div className="qi-actions">
      <button type="button" className="ghost small" onClick={editor.toggleRaw} disabled={!editor.raw}>
        {editor.rawHidden ? "显示原文" : "隐藏原文"}
      </button>
      <button type="button" className="ghost small" onClick={editor.clear}>清空重来</button>
    </div>
    <details className="qi-format-help">
      <summary>支持的文本格式</summary>
      <p>接口说明、cURL、JSON 中的地址与密钥均可识别。占位符需要替换，多个候选需自行确认。</p>
      <pre>{"Base URL: https://api.example.com/proxy/v1\nAPI Key: YOUR_API_KEY"}</pre>
    </details>
  </section>;
}
function ConnectionFields({ editor }: { editor: QuickImportController }) {
  const { form, candidates } = editor;
  const urlPending = form.urlChoice === "pending";
  const keyPending = form.keyChoice === "pending";
  const urlInvalid = form.baseUrl.trim() !== "" && !isQuickImportUrl(form.baseUrl);
  const selectedUrl = /^\d+$/.test(form.urlChoice) ? candidates.urls[Number(form.urlChoice)] : undefined;
  return <section className="qi-result" aria-labelledby="quick-import-result-title">
    <div className="qi-section-head">
      <h3 id="quick-import-result-title">识别结果</h3>
      {editor.pristine ? null : <Badge tone={!editor.submitProblem ? "ok" : undefined}>{editor.submitProblem ? "待完善" : "可继续"}</Badge>}
    </div>
    <p className="qi-result-note">识别只判断文本格式，不代表地址或密钥可用。</p>
    <div className="qi-fields">
      <label className="field">
        <span className="qi-label-row"><span className="field-label">渠道名称 <span className="qi-required">*</span></span>{form.name ? <Badge>{form.nameManual ? "手动填写" : candidates.name ? "原文名称" : "自动建议"}</Badge> : null}</span>
        <input id="quick-import-name" required value={form.name} maxLength={80} autoComplete="off" placeholder="选择地址后自动建议，也可自行命名" onChange={(event) => editor.updateField("name", event.currentTarget.value)} />
      </label>
      <div className="field">
        <div className="qi-label-row"><label className="field-label" htmlFor="quick-import-url">Base URL <span className="qi-required">*</span></label><span className="qi-label-side">
          {candidates.urls.length > 1 && !urlPending ? <button type="button" className="ghost small" onClick={() => editor.chooseUrl("pending")}>重选（共 {candidates.urls.length} 个）</button> : null}
          {urlPending || form.baseUrl ? <Badge tone={urlPending ? "warning" : undefined}>{urlPending ? "待选择" : form.urlChoice === "manual" ? "手动填写" : "已识别"}</Badge> : null}
        </span></div>
        {urlPending ? <div className="qi-candidates">
          <label htmlFor="quick-import-url-choice">检测到多个地址，请确认接口地址</label>
          <select id="quick-import-url-choice" value={form.urlChoice} onChange={(event) => editor.chooseUrl(event.currentTarget.value)}>
            <option value="pending">请选择一个接口地址</option>
            {candidates.urls.map((candidate, index) => <option key={index} value={String(index)}>
              {index === 0 && candidate.score > candidates.urls[1].score ? "优先候选 · " : ""}{candidate.label}
            </option>)}
            <option value="manual">手动填写地址</option>
          </select>
        </div> : null}
        <input id="quick-import-url" type="url" required className="qi-mono" value={form.baseUrl} autoComplete="off" spellCheck={false}
          aria-invalid={urlInvalid || undefined} aria-describedby="quick-import-url-note" placeholder="https://api.example.com/v1"
          onChange={(event) => editor.updateField("baseUrl", event.currentTarget.value)} />
        <p id="quick-import-url-note" className={`field-hint${urlInvalid ? " field-hint-error" : ""}`}>
          {urlInvalid ? "需要完整的 http:// 或 https:// 地址。" : selectedUrl?.trimmedEndpoint ? "已从请求地址提取 Base URL，保留了网关路径。" : "保留地址中的路径。候选排序不代表连接可用性。"}
        </p>
      </div>
      <div className="field">
        <div className="qi-label-row"><label className="field-label" htmlFor="quick-import-apikey">API Key <span className="qi-optional">可选</span></label><span className="qi-label-side">
          {candidates.keys.length > 1 && !keyPending ? <button type="button" className="ghost small" onClick={() => editor.chooseKey("pending")}>重选（共 {candidates.keys.length} 把）</button> : null}
          {keyPending || form.apiKey ? <Badge tone={keyPending ? "warning" : undefined}>{keyPending ? "待确认" : form.keyChoice === "manual" ? "手动填写" : "已识别"}</Badge> : null}
        </span></div>
        {keyPending ? <div className="qi-candidates">
          <label htmlFor="quick-import-key-choice">检测到多把 Key，请选择，不自动取最长的一把</label>
          <select id="quick-import-key-choice" value={form.keyChoice} onChange={(event) => editor.chooseKey(event.currentTarget.value)}>
            <option value="pending">请选择一把 Key</option>
            {candidates.keys.map((candidate, index) => <option key={index} value={String(index)}>Key {index + 1} · 第 {candidate.line} 行 · {maskQuickImportKey(candidate.value)}</option>)}
            <option value="none">暂不提供 Key</option><option value="manual">手动填写 Key</option>
          </select>
        </div> : null}
        <div className="field-with-action">
          <input id="quick-import-apikey" type={editor.showKey ? "text" : "password"} value={form.apiKey} autoComplete="off" spellCheck={false}
            placeholder="可填写，也可暂不提供" aria-describedby="quick-import-key-note" onChange={(event) => editor.updateField("apiKey", event.currentTarget.value)} />
          <button type="button" className="secondary field-action" disabled={!form.apiKey} aria-label={editor.showKey ? "隐藏密钥" : "显示密钥"} aria-pressed={editor.showKey} onClick={editor.toggleKey}><Icon name="eye" /></button>
        </div>
        <p id="quick-import-key-note" className="field-hint">{keyPending ? "请确认要使用的 Key，或明确暂不提供。" : "本次输入不会写入网址或浏览器存储；可在新增表单中补充鉴权。"}</p>
      </div>
    </div>
    {candidates.urls.length > 1 || candidates.keys.length > 1 ? <div className="qi-notice qi-notice--warning"><Icon name="info" /><p>一次只生成一条渠道草稿。地址与 Key 不自动配对，请确认属于同一服务。</p></div> : null}
  </section>;
}
function ModelSummary({ editor }: { editor: QuickImportController }) {
  const { preview, pulling, stale, pullError } = editor;
  let title = "可以先不选择模型";
  let description = editor.modelNote || "首次拉取默认选中返回的全部模型；也可以继续后再配置模型规则。";
  if (pulling) {
    title = "正在拉取目录…";
    description = "修改连接信息或选择暂不带入模型，会取消这次请求。";
  } else if (preview) {
    title = stale ? `已有 ${preview.picked.size} 项选择，来源已变化`
      : preview.models.length ? `已选 ${preview.picked.size} / ${preview.models.length} 个候选模型` : "上游未返回模型";
    description = `来源：${quickImportUrlLabel(preview.connection.baseUrl)} · Key ${maskQuickImportKey(preview.connection.apiKey)}`;
  }
  return <section className="qi-model-summary" aria-labelledby="quick-import-model-title">
    <div className="qi-section-head"><h3 id="quick-import-model-title">模型 <span className="qi-optional">可选</span></h3>
      {pulling || preview ? <Badge tone={stale ? "warning" : undefined}>{pulling ? "拉取中" : stale ? "目录已过期" : `本次返回 ${preview?.returned.size ?? 0} 项`}</Badge> : null}
    </div>
    <div className="qi-model-summary-row">
      <div><strong>{title}</strong><p className="field-hint">{description}</p></div>
      <div className="qi-actions">
        {preview || pulling ? <button type="button" className="ghost" onClick={editor.skipModels}>暂不带入模型</button> : null}
        {preview ? <button type="button" className="secondary" disabled={!editor.canAdjust} onClick={editor.showModels}>调整选择</button> : null}
        <button type="button" className="secondary" disabled={!editor.canPull} onClick={() => void editor.pullModels()}>
          {pulling ? "拉取中…" : preview ? "重新拉取" : "拉取模型"}
        </button>
      </div>
    </div>
    {stale ? <div className="qi-notice qi-notice--warning"><Icon name="info" /><p>地址或 Key 已改变，旧目录不会自动带入新连接。请重新拉取，或明确选择“暂不带入模型”。</p></div> : null}
    {pullError ? <p className="qi-pull-error" role="alert">拉取失败：{pullError}</p> : null}
    {preview && !stale && !pulling && (preview.picked.size === 0 || preview.returned.size === 0) ?
      <p className="field-hint qi-model-note">{preview.picked.size ? "本次目录为空，此前的候选与选择仍保留。" : "未选择精确模型不等于接收全部模型；可在新增表单中补充模型或前缀。"}</p> : null}
    <p className="field-hint qi-next-note">下一步进入新增渠道表单，确认分组、优先级和启用状态后再保存。</p>
  </section>;
}
export function QuickImportContent({ editor }: { editor: QuickImportController }) {
  return <>
    <div hidden={editor.view !== "connection"}>
      <div className="qi-grid"><SourceInput editor={editor} /><ConnectionFields editor={editor} /></div>
      <ModelSummary editor={editor} />
    </div>
    {editor.preview ? <ModelChecklist
      active={editor.view === "models"}
      title="选择带入草稿的模型"
      backLabel="连接信息"
      searchId="quick-import-model-search"
      candidates={editor.preview.models}
      selected={editor.preview.picked}
      returned={editor.preview.returned}
      resetKey={`${editor.preview.connection.baseUrl}\n${editor.preview.connection.apiKey}`}
      emptyText="上游没有返回模型。"
      onBack={editor.showConnection}
      onChange={editor.changeModels}
    /> : null}
  </>;
}
