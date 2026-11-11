import type { FormState } from "./UpstreamDialog";
import type { UpstreamErrors } from "../upstreamEditing";
import type { KeyRow } from "../keyRows";
import { KeyListEditor } from "./KeyListEditor";
import { UpstreamDisclosure, UpstreamMappingEditor } from "./UpstreamMappingEditor";

export interface UpstreamPanelProps {
  form: FormState;
  errors: UpstreamErrors;
  busy: boolean;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

function ErrorMessage({ message }: { message?: string }) {
  return message ? <span className="ue-error" role="alert">{message}</span> : null;
}

const configuredLines = (value: string) => value.split("\n").filter((line) => line.trim()).length;

export function UpstreamConnectionPanel({ form, errors, busy, set, upstreamId, onKeys }: UpstreamPanelProps & {
  upstreamId: number;
  onKeys: (update: (keys: KeyRow[]) => KeyRow[]) => void;
}) {
  return <>
    <section className="ue-section"><div className="ue-section-head"><h3>连接信息</h3></div><div className="ue-fields">
      <label className="field"><span className="field-label">渠道名称 <span className="ue-required">*</span></span><input data-ue-field="name" value={form.name} required maxLength={80} disabled={busy} autoComplete="off" placeholder="例如 OpenAI 主渠道" aria-invalid={Boolean(errors.name)} onChange={(event) => set("name", event.currentTarget.value)} /><ErrorMessage message={errors.name} /></label>
      <label className="field"><span className="field-label">Base URL <span className="ue-required">*</span></span><input data-ue-field="baseUrl" className="ue-mono" value={form.baseUrl} required disabled={busy} autoComplete="off" spellCheck={false} placeholder="https://api.openai.com 或 https://host/v1" aria-invalid={Boolean(errors.baseUrl)} onChange={(event) => set("baseUrl", event.currentTarget.value)} /><span className="field-hint">支持根地址或已包含 /v1 的地址，保留网关的挂载路径。</span><ErrorMessage message={errors.baseUrl} /></label>
    </div></section>
    <section className="ue-section" data-ue-field="keys" tabIndex={-1}><div className="ue-section-head"><h3>API Keys <span className="ue-count">{form.keys.filter((key) => key.id || key.value.trim()).length}</span></h3></div>
      <KeyListEditor upstreamId={upstreamId} rows={form.keys} onChange={onKeys} />
      <p className="field-hint ue-section-hint">启用的 Key 按顺序轮流使用。某把被上游拒绝时，先切换本渠道的下一把；没有 Key 时可通过额外请求头鉴权。</p><ErrorMessage message={errors.keys} />
    </section>
    <UpstreamDisclosure title="额外请求头" summary={form.extraHeaders.trim() ? `已配置 · ${configuredLines(form.extraHeaders)} 行` : "未配置"}>
      <label className="field"><span className="field-label">自定义 Header</span><textarea data-ue-field="extraHeaders" value={form.extraHeaders} rows={5} disabled={busy} spellCheck={false} aria-invalid={Boolean(errors.extraHeaders)} onChange={(event) => set("extraHeaders", event.currentTarget.value)} placeholder={"User-Agent: WildToken/1.0\nX-Tenant: acme"} /><span className="field-hint">每行一条“名称: 值”。同名 Header 会覆盖原值，包括 API Key 生成的认证头。</span><ErrorMessage message={errors.extraHeaders} /></label>
      <details className="ue-format-help"><summary>格式说明</summary><p className="field-hint">兼容 JSON 对象；以 # 或 // 开头的行忽略。名称不区分大小写，不允许重复。Host、Content-Length 等传输头与内部路由头不可覆盖。</p></details>
    </UpstreamDisclosure>
  </>;
}

export function UpstreamModelsPanel({ form, errors, busy, set, onManage }: UpstreamPanelProps & { onManage: () => void }) {
  const prefixes = form.modelPrefixes.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean);
  return <>
    <section className="ue-section"><div className="ue-section-head"><div><h3>模型范围</h3><p className="field-hint">已选 <strong>{form.modelNames.length}</strong> 个精确模型</p></div><button id="ue-manage-models" type="button" className="secondary" onClick={onManage}>管理模型 →</button></div>
      <div className="ue-model-preview" role="group" aria-label="已选模型预览">{form.modelNames.length ? <>{form.modelNames.slice(0, 6).map((name) => <span className="ue-preview-chip" title={name} key={name}>{name}</span>)}{form.modelNames.length > 6 ? <span className="ue-preview-more">+{form.modelNames.length - 6}</span> : null}</> : <span className="field-hint">未配置精确模型，可在管理模型中拉取或手动添加。</span>}</div>
      <p className={form.manual.trim() ? "ue-warning" : "field-hint"}>{form.manual.trim() ? "有待处理的模型输入；保存时一并校验，也可进入管理模型继续编辑。" : "这里只预览前 6 项。搜索、选择与批量操作在“管理模型”中完成。"}</p>
    </section>
    <UpstreamMappingEditor value={form.modelMappings} onChange={(value) => set("modelMappings", value)} error={errors.modelMappings} disabled={busy} />
    <UpstreamDisclosure title="前缀匹配" summary={prefixes.length ? `${prefixes.length} 条 · ${prefixes.join(", ")}` : "未配置"}>
      <label className="field"><span className="field-label">模型名前缀</span><input data-ue-field="modelPrefixes" value={form.modelPrefixes} disabled={busy} spellCheck={false} placeholder="gpt-,claude-" onChange={(event) => set("modelPrefixes", event.currentTarget.value)} /><span className="field-hint">多个前缀用逗号分隔。精确规则未命中时匹配前缀；前缀不会展开为模型列表。</span><ErrorMessage message={errors.modelPrefixes} /></label>
    </UpstreamDisclosure>
    <UpstreamDisclosure title="思考强度映射" summary={form.effortMappings.trim() ? `已配置 · ${configuredLines(form.effortMappings)} 条` : "未配置"}>
      <label className="field"><span className="field-label">请求强度 → 上游强度</span><textarea data-ue-field="effortMappings" rows={3} disabled={busy} spellCheck={false} value={form.effortMappings} aria-invalid={Boolean(errors.effortMappings)} placeholder={"max => xhigh\nxhigh => high"} onChange={(event) => set("effortMappings", event.currentTarget.value)} /><span className="field-hint">每行一条映射，未列出的强度原样转发。</span><ErrorMessage message={errors.effortMappings} /></label>
    </UpstreamDisclosure>
  </>;
}

