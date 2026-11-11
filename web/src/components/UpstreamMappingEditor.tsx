import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { joinMappingLines, parseMappingLines } from "../mappingLines";

interface Row { id: number; from: string; to: string }

function mappingRows(value: string): Record<string, string> {
  const seen = new Set<string>();
  for (const [index, line] of value.split("\n").entries()) {
    if (!line.trim()) continue;
    if (line.includes("=>")) {
      const sides = line.split("=>");
      if (sides.length !== 2 || sides.some((part) => !part.trim())) throw new Error(`第 ${index + 1} 行需要完整的“请求模型名 => 上游模型名”。`);
    }
    const pairs = Object.entries(parseMappingLines(line, "模型映射"));
    if (!pairs.length) throw new Error(`第 ${index + 1} 行需要填写两侧名称。`);
    for (const [from] of pairs) {
      if (seen.has(from)) throw new Error(`请求模型名“${from}”重复，请只保留一条。`);
      seen.add(from);
    }
  }
  return parseMappingLines(value, "模型映射");
}

export function UpstreamMappingEditor({ value, onChange, error, disabled }: { value: string; onChange: (value: string) => void; error?: string; disabled: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [bulk, setBulk] = useState(false);
  const [localError, setLocalError] = useState("");
  const [version, setVersion] = useState(0);
  const [lastText, setLastText] = useState(value);

  useEffect(() => {
    if (value === lastText && rows.length) return;
    try {
      const parsed = mappingRows(value);
      setRows(Object.entries(parsed).map(([from, to], index) => ({ id: index + 1, from, to })));
      setLocalError("");
    } catch { setBulk(true); }
    setLastText(value);
  }, [value]);

  function update(next: Row[]) {
    const text = next.map((row) => `${row.from} => ${row.to}`).join("\n");
    setRows(next); setLastText(text); setLocalError(""); onChange(text);
  }

  function switchMode() {
    if (!bulk) { setBulk(true); return; }
    try {
      const parsed = mappingRows(value);
      setRows(Object.entries(parsed).map(([from, to], index) => ({ id: index + 1, from, to })));
      setLastText(joinMappingLines(parsed)); onChange(joinMappingLines(parsed)); setBulk(false); setLocalError("");
    } catch (problem) { setLocalError(problem instanceof Error ? problem.message : "映射格式无效。"); }
  }

  const message = error || localError;
  return <section className="ue-section" data-ue-field="modelMappings" tabIndex={-1}>
    <div className="ue-section-head"><h3>模型映射 <span className="ue-count">{rows.length}</span></h3><button type="button" className="ghost small" disabled={disabled} onClick={switchMode}>{bulk ? "返回逐行" : "批量编辑"}</button></div>
    {bulk ? <label className="field"><span className="field-label">请求模型名 → 上游模型名</span><textarea value={value} rows={5} disabled={disabled} spellCheck={false} aria-invalid={Boolean(message)} aria-describedby="ue-mapping-message" onChange={(event) => onChange(event.currentTarget.value)} placeholder={"fast => gpt-4.1-mini\nreasoning => o3"} /></label> : <>
      <div className="ue-mapping-head" aria-hidden="true"><span>请求模型名</span><span /><span>上游模型名</span><span /></div>
      <div className="ue-mapping-rows">{rows.map((row, index) => <div className="ue-mapping-row" key={`${version}-${row.id}`}>
        <label className="field"><span className="ue-mobile-label">请求模型名</span><input value={row.from} disabled={disabled} spellCheck={false} aria-label={`第 ${index + 1} 条映射的请求模型名`} onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, from: event.currentTarget.value } : item))} /></label>
        <span className="ue-map-arrow" aria-hidden="true">→</span>
        <label className="field"><span className="ue-mobile-label">上游模型名</span><input value={row.to} disabled={disabled} spellCheck={false} aria-label={`第 ${index + 1} 条映射的上游模型名`} onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, to: event.currentTarget.value } : item))} /></label>
        <button className="ghost small" type="button" disabled={disabled} aria-label={`删除第 ${index + 1} 条模型映射`} onClick={() => update(rows.filter((item) => item.id !== row.id))}>×</button>
      </div>)}</div>
      <button type="button" className="ghost small ue-add-mapping" disabled={disabled} onClick={() => { if (!rows.length) setVersion((n) => n + 1); update([...rows, { id: Math.max(0, ...rows.map((row) => row.id)) + 1, from: "", to: "" }]); }}>＋ 添加映射</button>
    </>}
    <p id="ue-mapping-message" className={message ? "ue-error" : "field-hint"}>{message || "命中请求模型名后，替换为右侧的上游模型名。"}</p>
  </section>;
}

export function UpstreamDisclosure({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return <details className="ue-disclosure"><summary><span>{title}</span><span className="ue-disclosure-value">{summary}<span aria-hidden="true">›</span></span></summary><div className="ue-disclosure-body">{children}</div></details>;
}