export function UpstreamTrafficPanel({ form, errors, busy, set, groups }: UpstreamPanelProps & { groups: Array<{ id: number; name: string }> }) {
  return <>
    <section className="ue-section"><div className="ue-section-head"><div><h3>可访问分组</h3><p className="field-hint">只有共享分组的令牌，才能路由到这个渠道。</p></div></div>
      <div className="ue-groups" role="group" aria-label="渠道分组">{groups.map((group) => <label className="ue-group" key={group.id}><input type="checkbox" disabled={busy} checked={form.groupIds.includes(group.id)} onChange={(event) => set("groupIds", event.currentTarget.checked ? [...form.groupIds, group.id] : form.groupIds.filter((id) => id !== group.id))} />{group.name}</label>)}</div>
      <p className="field-hint ue-section-hint">{form.groupIds.length ? "可以加入多个分组；不选时归入 default。" : "当前未选分组，保存时将归入 default。"}</p>
    </section>
    <section className="ue-section"><div className="ue-section-head"><h3>路由调度</h3></div>
      <label className="field ue-number"><span className="field-label">优先级</span><input data-ue-field="priority" type="number" min={0} max={100000} step={1} value={form.priority} disabled={busy} aria-invalid={Boolean(errors.priority)} onChange={(event) => set("priority", event.currentTarget.value)} /><ErrorMessage message={errors.priority} /></label>
      <p className="field-hint ue-section-hint">数值越大越优先，不同优先级的渠道不会混合分流。</p>
      <fieldset className="ue-weight-options"><legend className="field-label">权重模式</legend><div>
        <label><input type="radio" name="upstream-weight-mode" checked={form.fixedWeight} disabled={busy} onChange={() => set("fixedWeight", true)} /><span><strong>固定权重</strong><small>始终按设定的权重参与分流。</small></span></label>
        <label><input type="radio" name="upstream-weight-mode" checked={!form.fixedWeight} disabled={busy} onChange={() => set("fixedWeight", false)} /><span><strong>随健康状态调整</strong><small>失败时降低权重，恢复后逐步回升。</small></span></label>
      </div></fieldset>
      <label className="field ue-number"><span className="field-label">{form.fixedWeight ? "路由权重" : "权重上限"}</span><input data-ue-field="weight" type="number" min={0} max={10000} step={1} value={form.weight} disabled={busy} aria-invalid={Boolean(errors.weight)} onChange={(event) => set("weight", event.currentTarget.value)} /><ErrorMessage message={errors.weight} /></label>
      <p className="field-hint ue-section-hint">{form.fixedWeight ? "同一优先级内按权重比例分流，权重不是百分比。" : "有效权重 = 权重上限 × 运行时健康分。这里只设置上限。"}</p>
      {form.weight.trim() && Number(form.weight) === 0 ? <p className="ue-warning ue-section-hint">权重为 0，不参与池内路由。</p> : null}
    </section>
    <section className="ue-section"><div className="ue-section-head"><h3>请求限制</h3></div>
      <label className="field ue-number"><span className="field-label">上游超时（秒）</span><input data-ue-field="timeoutSeconds" type="number" min={0} max={3600} step="any" placeholder="跟随全局默认" value={form.timeoutSeconds} disabled={busy} aria-invalid={Boolean(errors.timeoutSeconds)} onChange={(event) => set("timeoutSeconds", event.currentTarget.value)} /><span className="field-hint">留空或填 0，跟随设置页的默认上游超时。</span><ErrorMessage message={errors.timeoutSeconds} /></label>
      <UpstreamDisclosure title="渠道限速" summary={form.rateLimit.trim() || "不限速"}>
        <label className="field ue-number"><span className="field-label">请求次数 / 时间窗口</span><input data-ue-field="rateLimit" value={form.rateLimit} disabled={busy} maxLength={24} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.rateLimit)} onChange={(event) => set("rateLimit", event.currentTarget.value)} placeholder="如 100/m、1000/h、50/10s" /><span className="field-hint">留空不限速。支持 s / m / h / d，达到限制后路由会暂时跳过此渠道。</span><ErrorMessage message={errors.rateLimit} /></label>
      </UpstreamDisclosure>
    </section>
  </>;
}
